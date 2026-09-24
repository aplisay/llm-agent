"""OpenAI Realtime keeps receiving the platform's context after the first reply.
See openai_realtime_service.py and PR #364.

The pipeline tests build the row's real pipeline with
``voice_session._build_realtime`` on pass-through transport processors. The
OpenAI socket is replaced by a capture, and connecting runs the session
handshake the receive task would. The tests check what goes out."""

from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any, Callable, Optional

import pytest
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.dtmf.types import KeypadEntry
from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    DataFrame,
    Frame,
    InputDTMFFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
    StartFrame,
)
from pipecat.pipeline.runner import PipelineRunner
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.openai.realtime import events
from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService
from pipecat.services.settings import LLMSettings

from pipecat_aplisay import api_client, openai_realtime_service, voice_session
from pipecat_aplisay.call_session import CallSession
from pipecat_aplisay.dtmf import CallbackDtmfAggregator
from pipecat_aplisay.openai_realtime_service import (
    AplisayOpenAIRealtimeLLMService,
    build_openai_realtime_service,
)
from pipecat_aplisay.realtime_context import DTMF_MESSAGE
from pipecat_aplisay.transfer_prompts import HANDOVER_OPENING_INSTRUCTION

MODEL = "pipecat:openai/gpt-realtime"
PROMPT = "You are Sam."
SEED = [{"role": "developer", "content": PROMPT}]


def _agent(**options) -> dict:
    return {"id": "agent-1", "name": "Sam", "modelName": MODEL, "prompt": PROMPT, "options": options}


def _stub_socket(llm) -> list[dict]:  # noqa: ANN001
    """Replace the OpenAI socket: sends are captured, and connecting runs the
    session handshake (session.created, session.updated) in a task, as the
    receive task would."""
    sent: list[dict] = []
    llm._stub_tasks = []

    async def capture(payload: dict) -> None:
        sent.append(payload)

    async def handshake() -> None:
        await llm._send_session_update()
        await llm._handle_evt_session_updated(None)

    async def connect() -> None:
        llm._stub_tasks.append(asyncio.get_running_loop().create_task(handshake()))

    llm._ws_send = capture
    llm._connect = connect
    return sent


def _kinds(sent: list[dict]) -> list[str]:
    return [p["type"] for p in sent]


def _items(sent: list[dict]) -> list[dict]:
    return [p["item"] for p in sent if p["type"] == "conversation.item.create"]


def _response_done(status: str = "completed") -> Any:
    usage = {"total_tokens": 0, "input_tokens": 0, "output_tokens": 0, "input_token_details": {}, "output_token_details": {}}
    return events.parse_server_event(json.dumps({
        "event_id": "e1", "type": "response.done",
        "response": {"id": "r1", "object": "realtime.response", "status": status, "status_details": None, "output": [], "usage": usage},
    }))


def _error(code: str) -> Any:
    return events.parse_server_event(json.dumps({
        "event_id": "e2", "type": "error",
        "error": {"type": "invalid_request_error", "code": code, "message": code},
    }))


async def _until(predicate: Callable[[], bool], timeout: float = 3.0) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


# --- the row's pipeline, built by voice_session -----------------------------------


class _Marker(DataFrame):
    """A frame the output sees after everything queued before it."""


class _Passthrough(FrameProcessor):
    def __init__(self, started: Optional[asyncio.Event] = None) -> None:
        super().__init__()
        self._started = started
        self.markers: list[_Marker] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if self._started is not None and isinstance(frame, StartFrame):
            self._started.set()
        if isinstance(frame, _Marker):
            self.markers.append(frame)
        await self.push_frame(frame, direction)


class _Transport:
    """A gateway transport: pass-through media processors."""

    def __init__(self) -> None:
        self.started = asyncio.Event()
        self._input = _Passthrough()
        self._output = _Passthrough(self.started)

    def input(self) -> FrameProcessor:
        return self._input

    def output(self) -> FrameProcessor:
        return self._output


