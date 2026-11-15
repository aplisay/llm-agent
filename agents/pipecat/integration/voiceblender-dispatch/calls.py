"""The worker behind call control, against a real voiceblender.

Run by run.sh on the host, once the two engines of compose.yml are up:

- the real worker, in this process, with ``VOICEBLENDER_INBOUND=dispatch``;
- a stand-in for the API: the agent-db routes the worker calls;
- a stand-in for call control: it listens to the engine's events and sends
  the worker the hand-over request;
- ``far``, a second voiceblender, as the far end of each call.

The agent's own pipeline is replaced by one that plays the caller's audio
back, so no model and no key is needed. Everything else is the worker's code.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
import wave

ENGINE = f"http://127.0.0.1:{os.environ.get('ENGINE_API_PORT', '18080')}"
FAR = f"http://127.0.0.1:{os.environ.get('FAR_API_PORT', '18081')}"
ENGINE_SIP = "172.31.78.10:5060"
FAR_SIP = "172.31.78.20:5060"
WORKER_PORT = int(os.environ.get("WORKER_PORT", "18082"))
API_PORT = int(os.environ.get("API_PORT", "18083"))
WORKER = f"http://127.0.0.1:{WORKER_PORT}"
RECORDINGS = os.environ["RECORDINGS_DIR"]
TOKEN = "integration-dispatch-token"
APP_ID = "aplisay-pipecat"
TRUNK = "tk-integration"
NUMBER = "+442079460001"
CALLER = "+447700900123"
ORG, INSTANCE_ID, AGENT_ID = "org-1", str(uuid.uuid4()), str(uuid.uuid4())

# Before the worker is imported: it reads some of these at import.
os.environ.update(
    SIP_GATEWAY="voiceblender",
    VOICEBLENDER_INBOUND="dispatch",
    VOICEBLENDER_BASE_URL=ENGINE,
    VOICEBLENDER_WORKER_WS_BASE=f"ws://host.docker.internal:{WORKER_PORT}",
    VOICEBLENDER_APP_ID=APP_ID,
    PIPECAT_DISPATCH_TOKEN=TOKEN,
    PIPECAT_SIP_OUTBOUND=FAR_SIP,
    SERVICE_BASE_URI=f"http://127.0.0.1:{API_PORT}",
    SHARED_API_TOKEN="integration-shared-token",
)
os.environ.pop("PIPECAT_SIP_PASSWORD", None)

import httpx  # noqa: E402
import uvicorn  # noqa: E402
import websockets  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402
from fastapi.responses import JSONResponse  # noqa: E402
from pipecat.frames.frames import Frame, InputAudioRawFrame, OutputAudioRawFrame  # noqa: E402
from pipecat.pipeline.pipeline import Pipeline  # noqa: E402
from pipecat.pipeline.runner import PipelineRunner  # noqa: E402
from pipecat.pipeline.task import PipelineParams, PipelineTask  # noqa: E402
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor  # noqa: E402

from pipecat_aplisay import api_client, worker  # noqa: E402
from pipecat_aplisay.call_session import CallSession  # noqa: E402

# ---- the agent: plays the caller's audio back ----------------------------------


class _Echo(FrameProcessor):
    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            frame = OutputAudioRawFrame(
                audio=frame.audio, sample_rate=frame.sample_rate, num_channels=frame.num_channels
            )
        await self.push_frame(frame, direction)


async def _echo_run(self: CallSession, *, system_prompt: str) -> None:
    transport = self.gateway_session.transport
    task = PipelineTask(
        Pipeline([transport.input(), _Echo(), transport.output()]),
        params=PipelineParams(audio_in_sample_rate=16000, audio_out_sample_rate=16000),
    )

    @transport.event_handler("on_client_disconnected")
    async def _gone(*_args, **_kwargs) -> None:
        await task.cancel()

    try:
        await PipelineRunner(handle_sigint=False).run(task)
    finally:
        await api_client.end_call(self.call, reason="integration test call ended")


CallSession.run = _echo_run  # type: ignore[method-assign]

# ---- the API stand-in ------------------------------------------------------------

api = FastAPI()
api_seen: list[tuple[str, str, dict]] = []
INSTANCE = {
    "id": INSTANCE_ID,
    "agentId": AGENT_ID,
    "organisationId": ORG,
    "userId": "user-1",
    "metadata": {},
    "Agent": {
        "id": AGENT_ID,
        "organisationId": ORG,
        "userId": "user-1",
        "modelName": "integration:none",
        "prompt": "",
        "options": {},
    },
}


@api.get("/api/agent-db/instance")
async def _instance(instanceId: str):
    if instanceId != INSTANCE_ID:
        return JSONResponse({"error": "Instance not found"}, status_code=404)
    return INSTANCE


@api.get("/api/agent-db/phone-endpoints")
async def _endpoints(number: str = "", trunkId: str = "", id: str = ""):
    if number.lstrip("+") == NUMBER.lstrip("+") and trunkId == TRUNK:
        return {"items": [{"number": number, "instanceId": INSTANCE_ID, "trunk": {"flags": {"canRefer": True}}}]}
    return JSONResponse({"error": "Phone endpoint not found"}, status_code=404)


@api.post("/api/agent-db/call")
async def _create_call(request: Request):
    body = await request.json()
    api_seen.append(("POST", "/call", body))
    return {**body, "id": str(uuid.uuid4())}


@api.api_route("/api/agent-db/{rest:path}", methods=["GET", "POST", "PUT", "PATCH"])
async def _anything(rest: str, request: Request):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    api_seen.append((request.method, f"/{rest}", body))
    return {}


# ---- helpers ----------------------------------------------------------------------

passed: list[str] = []


def check(condition: bool, what: str) -> None:
    if not condition:
        raise AssertionError(what)
    passed.append(what)
    print(f"  ok  {what}", flush=True)


class Events:
    """One engine's event stream, kept as a list that can be waited on."""

    def __init__(self, base: str) -> None:
        self.url = base.replace("http://", "ws://") + "/v1/vsi"
        self.seen: list[dict] = []
        self._new = asyncio.Condition()
        self._task: asyncio.Task | None = None

    async def start(self) -> None:
        ready = asyncio.Event()

        async def pump() -> None:
            async with websockets.connect(self.url, max_size=None) as ws:
                ready.set()
                async for raw in ws:
                    async with self._new:
                        self.seen.append(json.loads(raw))
                        self._new.notify_all()

        self._task = asyncio.create_task(pump())
        await asyncio.wait_for(ready.wait(), 10)

    async def wait_for(self, match, what: str, timeout: float = 10.0) -> dict:
        async def find() -> dict:
            async with self._new:
                while True:
                    for event in self.seen:
                        if match(event):
                            return event
                    await self._new.wait()

        try:
            return await asyncio.wait_for(find(), timeout)
        except asyncio.TimeoutError:
            raise AssertionError(f"no event: {what}") from None

    def stop(self) -> None:
        if self._task:
            self._task.cancel()


