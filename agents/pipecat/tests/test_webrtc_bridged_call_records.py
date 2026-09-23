"""WebRTC-origin transfers record the human-to-human leg as a bridged call.

After a blind transfer from a browser caller, and after ``accept_transfer`` on a
consultative one, no bot is on the telephony leg: two humans talk over the
worker's media relay. That segment must carry ``modelName:
"telephony:bridged-call"``, as it does on LiveKit, so the platform prices it as
the bridged telephony tail leg rather than as minutes on the agent's model, and
so call-hook receivers can tell it from an agent leg.

These tests run the real transfer: the agent's ``transfer`` tool, the
TransferAgent's ``accept_transfer`` tool, both sessions' pipelines and their
teardown. Only the network edges are fake: the agent-db HTTP API, the gateway's
``originate``, and the model services inside the voice pipeline.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Optional

from pipecat.frames.frames import EndFrame, Frame, StartFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from pipecat_aplisay import api_client
from pipecat_aplisay import call_session as cs
from pipecat_aplisay.call_session import CallSession

BRIDGED = "telephony:bridged-call"
AGENT_MODEL = "pipecat:openai/gpt-4o"
CLI = "+442080996945"
TARGET = "+447700900123"
CHARGEABLE_TRUNK = "trunk-public"
BROWSER_CALL_ID = "browser-call-1"


class _Passthrough(FrameProcessor):
    def __init__(self, started: Optional[asyncio.Event] = None) -> None:
        super().__init__()
        self._started = started

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if self._started is not None and isinstance(frame, StartFrame):
            self._started.set()
        await self.push_frame(frame, direction)


class _Transport:
    """A gateway transport: pass-through media processors, and the event
    registry the session wires its disconnect and greeting handlers into."""

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self._input = _Passthrough()
        self._output = _Passthrough(self.started)
        self._handlers: dict[str, list] = {}

    def input(self) -> FrameProcessor:
        return self._input

    def output(self) -> FrameProcessor:
        return self._output

    def event_handler(self, name: str) -> Callable:
        def register(fn: Callable) -> Callable:
            self._handlers.setdefault(name, []).append(fn)
            return fn

        return register

    async def disconnect(self) -> None:
        """The far end dropped: what the real transports report."""
        for fn in list(self._handlers.get("on_client_disconnected", [])):
            await fn(self)


class _GatewaySession:
    def __init__(self) -> None:
        self.transport = _Transport()

    async def hangup(self, _reason: str = "") -> None:
        await self.transport.disconnect()

    async def shutdown(self) -> None:
        await self.transport.disconnect()


class _SipGateway:
    """``originate`` returns once the target answers; here, at once."""

    def __init__(self) -> None:
        self.legs: list[_GatewaySession] = []

    async def originate(self, _params: Any, _session_params: Any) -> _GatewaySession:
        leg = _GatewaySession()
        self.legs.append(leg)
        return leg


class _AgentDb:
    """Stands in for llm-agent's /api/agent-db routes and records the call
    lifecycle: every create, start and end, in order."""

    def __init__(self) -> None:
        self.created: dict[str, dict] = {}
        self.ops: list[tuple[str, str]] = []
        self.end_reasons: dict[str, str] = {}
        self.fail_create_for_model: Optional[str] = None
        self.hold_start_of: Optional[str] = None
        self.release_start = asyncio.Event()

    async def request(self, method: str, endpoint: str, *, params=None, body=None, timeout=30.0):
        if endpoint == "/api/agent-db/outbound-authorisation":
            return {"allowed": True, "code": "allowed", "chargeable": True,
                    "trunkId": CHARGEABLE_TRUNK, "destination": TARGET}
        if endpoint == "/api/agent-db/phone-endpoints":
            return {"items": [{"number": CLI, "outbound": True, "organisationId": "org-1",
                               "aplisayId": "aplisay-trunk-1", "trunk": {"flags": {}}}]}
        if method == "POST" and endpoint == "/api/agent-db/call":
            if body["modelName"] == self.fail_create_for_model:
                raise api_client.ApiRequestError(500, {"error": "boom"}, "API request failed: 500")
            call_id = f"leg-{len(self.created) + 1}"
            self.created[call_id] = body
            self.ops.append(("create", call_id))
            return {**body, "id": call_id}
        if endpoint.startswith("/api/agent-db/call/"):
            call_id, op = endpoint.removeprefix("/api/agent-db/call/").split("/")
            if op == "start" and call_id == self.hold_start_of:
                await self.release_start.wait()
            self.ops.append((op, call_id))
            if op == "end":
                self.end_reasons[call_id] = body.get("reason")
            return {}
        return {}

    def lifecycle(self, call_id: str) -> list[str]:
        return [op for op, cid in self.ops if cid == call_id]

    def created_with(self, model_name: str) -> list[str]:
        return [cid for cid, body in self.created.items() if body["modelName"] == model_name]


def _record_pipelines(monkeypatch) -> list[dict]:
    """Build each session's pipeline without model services: transport input,
    the relay tap and injector when present, transport output. Records the
    tools each session's model would have been given."""
    builds: list[dict] = []

    async def build_voice_session(*, transport, tools, relay_endpoint, **_kwargs):
        relay = [relay_endpoint.tap, relay_endpoint.inject] if relay_endpoint is not None else []
        pipeline = Pipeline([transport.input(), *relay, transport.output()])
        task = PipelineTask(pipeline, params=PipelineParams(), idle_timeout_secs=None)
        builds.append({"tools": {t["schema"]["name"]: t for t in tools}})
        return task, None, None, None

    monkeypatch.setattr(cs, "build_voice_session", build_voice_session)
    return builds