class _Live:
    """A running pipeline for the row; ``sent`` is what went to OpenAI."""

    def __init__(self, task, context, llm, transport) -> None:  # noqa: ANN001
        self.task, self.context, self.llm, self.transport = task, context, llm, transport
        self.sent = _stub_socket(llm)

    def kinds(self) -> list[str]:
        return _kinds(self.sent)

    async def settle(self) -> None:
        """Wait until everything queued so far has passed the output."""
        marker = _Marker()
        await self.task.queue_frames([marker])
        await _until(lambda: any(m is marker for m in self.transport.output().markers))

    async def first_run(self) -> None:
        """The first turn as _wire_greeting queues it without a greeting: the
        seed (the packed context, the session update) and the first response."""
        await self.task.queue_frames([LLMRunFrame()])
        await _until(lambda: "response.create" in self.kinds())
        assert self.kinds()[-3:] == ["conversation.item.create", "session.update", "response.create"]
        self.sent.clear()

    async def responses(self, count: int, timeout: float = 3.0) -> None:
        await _until(lambda: self.kinds().count("response.create") >= count, timeout)


@asynccontextmanager
async def _running(
    monkeypatch,
    agent: dict,
    *,
    stock: bool = False,
    on_injected_dtmf: Optional[Callable[[str], Any]] = None,
    relay_endpoint: Any = None,
    on_inactivity_hangup: Optional[Callable[[], Any]] = None,
):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    if stock:
        monkeypatch.setattr(openai_realtime_service, "AplisayOpenAIRealtimeLLMService", OpenAIRealtimeLLMService)
    transport = _Transport()
    task, context, llm = await voice_session._build_realtime(
        transport, MODEL, agent, {}, [], agent["prompt"], None, relay_endpoint, None, on_inactivity_hangup,
        on_injected_dtmf=on_injected_dtmf,
    )
    live = _Live(task, context, llm, transport)
    run = asyncio.create_task(PipelineRunner(handle_sigint=False).run(task))
    try:
        await asyncio.wait_for(transport.started.wait(), 5)
        yield live
    finally:
        # Tear down even after a failed assertion; live pipelines otherwise
        # hang asyncio.run's cleanup.
        await task.cancel()
        await asyncio.wait({run}, timeout=5)
        if run.done():
            run.result()


def _call_session() -> CallSession:
    call = api_client.CallRecord(id="c", userId="u", organisationId="o", instanceId="i", agentId="a", persisted=False)
    return CallSession(
        session_id="s", agent=_agent(), instance={"streamLog": False}, call=call,
        sip_gateway=None, gateway_session=None,  # type: ignore[arg-type]
    )


def _quick_kick(monkeypatch) -> None:
    """Idle timers of 50 ms: the option cannot go below a second."""
    real = voice_session._inactivity_timeout_secs
    monkeypatch.setattr(voice_session, "_inactivity_timeout_secs", lambda agent: 0.05 if real(agent) else None)