def leg_of(event: dict) -> str:
    return event.get("leg_id") or event.get("id") or ""


async def serve(app, port: int, host: str) -> tuple[uvicorn.Server, asyncio.Task]:
    server = uvicorn.Server(uvicorn.Config(app, host=host, port=port, log_level="warning"))
    task = asyncio.create_task(server.serve())
    for _ in range(100):
        if server.started:
            return server, task
        await asyncio.sleep(0.1)
    raise RuntimeError(f"server on port {port} did not start")


async def dispatch(http: httpx.AsyncClient, body: dict, token: str = TOKEN) -> httpx.Response:
    return await http.post(
        f"{WORKER}/dispatch", json=body, headers={"authorization": f"Bearer {token}"}, timeout=60
    )


def handoff(leg_id: str, event: dict, **over) -> dict:
    """The hand-over request, as call control sends it."""
    body = {
        "kind": "inbound",
        "handoffId": f"h-{uuid.uuid4()}",
        "callId": f"cc-{uuid.uuid4()}",
        "legId": leg_id,
        "instanceId": INSTANCE_ID,
        "agentId": AGENT_ID,
        "organisationId": ORG,
        "acceptWithinMs": 2000,
        "event": {key: event.get(key) for key in ("from", "to", "from_display_name", "sip_headers")},
    }
    body.update(over)
    return body


