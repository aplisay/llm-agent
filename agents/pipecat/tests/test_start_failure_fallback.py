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


def _stub_run(monkeypatch, services: list[Callable[[Any], _Service]]) -> dict:
    """Replace the build step with real pipelines of the given services, one per
    attempt, and record what reaches the API."""
    from pipecat_aplisay import api_client, invocation_log
    from pipecat_aplisay.call_session import CallSession

    seen: dict = {"models": [], "transports": [], "ended": [], "flushed": []}

    async def prepare_run(self, agent, model_name, system_prompt, *, history=None):  # noqa: ANN001
        seen["models"].append(model_name)
        seen["transports"].append(self.gateway_session.transport)
        service = services[len(seen["models"]) - 1](self)
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


def test_without_a_fallback_the_start_failure_propagates(monkeypatch) -> None:
    seen = _stub_run(monkeypatch, [lambda _s: _Service(fail="fatal")])
    session = _session({}, _ws_transport())

    async def run() -> Optional[BaseException]:
        try:
            await session.run(system_prompt="test")
        except SessionStartFailed as e:
            return e
        return None

    assert isinstance(asyncio.run(run()), SessionStartFailed)
    assert seen["ended"] == [], "not recorded as the caller hanging up"


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