def _install(monkeypatch) -> tuple[_AgentDb, list[dict]]:
    db = _AgentDb()
    monkeypatch.setattr(api_client, "_request", db.request)
    monkeypatch.setenv("APLISAY_OUTBOUND_TRUNK_ID", CHARGEABLE_TRUNK)
    return db, _record_pipelines(monkeypatch)


def _static(value: str) -> dict:
    return {"type": "string", "source": "static", "from": value}


def _browser_session(operation: str) -> CallSession:
    agent = {
        "id": "agent-1",
        "userId": "user-1",
        "organisationId": "org-1",
        "modelName": AGENT_MODEL,
        "prompt": "You answer calls for the surgery.",
        "options": {},
        "functions": [
            {
                "name": "transfer",
                "description": "Transfer the caller to the practice manager.",
                "implementation": "builtin",
                "platform": "transfer",
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "number": _static(TARGET),
                        "callerId": _static(CLI),
                        "operation": _static(operation),
                    },
                },
            }
        ],
    }
    call = api_client.CallRecord(
        id=BROWSER_CALL_ID, userId="user-1", organisationId="org-1",
        instanceId="inst-1", agentId="agent-1",
    )
    return CallSession(
        session_id="webrtc-session-1",
        agent=agent,
        instance={"id": "inst-1", "streamLog": False},
        sip_gateway=_SipGateway(),  # type: ignore[arg-type]
        gateway_session=_GatewaySession(),  # type: ignore[arg-type]
        call=call,
        is_webrtc_origin=True,
    )