def test_build_realtime_uses_the_subclass(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    _, _, llm = asyncio.run(
        voice_session._build_realtime(_Transport(), MODEL, _agent(tts={"voice": "verse"}), {}, [], PROMPT, None)
    )
    assert isinstance(llm, AplisayOpenAIRealtimeLLMService)
    assert llm._settings.model == "gpt-realtime"
    assert llm._settings.system_instruction == PROMPT
    assert llm._settings.session_properties.audio.output.voice == "verse"


@pytest.mark.parametrize("stock", [True, False], ids=["stock", "aplisay"])
def test_a_developer_message_appended_after_the_first_reply(monkeypatch, stock):
    """The inactivity kick's frames after the first response: nothing reaches
    OpenAI with the stock service, an item and a response with the subclass."""
    appended = {"role": "developer", "content": "Say goodbye now."}

    async def scenario():
        async with _running(monkeypatch, _agent(), stock=stock) as live:
            assert isinstance(live.llm, AplisayOpenAIRealtimeLLMService) is not stock
            await live.first_run()
            await live.task.queue_frames([LLMMessagesAppendFrame([appended], run_llm=False), LLMRunFrame()])
            await live.settle()
            # The aggregator added the message to the local context either way.
            assert live.context.get_messages()[-1] == appended
            return list(live.sent)

    sent = asyncio.run(scenario())
    if stock:
        assert sent == []
        return
    assert _kinds(sent) == ["conversation.item.create", "response.create"]
    item = sent[0]["item"]
    assert item["type"] == "message" and item["role"] == "system"
    assert item["content"] == [{"type": "input_text", "text": "Say goodbye now."}]


def test_the_inactivity_kick_reaches_the_model(monkeypatch):
    _quick_kick(monkeypatch)
    agent = _agent(inactivity={"timeout": 8, "message": "Are you still there?"})

    async def scenario():
        async with _running(monkeypatch, agent) as live:
            await live.first_run()
            # The bot's first turn ends: the aggregator's idle timer starts and
            # fires the kick.
            await live.task.queue_frames([BotStoppedSpeakingFrame()])
            await live.responses(1)
            return list(live.sent)

    sent = asyncio.run(scenario())
    assert _kinds(sent) == ["conversation.item.create", "response.create"]
    item = sent[0]["item"]
    assert item["role"] == "system"
    assert "<verbatim>Are you still there?</verbatim>" in item["content"][0]["text"]


def test_keypad_digits_reach_the_model_the_context_and_the_transcript(monkeypatch):
    session = _call_session()

    async def scenario():
        # A short inter-digit timeout flushes the digits without a terminator.
        async with _running(monkeypatch, _agent(dtmfTimeout=100), on_injected_dtmf=session._on_injected_dtmf) as live:
            session._llm_service, session._llm_context = live.llm, live.context
            await live.first_run()
            await live.task.queue_frames([InputDTMFFrame(button=KeypadEntry.ONE), InputDTMFFrame(button=KeypadEntry.TWO)])
            await live.responses(1)
            await _until(lambda: bool(session.call.batched_transaction_logs))
            return list(live.sent), list(live.context.get_messages()), list(session.call.batched_transaction_logs)

    sent, messages, rows = asyncio.run(scenario())
    assert _kinds(sent) == ["conversation.item.create", "response.create"]
    item = sent[0]["item"]
    assert item["role"] == "user"
    assert item["content"] == [{"type": "input_text", "text": DTMF_MESSAGE.format(digits="12")}]
    # The turn the DTMF aggregator's TranscriptionFrame would have added, for
    # transfer transcripts and handover history, and the log row.
    assert messages[-1] == {"role": "user", "content": "DTMF: 12"}
    assert [(r["type"], r["data"]) for r in rows] == [("user", "DTMF: 12")]


def test_a_keypad_answer_resets_the_inactivity_hangup_count(monkeypatch):
    _quick_kick(monkeypatch)
    agent = _agent(inactivity={"timeout": 8, "message": "Still there?", "hangup": True}, dtmfTimeout=100)
    hangups: list[int] = []
    session = _call_session()

    async def hang_up() -> None:
        hangups.append(1)

    async def scenario():
        async with _running(monkeypatch, agent, on_injected_dtmf=session._on_injected_dtmf, on_inactivity_hangup=hang_up) as live:
            session._llm_service, session._llm_context = live.llm, live.context
            await live.first_run()
            # Two prompts go unanswered; the third would end the call.
            for n in (1, 2):
                await live.task.queue_frames([BotStoppedSpeakingFrame()])
                await live.responses(n)
            # The caller answers on the keypad instead.
            await live.task.queue_frames([InputDTMFFrame(button=KeypadEntry.ONE)])
            await live.responses(3)
            for n in (4, 5):
                await live.task.queue_frames([BotStoppedSpeakingFrame()])
                await live.responses(n)
            assert hangups == []
            await live.task.queue_frames([BotStoppedSpeakingFrame()])
            await live.responses(6)
            await _until(lambda: hangups == [1])

    asyncio.run(scenario())


def test_digits_during_the_greeting_are_dropped(monkeypatch):
    session = _call_session()

    async def scenario():
        agent = _agent(greeting={"text": "Thanks for calling Acme."}, dtmfTimeout=100)
        async with _running(monkeypatch, agent, on_injected_dtmf=session._on_injected_dtmf) as live:
            session._llm_service, session._llm_context = live.llm, live.context
            await live.first_run()
            # The greeting mute holds the caller until the bot's first turn ends.
            await live.task.queue_frames([InputDTMFFrame(button=KeypadEntry.ONE)])
            await asyncio.sleep(0.2)
            await live.settle()
            assert live.sent == []
            await live.task.queue_frames([BotStoppedSpeakingFrame(), InputDTMFFrame(button=KeypadEntry.TWO)])
            await live.responses(1)
            return list(live.sent)

    sent = asyncio.run(scenario())
    assert _items(sent)[0]["content"][0]["text"] == DTMF_MESSAGE.format(digits="2")


def test_digits_on_a_relay_engaged_leg_go_nowhere(monkeypatch):
    session = _call_session()
    relay = SimpleNamespace(tap=_Passthrough(), inject=_Passthrough(), engaged=True)

    async def scenario():
        async with _running(monkeypatch, _agent(dtmfTimeout=100), on_injected_dtmf=session._on_injected_dtmf, relay_endpoint=relay) as live:
            session._llm_service, session._llm_context = live.llm, live.context
            await live.first_run()
            await live.task.queue_frames([InputDTMFFrame(button=KeypadEntry.ONE)])
            await asyncio.sleep(0.2)
            await live.settle()
            assert live.sent == [] and session.call.batched_transaction_logs == []
            relay.engaged = False
            await live.task.queue_frames([InputDTMFFrame(button=KeypadEntry.TWO)])
            await live.responses(1)

    asyncio.run(scenario())


def test_digits_buffered_at_pipeline_end_are_dropped(monkeypatch):
    session = _call_session()

    async def scenario():
        async with _running(monkeypatch, _agent(dtmfTimeout=5000), on_injected_dtmf=session._on_injected_dtmf) as live:
            session._llm_service, session._llm_context = live.llm, live.context
            await live.first_run()
            await live.task.queue_frames([InputDTMFFrame(button=KeypadEntry.ONE)])
            await live.settle()
            return live

    live = asyncio.run(scenario())
    assert live.sent == []


def test_the_in_place_handover_starts_a_new_conversation(monkeypatch):
    async def scenario():
        async with _running(monkeypatch, _agent()) as live:
            await live.first_run()
            disconnects: list[int] = []
            real_disconnect = live.llm._disconnect

            async def disconnect() -> None:
                disconnects.append(1)
                await real_disconnect()

            live.llm._disconnect = disconnect
            session = _call_session()
            session._task, session._llm_service = live.task, live.llm
            session._registered_tool_names = set()
            session._build_tools_for = lambda agent, extra_builtins=None: []
            new_agent = {"id": "agent-2", "modelName": MODEL, "prompt": "two"}
            await session._apply_agent_transfer(new_agent, "You are agent two.")
            await live.responses(1)
            await live.settle()
            # Counted before teardown, which disconnects again.
            return list(live.sent), live.llm, list(disconnects)

    sent, llm, disconnects = asyncio.run(scenario())
    assert llm._settings.system_instruction == "You are agent two."
    # The new prompt and tools on the old socket, then a new conversation:
    # the handshake, one packed item with the prompt and the opening, the
    # seed's session update and the incoming agent's first turn.
    assert disconnects == [1]
    assert _kinds(sent) == ["session.update"] * 3 + ["conversation.item.create", "session.update", "response.create"]
    assert all(p["session"]["instructions"] == "You are agent two." for p in sent if p["type"] == "session.update")
    [item] = _items(sent)
    assert item["role"] == "user"
    assert "You are agent two." in item["content"][0]["text"]
    assert HANDOVER_OPENING_INSTRUCTION in item["content"][0]["text"]
    assert llm._seen_messages == [
        {"role": "developer", "content": "You are agent two."},
        {"role": "developer", "content": HANDOVER_OPENING_INSTRUCTION},
    ]


# --- the service on its own ---------------------------------------------------------


def _service() -> tuple[AplisayOpenAIRealtimeLLMService, list[dict]]:
    llm = build_openai_realtime_service(
        api_key="test-key",
        model="gpt-realtime",
        system_prompt=PROMPT,
        session_properties=voice_session._openai_realtime_session_properties(_agent(), text_output=False),
    )

    async def noop(*_args, **_kwargs):
        return None

    for name in ("push_frame", "push_error", "start_processing_metrics", "start_ttfb_metrics",
                 "stop_processing_metrics", "stop_ttfb_metrics", "stop_all_metrics", "start_llm_usage_metrics"):
        setattr(llm, name, noop)
    return llm, _stub_socket(llm)


async def _connected(llm) -> None:  # noqa: ANN001
    await llm._connect()
    await asyncio.gather(*llm._stub_tasks)


def _context(messages=None) -> LLMContext:  # noqa: ANN001
    return LLMContext(list(messages or []), tools=ToolsSchema(standard_tools=[]))


def _texts(sent: list[dict]) -> list[str]:
    return [item["content"][0]["text"] for item in _items(sent)]


async def _seeded(llm, sent, messages=SEED):  # noqa: ANN001
    await _connected(llm)
    await llm._handle_context(_context(messages))
    assert _kinds(sent)[-3:] == ["conversation.item.create", "session.update", "response.create"]
    sent.clear()


def test_the_seed_marks_what_it_packed_as_sent():
    """A message added while the seed's sends are in flight is not in the
    packed item, so it goes out on the next context frame."""
    llm, sent = _service()
    seed = [{"role": "developer", "content": PROMPT}, {"role": "developer", "content": "Greet warmly."}]
    late = {"role": "developer", "content": "Say goodbye now."}
    capture = llm._ws_send

    async def slow_capture(payload: dict) -> None:
        await capture(payload)
        if payload["type"] == "session.update" and llm._seeding and late not in llm._context.get_messages():
            llm._context.add_message(late)

    llm._ws_send = slow_capture

    async def scenario():
        await _connected(llm)
        await llm._handle_context(_context(seed))
        assert _kinds(sent)[-3:] == ["conversation.item.create", "session.update", "response.create"]
        assert llm._seen_messages == seed
        sent.clear()
        await llm._handle_context(llm._context)
        assert _kinds(sent) == ["conversation.item.create", "response.create"]
        assert _texts(sent) == ["Say goodbye now."]
        sent.clear()
        # The same context again sends nothing.
        await llm._handle_context(llm._context)
        assert sent == []

    asyncio.run(scenario())


def test_a_caller_turn_never_asks_for_a_response():
    llm, sent = _service()

    async def scenario():
        await _seeded(llm, sent)
        # The transcribed turn lands in the context: the server already has the audio.
        turn = [*SEED, {"role": "user", "content": "I need an appointment"}]
        await llm._handle_context(_context(turn))
        assert sent == []
        # The assistant's reply is added by the assistant aggregator without a run.
        await llm._handle_context(_context([*turn, {"role": "assistant", "content": "Of course."}]))
        assert sent == []
        assert len(llm._seen_messages) == 3
        # A platform message beside a caller turn still runs: in realtime mode
        # the turn is written after its own response has started.
        await llm._handle_context(_context([*turn, {"role": "assistant", "content": "Of course."},
                                            {"role": "developer", "content": [{"type": "text", "text": "Say goodbye now."}]},
                                            {"role": "user", "content": "hello?"}]))
        assert _kinds(sent) == ["conversation.item.create", "response.create"]
        assert _texts(sent) == ["Say goodbye now."]

    asyncio.run(scenario())


def test_a_tool_result_creates_one_response_only():
    llm, sent = _service()

    async def scenario():
        await _seeded(llm, sent)
        await llm._handle_context(_context([
            *SEED,
            {"role": "developer", "content": "Answer now."},
            {"role": "tool", "tool_call_id": "call-1", "content": '{"ok": true}'},
        ]))
        assert _kinds(sent).count("response.create") == 1
        assert [item["type"] for item in _items(sent)] == ["message", "function_call_output"]

    asyncio.run(scenario())


def test_digits_before_the_seed_wait_for_it():
    llm, sent = _service()

    async def scenario():
        await llm.inject_dtmf("5")
        assert sent == [] and len(llm._held_items) == 1
        await _connected(llm)
        sent.clear()
        await llm._handle_context(_context(SEED))
        # The packed history, then the digits, then a response for them once
        # the seed's response is done.
        assert _kinds(sent) == ["conversation.item.create", "session.update", "response.create", "conversation.item.create"]
        assert _texts(sent)[-1] == DTMF_MESSAGE.format(digits="5")
        assert llm._response_pending is True
        sent.clear()
        await llm._handle_evt_response_done(_response_done())
        assert _kinds(sent) == ["response.create"]
        # After the seed the digits go straight out.
        sent.clear()
        await llm.inject_dtmf("6")
        assert _kinds(sent) == ["conversation.item.create", "response.create"]
        assert _items(sent)[0]["role"] == "user"

    asyncio.run(scenario())


def test_a_response_waits_for_the_active_one():
    llm, sent = _service()

    async def scenario():
        await _seeded(llm, sent)
        llm._current_assistant_response = SimpleNamespace(id="item-1")
        await llm.inject_dtmf("1")
        assert _kinds(sent) == ["conversation.item.create"]
        assert llm._response_pending is True
        await llm._handle_evt_response_done(_response_done())
        assert _kinds(sent) == ["conversation.item.create", "response.create"]
        assert llm._response_pending is False

    asyncio.run(scenario())


def test_a_refused_response_is_asked_for_again():
    llm, sent = _service()

    async def scenario():
        await _seeded(llm, sent)
        handled = await llm._maybe_handle_evt_retrieve_conversation_item_error(_error("conversation_already_has_active_response"))
        assert handled is True and llm._response_pending is True
        await llm._handle_evt_response_done(_response_done())
        assert _kinds(sent) == ["response.create"]
        # Other errors take the stock path.
        assert await llm._maybe_handle_evt_retrieve_conversation_item_error(_error("invalid_value")) is False

    asyncio.run(scenario())


def test_a_replaced_context_starts_a_new_conversation():
    """The in-place handover: a frame that reads the replaced context before
    the settings update is skipped; the run's own frame restarts the
    conversation, and a late result for the old agent's tool call is not sent
    into it."""
    llm, sent = _service()
    replaced = [
        {"role": "developer", "content": "You are agent two."},
        {"role": "developer", "content": HANDOVER_OPENING_INSTRUCTION},
    ]

    async def scenario():
        history = [*SEED, {"role": "user", "content": "put me through to sales"}, {"role": "assistant", "content": "One moment."}]
        await _seeded(llm, sent)
        await llm._handle_context(_context(history))
        llm._current_assistant_response = SimpleNamespace(id="item-1")
        llm._session_call_ids.add("call-1")
        # A flush frame queued before the settings update.
        await llm._handle_context(_context(replaced))
        assert sent == [] and llm._seen_messages == history
        await llm._update_settings(LLMSettings(system_instruction="You are agent two."))
        sent.clear()
        await llm._handle_context(_context(replaced))
        await asyncio.gather(*llm._stub_tasks)
        # The handshake of the new socket, then the seed from the new context.
        assert _kinds(sent) == ["session.update", "conversation.item.create", "session.update", "response.create"]
        assert HANDOVER_OPENING_INSTRUCTION in _texts(sent)[0]
        assert llm._seen_messages == replaced and llm._current_assistant_response is None
        assert "call-1" in llm._completed_tool_calls
        sent.clear()
        # The old agent's transfer_agent result lands late: nothing goes out.
        await llm._handle_context(_context([
            *replaced,
            {"role": "assistant", "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "transfer_agent", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "call-1", "content": '{"status": "OK"}'},
        ]))
        assert sent == []

    asyncio.run(scenario())


def test_function_call_ids_are_recorded_per_conversation(monkeypatch):
    llm, _ = _service()
    seen: list[str] = []

    async def stock(self, evt):  # noqa: ANN001
        seen.append(evt.call_id)

    monkeypatch.setattr(OpenAIRealtimeLLMService, "_handle_evt_function_call_arguments_done", stock)
    evt = SimpleNamespace(call_id="call-9")
    asyncio.run(llm._handle_evt_function_call_arguments_done(evt))
    assert seen == ["call-9"] and llm._session_call_ids == {"call-9"}


# --- the keypad aggregator and the kick's reset ------------------------------------


def test_callback_aggregator_drops_digits_while_muted():
    got: list[str] = []

    async def on_digits(digits: str) -> None:
        got.append(digits)

    aggregator = CallbackDtmfAggregator(timeout=1.5, on_digits=on_digits, mute_until_bot_complete=True)

    async def no_interruption() -> None:
        return None

    aggregator.broadcast_interruption = no_interruption  # type: ignore[method-assign]
    asyncio.run(aggregator._handle_dtmf_frame(InputDTMFFrame(button=KeypadEntry.ONE)))
    assert aggregator._aggregation == ""
    aggregator._muted = False
    asyncio.run(aggregator._handle_dtmf_frame(InputDTMFFrame(button=KeypadEntry.ONE)))
    assert aggregator._aggregation == "1"
    asyncio.run(aggregator._flush_aggregation())
    assert got == ["1"] and aggregator._aggregation == ""


def test_wire_inactivity_kick_returns_a_reset():
    class _Aggregator:
        def __init__(self):
            self.handlers = {}

        def event_handler(self, name):
            def register(fn):
                self.handlers[name] = fn
                return fn

            return register

    reset = voice_session._wire_inactivity_kick(
        user_aggregator=_Aggregator(), task_ref_getter=lambda: None,
        agent=_agent(inactivity={"timeout": 8, "message": "Still there?"}), mode="realtime", is_ultravox=False,
    )
    assert callable(reset)
    assert voice_session._wire_inactivity_kick(
        user_aggregator=_Aggregator(), task_ref_getter=lambda: None, agent=_agent(), mode="realtime", is_ultravox=False,
    ) is None