async def leg_state(http: httpx.AsyncClient, base: str, leg_id: str) -> str:
    response = await http.get(f"{base}/v1/legs/{leg_id}")
    return response.json().get("state") if response.status_code == 200 else f"gone ({response.status_code})"


async def worker_health(http: httpx.AsyncClient) -> dict:
    return (await http.get(f"{WORKER}/healthz")).json()


async def call_in(http: httpx.AsyncClient, engine: Events) -> tuple[str, str, dict]:
    """The far end calls the number. Returns its leg, the engine's leg and the ringing event."""
    known = {leg_of(e) for e in engine.seen if e.get("type") == "leg.ringing"}
    response = await http.post(
        f"{FAR}/v1/legs",
        json={
            "type": "sip",
            "to": f"sip:{NUMBER}@{ENGINE_SIP}",
            "from": CALLER.lstrip("+"),
            "headers": {"X-Aplisay-Trunk": TRUNK},
        },
    )
    far_leg = response.json()["id"]
    ringing = await engine.wait_for(
        lambda e: e.get("type") == "leg.ringing"
        and "outbound" not in (e.get("leg_type") or "")
        and leg_of(e) not in known,
        "leg.ringing for the call in",
    )
    return far_leg, leg_of(ringing), ringing


def incoming_level(path: str) -> int:
    """Peak of the left channel of a leg recording: what the leg received."""
    with wave.open(path, "rb") as wav:
        channels, width = wav.getnchannels(), wav.getsampwidth()
        frames = wav.readframes(wav.getnframes())
    step = channels * width
    peak = 0
    for i in range(0, len(frames) - step + 1, step):
        peak = max(peak, abs(int.from_bytes(frames[i : i + width], "little", signed=True)))
    return peak


# ---- the calls ----------------------------------------------------------------------