async def _until(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


async def _start_browser_call(browser: CallSession) -> asyncio.Task:
    """What the worker's /webrtc/offer path does: prepare, then run."""
    task, max_secs = await browser.prepare_run(
        browser.agent, browser.agent["modelName"], browser.agent["prompt"]
    )
    run = asyncio.create_task(browser.run_prepared(task, max_secs))
    await asyncio.wait_for(browser.gateway_session.transport.started.wait(), 5)
    return run


async def _hang_up(browser: CallSession, run: asyncio.Task) -> None:
    """Drop every leg the way the gateways do. After a failed assertion this
    ends the pipelines, which asyncio.run's cleanup cannot do on its own."""
    if run.done() and not browser._background_tasks:
        return
    for leg in browser.sip_gateway.legs:
        await leg.transport.disconnect()
    if browser._relay_leg is not None:
        await browser._relay_leg.task.cancel()
    await browser.gateway_session.transport.disconnect()
    await asyncio.wait({run, *browser._background_tasks}, timeout=5)


def _run_call(browser: CallSession, body: Callable[[], Awaitable[None]]) -> None:
    """Run ``body`` on a live browser call, then let the call finish."""

    async def scenario() -> None:
        run = await _start_browser_call(browser)
        try:
            await body()
            await asyncio.wait_for(run, 5)
            await asyncio.wait_for(asyncio.gather(*list(browser._background_tasks)), 5)
        finally:
            await _hang_up(browser, run)

    asyncio.run(asyncio.wait_for(scenario(), 20))


async def _consult_leg_up(browser: CallSession, builds: list[dict]) -> CallSession:
    """Wait for the TransferAgent's pipeline to run on the answered consult leg."""
    await asyncio.wait_for(browser._webrtc_bg_task, 5)
    await _until(lambda: len(builds) == 2)
    leg = browser.sip_gateway.legs[0]
    await asyncio.wait_for(leg.transport.started.wait(), 5)
    return browser._consult_session


def test_blind_transfer_records_the_relay_leg_as_a_bridged_call(monkeypatch):
    db, builds = _install(monkeypatch)
    browser = _browser_session("blind")

    async def body() -> None:
        await builds[0]["tools"]["transfer"]["execute"]({})
        await asyncio.wait_for(browser._webrtc_bg_task, 5)
        assert browser.transfer_state.state == "talking"
        assert browser.relay_endpoint.engaged
        # The target hangs up: the relay leg's pipeline ends, which drops the
        # browser caller too.
        await browser._relay_leg.task.queue_frame(EndFrame())

    _run_call(browser, body)

    [leg_id] = db.created
    leg = db.created[leg_id]
    assert leg["modelName"] == BRIDGED
    assert leg["metadata"]["aplisay"]["model"] == BRIDGED
    assert leg["parentId"] == BROWSER_CALL_ID
    assert (leg["callerId"], leg["calledId"]) == (CLI, TARGET)
    # Still destination-billed: the leg is carried out on our public trunk.
    assert leg["outboundTrunkId"] == CHARGEABLE_TRUNK
    assert db.lifecycle(leg_id) == ["create", "start", "end"]
    assert db.lifecycle(BROWSER_CALL_ID) == ["end"]


def test_accepted_consult_moves_the_human_segment_onto_a_bridged_call(monkeypatch):
    db, builds = _install(monkeypatch)
    browser = _browser_session("consultative")

    async def body() -> None:
        await builds[0]["tools"]["transfer"]["execute"]({})
        await _consult_leg_up(browser, builds)
        # Until the target accepts, only the consultation record exists: the
        # TransferAgent is a bot talking on the agent's model.
        [consult_id] = db.created_with(AGENT_MODEL)
        assert db.created[consult_id]["metadata"]["aplisay"]["transferConsultation"] is True
        assert db.created_with(BRIDGED) == []

        await builds[1]["tools"]["accept_transfer"]["execute"]({"reason": "Happy to take it"})
        assert browser.relay_endpoint.engaged
        [bridged_id] = db.created_with(BRIDGED)
        # The consultation ends before its successor starts, so the leg never
        # holds two concurrency slots.
        assert db.ops == [
            ("create", consult_id), ("start", consult_id),
            ("create", bridged_id), ("end", consult_id), ("start", bridged_id),
        ]
        assert bridged_id in db.end_reasons[consult_id]
        # The target hangs up.
        await browser.sip_gateway.legs[0].transport.disconnect()

    _run_call(browser, body)

    [consult_id] = db.created_with(AGENT_MODEL)
    [bridged_id] = db.created_with(BRIDGED)
    bridged = db.created[bridged_id]
    assert bridged["metadata"]["aplisay"]["model"] == BRIDGED
    assert "transferConsultation" not in bridged["metadata"]["aplisay"]
    assert bridged["parentId"] == BROWSER_CALL_ID
    assert (bridged["callerId"], bridged["calledId"]) == (CLI, TARGET)
    assert bridged["outboundTrunkId"] == CHARGEABLE_TRUNK
    assert bridged["platformCallId"] == db.created[consult_id]["platformCallId"]
    # Each record ends exactly once: a second end would re-stamp endedAt and
    # bill the bridged minutes to the consultation record again.
    assert db.lifecycle(consult_id) == ["create", "start", "end"]
    assert db.lifecycle(bridged_id) == ["create", "start", "end"]
    assert db.lifecycle(BROWSER_CALL_ID) == ["end"]


def test_a_leg_that_drops_mid_hand_over_still_ends_its_bridged_record(monkeypatch):
    db, builds = _install(monkeypatch)
    browser = _browser_session("consultative")

    async def body() -> None:
        await builds[0]["tools"]["transfer"]["execute"]({})
        consult = await _consult_leg_up(browser, builds)
        db.hold_start_of = "leg-2"  # the bridged record's start is slow
        accept = asyncio.create_task(
            builds[1]["tools"]["accept_transfer"]["execute"]({"reason": "Yes"})
        )
        try:
            await _until(lambda: ("end", "leg-1") in db.ops)
            # The target hangs up while the bridged record is still starting.
            await browser.sip_gateway.legs[0].transport.disconnect()
            # Teardown has taken the unfinished hand-over and is waiting for it.
            await _until(lambda: consult._bridged_handover is None)
            assert db.lifecycle("leg-2") == ["create"]
        finally:
            db.release_start.set()
        await asyncio.wait_for(accept, 5)

    _run_call(browser, body)

    assert db.created["leg-2"]["modelName"] == BRIDGED
    assert db.lifecycle("leg-2") == ["create", "start", "end"]
    assert db.lifecycle("leg-1") == ["create", "start", "end"]


def test_consult_record_covers_the_leg_if_the_bridged_record_cannot_be_created(monkeypatch):
    db, builds = _install(monkeypatch)
    db.fail_create_for_model = BRIDGED
    browser = _browser_session("consultative")

    async def body() -> None:
        await builds[0]["tools"]["transfer"]["execute"]({})
        await _consult_leg_up(browser, builds)
        await builds[1]["tools"]["accept_transfer"]["execute"]({"reason": "Yes"})
        # The bridge is up regardless, and the consultation record stays open.
        assert browser.relay_endpoint.engaged
        assert browser.transfer_state.state == "none"
        assert db.lifecycle("leg-1") == ["create", "start"]
        await browser.sip_gateway.legs[0].transport.disconnect()

    _run_call(browser, body)

    assert list(db.created) == ["leg-1"]
    assert db.lifecycle("leg-1") == ["create", "start", "end"]
