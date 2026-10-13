"""Start failures and the fallback chain (docs/agent-failover.md).

A pipeline that fails before the bot first speaks, within the start-up window,
goes to ``options.fallback`` instead of ending the call. Provider connections
happen once the pipeline runs (Ultravox makes its ``/calls`` request from the
service's ``start()``), so these failures arrive as ErrorFrames. The pipelines
here are real; only the build step and the API calls are stubbed.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional

import pytest
from pipecat.frames.frames import BotStartedSpeakingFrame, EndFrame, StartFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from pipecat_aplisay.constants import DISCONNECT_REASONS
from pipecat_aplisay.start_window import (
    DisconnectGate,
    SessionStartFailed,
    StartWindow,
    is_start_failure,
    watch_start_window,
)

CALLER_LEFT = DISCONNECT_REASONS["ORIGINAL_PARTICIPANT"]
PRIMARY = "pipecat:ultravox/ultravox-v0.7"
FALLBACK = "pipecat:openai/gpt-realtime"
SECOND_FALLBACK = "pipecat:openai/gpt-4o-mini"


class _Service(FrameProcessor):
    """Stands in for a model service that fails once the pipeline starts."""

    def __init__(
        self,
        *,
        fail: Optional[str] = None,
        speak_first: bool = False,
        on_start: Optional[Callable[[], None]] = None,
    ) -> None:
        super().__init__()
        self._fail = fail
        self._speak_first = speak_first
        self._on_start = on_start

    async def process_frame(self, frame, direction):  # noqa: ANN001
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if not isinstance(frame, StartFrame):
            return
        if self._speak_first:
            await self.push_frame(BotStartedSpeakingFrame())
            # A real failure after first speech comes later than this.
            await asyncio.sleep(0.05)
        if self._fail == "fatal":
            await self.push_error("provider refused the session", fatal=True)
        elif self._fail == "unusable":
            await self.push_error("API key rejected", force_treat_as_permanent=True)
        elif self._fail == "recoverable":
            await self.push_error("one bad chunk")
        if self._on_start is not None:
            self._on_start()


async def _run_task(task: PipelineTask, timeout: float = 5.0) -> None:
    try:
        await asyncio.wait_for(PipelineRunner(handle_sigint=False).run(task), timeout)
    finally:
        # A live PipelineTask left behind hangs asyncio.run.
        if not task.has_finished():
            await task.cancel()


# ---- The window on its own -------------------------------------------------


def test_window_records_the_first_failure_only_while_open() -> None:
    window = StartWindow()
    assert window.fail("refused") is True
    assert window.open is False
    assert window.fail("later") is False
    assert window.failure == "refused"

    closed = StartWindow()
    closed.close()
    assert closed.fail("too late") is False
    assert closed.failure is None


def test_window_closes_at_the_cap() -> None:
    now = [100.0]
    window = StartWindow(cap_secs=15.0, clock=lambda: now[0])
    now[0] = 114.9
    assert window.open is True
    now[0] = 115.0
    assert window.open is False
    assert window.fail("after the cap") is False


class _Frame:
    def __init__(self, fatal: bool = False, usable: Optional[bool] = None) -> None:
        self.fatal = fatal
        self.processor = None if usable is None else type("P", (), {"is_usable": usable})()


def test_which_error_frames_are_start_failures() -> None:
    assert is_start_failure(_Frame(fatal=True)) is True
    assert is_start_failure(_Frame(usable=False)) is True
    assert is_start_failure(_Frame(usable=True)) is False
    assert is_start_failure(_Frame()) is False


# ---- The window on a running pipeline --------------------------------------


def _watched(service: _Service) -> tuple[PipelineTask, StartWindow]:
    task = PipelineTask(Pipeline([service]))
    window = StartWindow()
    watch_start_window(task, window, task.cancel)
    return task, window


def test_a_fatal_error_at_start_fails_the_window() -> None:
    async def run() -> StartWindow:
        task, window = _watched(_Service(fail="fatal"))
        await _run_task(task)
        return window

    assert asyncio.run(run()).failure == "provider refused the session"


def test_an_unusable_processor_fails_the_window_and_ends_the_pipeline() -> None:
    # pipecat's own policy for this is to carry on with the processor dead.
    async def run() -> StartWindow:
        task, window = _watched(_Service(fail="unusable"))
        await _run_task(task)
        return window

    assert asyncio.run(run()).failure == "API key rejected"


def test_a_recoverable_error_does_not_fail_the_window() -> None:
    async def run() -> StartWindow:
        task, window = _watched(_Service(fail="recoverable"))
        await task.queue_frames([EndFrame()])
        await _run_task(task)
        return window

    window = asyncio.run(run())
    assert window.failure is None


def test_after_the_bot_speaks_a_fatal_error_is_not_a_start_failure() -> None:
    async def run() -> StartWindow:
        task, window = _watched(_Service(fail="fatal", speak_first=True))
        await _run_task(task)
        return window

    window = asyncio.run(run())
    assert window.failure is None
    assert window.open is False


# ---- DisconnectGate ----------------------------------------------------------


class _Client:
    def __init__(self) -> None:
        self.closed = 0

    async def disconnect(self) -> None:
        self.closed += 1


class _Transport:
    def __init__(self) -> None:
        self._client = _Client()


def test_gate_holds_disconnects_and_replays_each_when_released() -> None:
    async def run() -> int:
        transport = _Transport()
        client = transport._client
        gate = DisconnectGate(transport, StartWindow())
        await client.disconnect()
        await client.disconnect()
        assert client.closed == 0
        await gate.release()
        return client.closed

    assert asyncio.run(run()) == 2


def test_gate_keeps_the_socket_open_after_a_start_failure() -> None:
    async def run() -> int:
        transport = _Transport()
        window = StartWindow()
        gate = DisconnectGate(transport, window)
        await transport._client.disconnect()
        window.fail("refused")
        await transport._client.disconnect()
        await gate.release()
        return transport._client.closed

    assert asyncio.run(run()) == 0


def test_gate_passes_disconnects_through_once_the_bot_has_spoken() -> None:
    async def run() -> int:
        transport = _Transport()
        window = StartWindow()
        DisconnectGate(transport, window)
        window.close()
        await transport._client.disconnect()
        return transport._client.closed

    assert asyncio.run(run()) == 1


# ---- CallSession.run() and the fallback chain ------------------------------


class _FakeWebsocket:
    client_state = None
    application_state = None


def _ws_transport():
    from pipecat.serializers.protobuf import ProtobufFrameSerializer
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )

    return FastAPIWebsocketTransport(
        websocket=_FakeWebsocket(),
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=ProtobufFrameSerializer(),
        ),
    )


def _session(fallback: dict, transport: Any):
    from pipecat_aplisay import api_client
    from pipecat_aplisay.call_session import CallSession

    class _GatewaySession:
        def __init__(self) -> None:
            self.transfers: list = []

        async def transfer(self, request) -> None:  # noqa: ANN001
            self.transfers.append(request)

        async def shutdown(self) -> None:  # pragma: no cover
            return None

    gateway = _GatewaySession()
    gateway.transport = transport
    call = api_client.CallRecord(
        id="call-1",
        userId="user-1",
        organisationId="org-1",
        instanceId="inst-1",
        agentId="agent-1",
        persisted=False,
    )
    return CallSession(
        session_id="s1",
        agent={
            "id": "agent-1",
            "modelName": PRIMARY,
            "prompt": "test",
            "options": {"fallback": fallback},
        },
        instance={"streamLog": False},
        sip_gateway=None,  # type: ignore[arg-type]
        gateway_session=gateway,  # type: ignore[arg-type]
        call=call,
    )


class _Recording:
    def __init__(self) -> None:
        self.discarded = False
        self.uploaded = False

    async def discard(self) -> None:
        self.discarded = True

    async def stop_and_upload(self):  # noqa: ANN201
        self.uploaded = True
        return None


def _stub_run(
    monkeypatch,
    services: list[Callable[[Any], _Service]],
    recordings: Optional[list] = None,
) -> dict:
    """Replace the build step with real pipelines of the given services, one per
    attempt, and record what reaches the API. ``recordings`` collects a stub
    recording for each attempt."""
    from pipecat_aplisay import api_client, invocation_log
    from pipecat_aplisay.call_session import CallSession

    seen: dict = {"models": [], "agents": [], "prompts": [], "transports": [], "ended": [], "flushed": []}

    async def prepare_run(self, agent, model_name, system_prompt, *, history=None):  # noqa: ANN001
        seen["models"].append(model_name)
        seen["agents"].append(agent.get("id"))
        seen["prompts"].append(system_prompt)
        seen["transports"].append(self.gateway_session.transport)
        service = services[len(seen["models"]) - 1](self)
        if recordings is not None:
            self._recording = _Recording()
            recordings.append(self._recording)
        task = PipelineTask(Pipeline([service]))
        if service._fail is None:
            await task.queue_frames([EndFrame()])
        return task, None

    async def end_call(call, reason=None):  # noqa: ANN001
        seen["ended"].append(reason)

    async def flush(call_id=None, user_id=None, org_id=None, subsystem=None):  # noqa: ANN001
        seen["flushed"].append(call_id)

    monkeypatch.setattr(CallSession, "prepare_run", prepare_run)
    monkeypatch.setattr(api_client, "end_call", end_call)
    monkeypatch.setattr(invocation_log, "flush_invocation_logs", flush)
    return seen


def test_a_start_failure_retries_the_fallback_model_on_the_same_call(monkeypatch) -> None:
    seen = _stub_run(
        monkeypatch,
        [lambda _s: _Service(fail="fatal"), lambda _s: _Service()],
    )
    original = _ws_transport()
    session = _session({"model": FALLBACK}, original)

    asyncio.run(session.run(system_prompt="test"))

    assert seen["models"] == [PRIMARY, FALLBACK]
    first, second = seen["transports"]
    assert first is original
    assert second is not first, "the retry runs on a fresh transport"
    assert second._client._websocket is first._client._websocket, "...over the same live socket"
    assert seen["ended"] == [CALLER_LEFT], "ended once, by the attempt that ran"
    assert seen["flushed"] == ["call-1"], "one InvocationLog for the whole chain"


def test_the_provider_ending_the_session_before_the_bot_speaks_is_a_start_failure(monkeypatch) -> None:
    def provider_ends(session):  # noqa: ANN001
        return _Service(
            on_start=lambda: asyncio.ensure_future(session._on_provider_session_ended("server closed"))
        )

    seen = _stub_run(monkeypatch, [provider_ends, lambda _s: _Service()])
    session = _session({"model": FALLBACK}, _ws_transport())

    asyncio.run(session.run(system_prompt="test"))

    assert seen["models"] == [PRIMARY, FALLBACK]
    assert seen["ended"] == [CALLER_LEFT]


def test_the_message_step_plays_on_the_live_call_after_a_start_failure(monkeypatch) -> None:
    from pipecat_aplisay import fixed_message

    seen = _stub_run(monkeypatch, [lambda _s: _Service(fail="fatal")])
    played_on: list = []

    async def run_fixed_message(transport, agent):  # noqa: ANN001
        played_on.append(transport)
        return True

    monkeypatch.setattr(fixed_message, "run_fixed_message", run_fixed_message)
    original = _ws_transport()
    session = _session({"message": {"text": "Sorry, please call back."}}, original)

    async def run() -> None:
        try:
            await session.run(system_prompt="test")
        except SessionStartFailed:
            return
        raise AssertionError("the start failure should propagate after the message")

    asyncio.run(run())
    [transport] = played_on
    assert transport is not original
    assert transport._client._websocket is original._client._websocket
    assert seen["ended"] == [], "the worker ends the call with the failure reason"


def test_without_a_fallback_there_is_no_window_and_the_call_ends_as_before(monkeypatch) -> None:
    seen = _stub_run(monkeypatch, [lambda _s: _Service(fail="fatal")])
    session = _session({}, _ws_transport())

    asyncio.run(session.run(system_prompt="test"))

    assert session._start_window is None
    assert seen["ended"] == [CALLER_LEFT]


def test_on_the_last_attempt_of_a_chain_a_failure_ends_the_call_as_before(monkeypatch) -> None:
    # The fallback model is the chain's only step: once it is used, nothing is left.
    seen = _stub_run(
        monkeypatch,
        [lambda _s: _Service(fail="fatal"), lambda _s: _Service(fail="fatal")],
    )
    session = _session({"model": FALLBACK}, _ws_transport())

    asyncio.run(session.run(system_prompt="test"))

    assert seen["models"] == [PRIMARY, FALLBACK]
    assert session._start_window is None
    assert seen["ended"] == [CALLER_LEFT]


def test_the_number_step_transfers_the_live_call_and_saves_one_log(monkeypatch) -> None:
    from types import SimpleNamespace

    from pipecat_aplisay import outbound_filter

    seen = _stub_run(monkeypatch, [lambda _s: _Service(fail="fatal")])

    async def authorise_destination(**_kwargs):  # noqa: ANN003
        return SimpleNamespace(allowed=True, srtp=None, failure_message=None)

    monkeypatch.setattr(outbound_filter, "authorise_destination", authorise_destination)
    session = _session({"number": "+441234567890"}, _ws_transport())

    asyncio.run(session.run(system_prompt="test"))

    [request] = session.gateway_session.transfers
    assert request.destination == "+441234567890"
    assert seen["ended"] == []
    assert seen["flushed"] == ["call-1"], "the failed attempt's log is saved once, after the transfer"


def _stub_agent_fetch(monkeypatch, fetch: Callable[[str], dict]) -> list:
    """Serve fallback.agent fetches with ``fetch`` and record each
    ``(agent_id, expected_organisation_id)`` requested."""
    from pipecat_aplisay import api_client

    requested: list = []

    async def get_internal_agent_by_id(agent_id, expected_organisation_id=None):  # noqa: ANN001
        requested.append((agent_id, expected_organisation_id))
        return fetch(agent_id)

    monkeypatch.setattr(api_client, "get_internal_agent_by_id", get_internal_agent_by_id)
    return requested


def _fallback_agent(organisation_id: str, **options: Any) -> dict:
    return {
        "id": "agent-2",
        "userId": "user-2",
        "organisationId": organisation_id,
        "modelName": FALLBACK,
        "prompt": "fallback prompt",
        "options": options,
    }


def _not_found(_agent_id: str) -> dict:
    from pipecat_aplisay import api_client

    raise api_client.ApiRequestError(404, {"error": "Agent not found"}, "API request failed: 404")


def test_the_agent_step_runs_the_fallback_agent_with_its_own_prompt(monkeypatch) -> None:
    seen = _stub_run(
        monkeypatch,
        [lambda _s: _Service(fail="fatal"), lambda _s: _Service(fail="fatal"), lambda _s: _Service()],
    )
    requested = _stub_agent_fetch(
        monkeypatch, lambda _id: _fallback_agent("org-1", fallback={"model": SECOND_FALLBACK})
    )
    session = _session({"agent": "agent-2"}, _ws_transport())

    asyncio.run(session.run(system_prompt="test"))

    assert requested == [("agent-2", "org-1")], "scoped to the call's organisation"
    assert seen["agents"] == ["agent-1", "agent-2", "agent-2"]
    assert seen["models"] == [PRIMARY, FALLBACK, SECOND_FALLBACK], "then the fallback agent's own chain"
    assert seen["prompts"] == ["test", "fallback prompt", "fallback prompt"]
    # Tool-call transfers and bridged-segment recording read session.agent.
    assert session.agent["id"] == "agent-2"
    assert seen["ended"] == [CALLER_LEFT]


@pytest.mark.parametrize(
    "fetch",
    [
        pytest.param(_not_found, id="refused-by-the-server"),
        pytest.param(lambda _id: _fallback_agent("org-2"), id="another-organisation-returned"),
    ],
)
def test_the_agent_step_skips_an_agent_from_another_organisation(monkeypatch, fetch) -> None:
    seen = _stub_run(monkeypatch, [lambda _s: _Service(fail="fatal"), lambda _s: _Service()])
    _stub_agent_fetch(monkeypatch, fetch)
    session = _session({"agent": "agent-2", "model": FALLBACK}, _ws_transport())

    asyncio.run(session.run(system_prompt="test"))

    assert seen["agents"] == ["agent-1", "agent-1"], "the chain moves on to the model step"
    assert seen["models"] == [PRIMARY, FALLBACK]
    assert seen["prompts"] == ["test", "test"]
    assert session.agent["id"] == "agent-1"


def test_a_failed_attempt_discards_its_recording_and_the_retry_keeps_its_own(monkeypatch) -> None:
    recordings: list = []
    _stub_run(
        monkeypatch,
        [lambda _s: _Service(fail="fatal"), lambda _s: _Service()],
        recordings=recordings,
    )
    session = _session({"model": FALLBACK}, _ws_transport())

    asyncio.run(session.run(system_prompt="test"))

    failed, retry = recordings
    assert (failed.discarded, failed.uploaded) == (True, False)
    assert (retry.discarded, retry.uploaded) == (False, True)


def test_after_the_bot_speaks_a_failure_ends_the_call_as_before(monkeypatch) -> None:
    seen = _stub_run(
        monkeypatch,
        [lambda _s: _Service(fail="fatal", speak_first=True), lambda _s: _Service()],
    )
    session = _session({"model": FALLBACK}, _ws_transport())

    asyncio.run(session.run(system_prompt="test"))

    assert seen["models"] == [PRIMARY]
    assert seen["ended"] == [CALLER_LEFT]


def test_a_transport_that_cannot_be_rebuilt_keeps_the_old_behaviour(monkeypatch) -> None:
    # Daily: a second pipeline cannot run on the same call.
    seen = _stub_run(
        monkeypatch,
        [lambda _s: _Service(fail="fatal"), lambda _s: _Service()],
    )
    session = _session({"model": FALLBACK}, None)

    asyncio.run(session.run(system_prompt="test"))

    assert seen["models"] == [PRIMARY]
    assert seen["ended"] == [CALLER_LEFT]


# ---- RecordingSession.discard ------------------------------------------------


def test_discard_deletes_the_pcm_and_uploads_nothing(tmp_path, monkeypatch) -> None:
    from pipecat_aplisay.recording import recording_session

    async def upload(**_kwargs):  # noqa: ANN003
        raise AssertionError("a discarded recording must not be uploaded")

    monkeypatch.setattr(recording_session, "upload_encrypted_ogg", upload)

    async def run() -> None:
        recording = recording_session.RecordingSession(call_id="call-1", work_dir=str(tmp_path))
        await recording.start()
        await recording.append_pcm(b"\x00\x01" * 4000, 16000, 1)
        await recording.discard()
        assert await recording.stop_and_upload() is None

    asyncio.run(run())
    assert list(tmp_path.iterdir()) == []


# ---- Realtime services that fail to open a session -------------------------


def _quiet(llm):  # noqa: ANN001, ANN202
    """No pipeline behind the service: its frame and metric pushes are no-ops."""

    async def noop(*_args, **_kwargs):  # noqa: ANN002, ANN003
        return None

    for name in ("push_frame", "push_error", "stop_all_metrics"):
        setattr(llm, name, noop)
    return llm


def _openai(on_session_ended):  # noqa: ANN001, ANN202
    from pipecat_aplisay import voice_session
    from pipecat_aplisay.openai_realtime_service import build_openai_realtime_service

    return _quiet(
        build_openai_realtime_service(
            api_key="test-key",
            model="gpt-realtime",
            system_prompt="test",
            session_properties=voice_session._openai_realtime_session_properties(
                {"options": {}}, text_output=False
            ),
            on_session_ended=on_session_ended,
        )
    )


def _grok(on_session_ended):  # noqa: ANN001, ANN202
    from pipecat_aplisay import grok_service
    from pipecat_aplisay.voice_session import _xai_session_properties

    agent = {"options": {}}
    return _quiet(
        grok_service.build_grok_service(
            api_key="xai-test",
            model="grok-voice-think-fast-2.0",
            system_prompt="test",
            session_properties=_xai_session_properties(agent),
            agent=agent,
            on_session_ended=on_session_ended,
        )
    )


async def _refused(*_args, **_kwargs):  # noqa: ANN002, ANN003
    raise ConnectionRefusedError("connection refused")


def test_openai_realtime_reports_a_failed_connect(monkeypatch) -> None:
    from pipecat.services.openai.realtime import llm as openai_llm

    monkeypatch.setattr(openai_llm, "websocket_connect", _refused)
    ended: list[str] = []

    async def run() -> None:
        async def on_ended(reason: str) -> None:
            ended.append(reason)

        await _openai(on_ended)._connect()

    asyncio.run(run())
    assert ended == ["connect failed"]


def test_grok_reports_a_failed_connect(monkeypatch) -> None:
    from pipecat.services.xai.realtime import llm as xai_llm

    monkeypatch.setattr(xai_llm, "websocket_connect", _refused)
    ended: list[str] = []

    async def run() -> None:
        async def on_ended(reason: str) -> None:
            ended.append(reason)

        await _grok(on_ended)._connect()

    asyncio.run(run())
    assert ended == ["connect failed"]


class _BrokenSocket:
    """A connection that fails as soon as it is read: an abnormal close."""

    def __aiter__(self):  # noqa: ANN204
        return self

    async def __anext__(self):  # noqa: ANN204
        raise ConnectionResetError("connection reset")


def test_openai_realtime_reports_an_abnormal_close_but_not_its_own() -> None:
    async def run(disconnecting: bool) -> list[str]:
        ended: list[str] = []

        async def on_ended(reason: str) -> None:
            ended.append(reason)

        llm = _openai(on_ended)
        llm._websocket = _BrokenSocket()
        llm._disconnecting = disconnecting
        try:
            await llm._receive_task_handler()
        except ConnectionResetError:
            pass
        return ended

    assert asyncio.run(run(disconnecting=False)) == ["connection_closed"]
    assert asyncio.run(run(disconnecting=True)) == [], "a close we asked for is not the provider ending it"


def test_openai_realtime_reports_a_server_error_once() -> None:
    from types import SimpleNamespace

    async def run() -> list[str]:
        ended: list[str] = []

        async def on_ended(reason: str) -> None:
            ended.append(reason)

        llm = _openai(on_ended)
        await llm._handle_evt_error(SimpleNamespace(error=SimpleNamespace(message="rate limited")))
        await llm._session_ended("connection_closed")
        return ended

    assert asyncio.run(run()) == ["error: rate limited"]


# ---- DisconnectGate on a real websocket transport --------------------------


class _LiveWebsocket:
    """A Starlette WebSocket stand-in that stays open until closed."""

    def __init__(self) -> None:
        from starlette.websockets import WebSocketState

        self._state = WebSocketState
        self.client_state = WebSocketState.CONNECTED
        self.application_state = WebSocketState.CONNECTED
        self.closes = 0
        self._closed = asyncio.Event()

    async def receive(self) -> dict:
        await self._closed.wait()
        return {"type": "websocket.disconnect"}

    async def send_bytes(self, _data: bytes) -> None:
        return None

    async def send_text(self, _data: str) -> None:
        return None

    async def close(self, code: int = 1000, reason: Optional[str] = None) -> None:
        self.closes += 1
        self.client_state = self._state.DISCONNECTED
        self.application_state = self._state.DISCONNECTED
        self._closed.set()


def test_the_gate_keeps_the_socket_open_for_the_retry_then_the_retry_closes_it() -> None:
    from pipecat.serializers.protobuf import ProtobufFrameSerializer
    from pipecat.transports.websocket.fastapi import (
        FastAPIWebsocketParams,
        FastAPIWebsocketTransport,
    )

    from pipecat_aplisay.call_session import CallSession

    async def run() -> tuple[int, int, Optional[str]]:
        websocket = _LiveWebsocket()
        failed_transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(serializer=ProtobufFrameSerializer()),
        )
        window = StartWindow()
        DisconnectGate(failed_transport, window)
        failed = PipelineTask(
            Pipeline([failed_transport.input(), _Service(fail="fatal"), failed_transport.output()])
        )
        watch_start_window(failed, window, failed.cancel)
        await _run_task(failed)
        closes_after_failure = websocket.closes

        retry_transport = CallSession._rebuild_transport_for_handover(failed_transport)
        retry = PipelineTask(Pipeline([retry_transport.input(), _Service(), retry_transport.output()]))
        await retry.queue_frames([EndFrame()])
        await _run_task(retry)
        return closes_after_failure, websocket.closes, window.failure

    closes_after_failure, closes_after_retry, failure = asyncio.run(run())
    assert failure == "provider refused the session"
    assert closes_after_failure == 0, "the failed attempt's cancel did not close the socket"
    assert closes_after_retry == 1, "the retry's own end closed it"