async def a_call_in(http: httpx.AsyncClient, engine: Events, far: Events) -> None:
    print("a call in, handed over by call control", flush=True)
    far_leg, leg_id, ringing = await call_in(http, engine)
    check(ringing.get("app_id", "") != APP_ID, "the call in does not carry the worker's app id")
    check(
        (ringing.get("sip_headers") or {}).get("X-Aplisay-Trunk") == TRUNK,
        "the ringing event has the trunk header",
    )

    # Call control keeps its own mark on the leg.
    mark = {"call_control": {"state": "handing_over"}}
    await http.put(f"{ENGINE}/v1/legs/{leg_id}/custom-data", json={"custom_data": mark})

    await asyncio.sleep(1.5)
    check(await leg_state(http, ENGINE, leg_id) == "ringing", "the worker left the ringing leg alone")
    check(not [s for s in api_seen if s[1] == "/call"], "and made no call record")

    refused = await dispatch(http, handoff(leg_id, ringing, instanceId=str(uuid.uuid4())))
    check(refused.status_code == 404, "an instance that does not exist is refused with 404")
    refused = await dispatch(http, handoff(str(uuid.uuid4()), ringing))
    check(refused.status_code == 404, "a leg that is not on the engine is refused with 404")
    refused = await dispatch(http, handoff(leg_id, ringing), token="wrong")
    check(refused.status_code == 401, "a bad token is refused with 401")
    check(await leg_state(http, ENGINE, leg_id) == "ringing", "the refusals left the leg ringing")

    request = handoff(leg_id, ringing)
    accepted = await dispatch(http, request)
    check(accepted.status_code == 200 and accepted.json().get("accepted") is True, "the hand-over is accepted")
    session_id = accepted.json()["sessionId"]

    await far.wait_for(
        lambda e: e.get("type") == "leg.connected" and leg_of(e) == far_leg, "the far end is answered"
    )
    check(True, "the worker answered the leg: the far end is connected")

    for _ in range(50):
        if [s for s in api_seen if s[1] == "/call"]:
            break
        await asyncio.sleep(0.1)
    created = [s for s in api_seen if s[1] == "/call"]
    check(len(created) == 1, "the engine attached the agent: one call record was made")
    record = created[0][2]
    aplisay = record["metadata"]["aplisay"]
    check(record["instanceId"] == INSTANCE_ID and record["agentId"] == AGENT_ID, "for the instance the plan named")
    check(record["platformCallId"] == session_id, "under the session id of the reply")
    check(aplisay.get("callControlId") == request["callId"], "with call control's id for the call")
    check(aplisay.get("calledId") == ringing.get("to") and aplisay.get("callerId") == ringing.get("from"), "with the caller and the number of the event")
    check((aplisay.get("sipHeaders") or {}).get("x-aplisay-trunk") == TRUNK, "and its X- headers")

    again = await dispatch(http, request)
    check((again.status_code, again.json()) == (200, accepted.json()), "a repeat of the hand-over gets the same reply")
    check(len([s for s in api_seen if s[1] == "/call"]) == 1, "and makes no second call")

    leg = (await http.get(f"{ENGINE}/v1/legs/{leg_id}")).json()
    check(leg.get("state") == "connected", "the leg is connected on the engine")
    check(leg.get("custom_data") == mark, "call control's custom data on the leg is unchanged")

    # Audio both ways: the far end plays a tone, the agent plays it back, and
    # the far end's recording of what it received is not silent.
    await http.post(f"{FAR}/v1/legs/{far_leg}/record", json={"storage": "file"})
    await http.post(f"{FAR}/v1/legs/{far_leg}/play", json={"tone": "dial", "repeat": 0})
    await asyncio.sleep(3)
    await http.delete(f"{FAR}/v1/legs/{far_leg}/record")
    done = await far.wait_for(
        lambda e: e.get("type") == "recording.finished" and leg_of(e) == far_leg, "the recording is finished"
    )
    name = os.path.basename(str(done.get("file") or done.get("path") or done.get("filename") or ""))
    path = os.path.join(RECORDINGS, name) if name else ""
    if not (path and os.path.exists(path)):
        wavs = sorted(f for f in os.listdir(RECORDINGS) if f.endswith(".wav"))
        path = os.path.join(RECORDINGS, wavs[-1]) if wavs else ""
    check(bool(path), "the far end recorded the call")
    level = incoming_level(path)
    check(level > 500, f"audio came back from the agent (peak {level})")

    await http.request("DELETE", f"{FAR}/v1/legs/{far_leg}", json={"reason": "normal_clearing"})
    await engine.wait_for(
        lambda e: e.get("type") == "leg.disconnected" and leg_of(e) == leg_id, "the engine's leg ended"
    )
    for _ in range(50):
        if [s for s in api_seen if s[1].endswith("/end")]:
            break
        await asyncio.sleep(0.1)
    check(len([s for s in api_seen if s[1].endswith("/end")]) == 1, "when the caller hangs up the call record is ended")
    for _ in range(50):
        health = await worker_health(http)
        if health["live_calls"] == 0 and sum(health["gateway_maps"].values()) == 0:
            break
        await asyncio.sleep(0.1)
    check(health["live_calls"] == 0 and sum(health["gateway_maps"].values()) == 0, "and the worker holds nothing for it")


async def a_call_call_control_keeps(http: httpx.AsyncClient, engine: Events, far: Events) -> None:
    print("a call in that call control keeps for itself", flush=True)
    calls_before = len([s for s in api_seen if s[1] == "/call"])
    far_leg, leg_id, _ = await call_in(http, engine)
    await http.post(f"{ENGINE}/v1/legs/{leg_id}/answer", json={})
    await far.wait_for(lambda e: e.get("type") == "leg.connected" and leg_of(e) == far_leg, "answered by call control")
    await asyncio.sleep(1)
    check(await leg_state(http, ENGINE, leg_id) == "connected", "the worker did not touch a call it was not handed")
    await http.request("DELETE", f"{ENGINE}/v1/legs/{leg_id}", json={})
    await engine.wait_for(lambda e: e.get("type") == "leg.disconnected" and leg_of(e) == leg_id, "the leg ended")
    await asyncio.sleep(0.5)
    health = await worker_health(http)
    check(len([s for s in api_seen if s[1] == "/call"]) == calls_before, "no call record was made for it")
    check(health["ok"] and health["live_calls"] == 0, "and the worker is healthy and idle")


async def a_call_out(http: httpx.AsyncClient, engine: Events, far: Events) -> None:
    print("a call out, placed by the worker", flush=True)
    call_id, session_id = str(uuid.uuid4()), f"out-{uuid.uuid4()}"
    known = {leg_of(e) for e in far.seen if e.get("type") == "leg.ringing"}
    placing = asyncio.create_task(
        dispatch(
            http,
            {
                "kind": "outbound",
                "sessionId": session_id,
                "callId": call_id,
                "instanceId": INSTANCE_ID,
                "callerId": NUMBER,
                "calledId": CALLER,
                "aplisayId": TRUNK,
            },
        )
    )
    ringing = await far.wait_for(
        lambda e: e.get("type") == "leg.ringing"
        and "outbound" not in (e.get("leg_type") or "")
        and leg_of(e) not in known,
        "the far end rings",
    )
    far_leg = leg_of(ringing)
    check((ringing.get("sip_headers") or {}).get("X-Aplisay-Trunk") == TRUNK, "the call out carries the trunk header")

    made = await engine.wait_for(
        lambda e: e.get("type") == "leg.ringing" and "outbound" in (e.get("leg_type") or ""),
        "the engine's outbound leg",
    )
    leg_id = leg_of(made)
    check(made.get("app_id") == APP_ID, "the leg the worker made carries its app id")

    await http.post(f"{FAR}/v1/legs/{far_leg}/answer", json={})
    response = await asyncio.wait_for(placing, 30)
    check(response.status_code == 200 and response.json().get("ok") is True, "the dispatch returns once the call is answered")
    check((await worker_health(http))["live_calls"] == 1, "the worker has one live call")
    check(await leg_state(http, ENGINE, leg_id) == "connected", "the leg is connected on the engine")

    ends_before = len([s for s in api_seen if s[1].endswith("/end")])
    await http.request("DELETE", f"{FAR}/v1/legs/{far_leg}", json={"reason": "normal_clearing"})
    await engine.wait_for(lambda e: e.get("type") == "leg.disconnected" and leg_of(e) == leg_id, "the leg ended")
    for _ in range(50):
        if len([s for s in api_seen if s[1].endswith("/end")]) > ends_before:
            break
        await asyncio.sleep(0.1)
    ended = [s for s in api_seen if s[1].endswith("/end")][ends_before:]
    check(len(ended) == 1 and ended[0][1] == f"/call/{call_id}/end", "when the far end hangs up the call record is ended")
    for _ in range(50):
        health = await worker_health(http)
        if health["live_calls"] == 0:
            break
        await asyncio.sleep(0.1)
    check(health["live_calls"] == 0, "and the worker is idle")


async def main() -> int:
    api_server, api_task = await serve(api, API_PORT, "127.0.0.1")
    # Every address: the engine reaches the worker from its container.
    worker_server, worker_task = await serve(worker.app, WORKER_PORT, "0.0.0.0")
    engine, far = Events(ENGINE), Events(FAR)
    await engine.start()
    await far.start()
    failed = None
    try:
        async with httpx.AsyncClient(timeout=15) as http:
            check(worker.app.state.sip_gateway.inbound_mode == "dispatch", "the worker runs in dispatch mode")
            check("app_id" not in worker.app.state.sip_gateway._vsi_url(), "and listens to the engine with no app id filter")
            await a_call_in(http, engine, far)
            await a_call_call_control_keeps(http, engine, far)
            await a_call_out(http, engine, far)
    except AssertionError as e:
        failed = str(e)
    finally:
        engine.stop()
        far.stop()
        worker_server.should_exit = True
        api_server.should_exit = True
        await asyncio.wait([worker_task, api_task], timeout=15)
    if failed:
        print(f"FAILED: {failed}", flush=True)
        return 1
    print(f"{len(passed)} checks passed", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
