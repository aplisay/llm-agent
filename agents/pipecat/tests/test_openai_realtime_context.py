"""OpenAI Realtime keeps receiving the platform's context after the first reply.

The stock Pipecat service seeds the server once and then only sends tool
results, so on ``pipecat:openai/gpt-realtime`` the inactivity kick, keypad
digits and the in-place handover opening never reached the model. The pipeline
tests here run the row's real pipeline (``voice_session._build_realtime`` on a
pass-through transport, the OpenAI socket replaced by a capture) and check what
goes out. See openai_realtime_service.py."""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import Any, Callable, Optional

import pytest
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.audio.dtmf.types import KeypadEntry
from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    Frame,
    InputDTMFFrame,
    LLMMessagesAppendFrame,
    LLMRunFrame,
    StartFrame,
)
from pipecat.pipeline.runner import PipelineRunner
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService
from pipecat.services.settings import LLMSettings

from pipecat_aplisay import openai_realtime_service, voice_session
from pipecat_aplisay.grok import DTMF_MESSAGE
from pipecat_aplisay.openai_realtime_service import (
    AplisayOpenAIRealtimeLLMService,
    build_openai_realtime_service,
)
from pipecat_aplisay.transfer_prompts import HANDOVER_OPENING_INSTRUCTION

MODEL = "pipecat:openai/gpt-realtime"
PROMPT = "You are Sam."


def _agent(**options) -> dict:
    return {"id": "agent-1", "name": "Sam", "modelName": MODEL, "prompt": PROMPT, "options": options}


# --- the row's pipeline, built by voice_session -----------------------------------


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

    def __init__(self, task, context, llm) -> None:  # noqa: ANN001
        self.task, self.context, self.llm = task, context, llm
        self.sent: list[dict] = []

    def kinds(self) -> list[str]:
        return [p["type"] for p in self.sent]

    def items(self) -> list[dict]:
        return [p["item"] for p in self.sent if p["type"] == "conversation.item.create"]


def _stock_builder(*, api_key, model, system_prompt, session_properties):  # noqa: ANN001
    """What _build_realtime did before the subclass existed."""
    return OpenAIRealtimeLLMService(
        api_key=api_key,
        settings=OpenAIRealtimeLLMService.Settings(
            model=model, system_instruction=system_prompt, session_properties=session_properties
        ),
    )


@asynccontextmanager
async def _running(
    monkeypatch,
    agent: dict,
    *,
    stock: bool = False,
    on_injected_dtmf: Optional[Callable[[str], Any]] = None,
):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    if stock:
        monkeypatch.setattr(openai_realtime_service, "build_openai_realtime_service", _stock_builder)
    transport = _Transport()
    task, context, llm = await voice_session._build_realtime(
        transport, MODEL, agent, {}, [], agent["prompt"], None, on_injected_dtmf=on_injected_dtmf
    )
    live = _Live(task, context, llm)

    async def capture(payload: dict) -> None:
        live.sent.append(payload)

    async def connected() -> None:
        return None

    llm._ws_send = capture
    llm._connect = connected
    # No session handshake here: the server is taken as ready from the start.
    llm._api_session_ready = True
    run = asyncio.create_task(PipelineRunner(handle_sigint=False).run(task))
    try:
        await asyncio.wait_for(transport.started.wait(), 5)
        yield live
    finally:
        # Tear down even after a failed assertion; live pipelines otherwise
        # hang asyncio.run's cleanup.
        await task.cancel()
        await asyncio.wait({run}, timeout=5)


async def _until(predicate: Callable[[], bool], timeout: float = 3.0) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


async def _first_run(live: _Live) -> None:
    """The first turn as _wire_greeting queues it without a greeting: the seed
    (the packed context, the session update) and the first response."""
    await live.task.queue_frames([LLMRunFrame()])
    await _until(lambda: "response.create" in live.kinds())
    assert live.kinds() == ["conversation.item.create", "session.update", "response.create"]
    live.sent.clear()


def test_build_realtime_uses_the_subclass(monkeypatch):
    async def scenario():
        async with _running(monkeypatch, _agent(tts={"voice": "verse"})) as live:
            return live.llm

    llm = asyncio.run(scenario())
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
            await _first_run(live)
            await live.task.queue_frames([LLMMessagesAppendFrame([appended], run_llm=False), LLMRunFrame()])
            # The aggregator adds the message to the local context either way.
            await _until(lambda: live.context.get_messages()[-1:] == [appended])
            if stock:
                await asyncio.sleep(0.3)
            else:
                await _until(lambda: "response.create" in live.kinds())
            return list(live.sent)

    sent = asyncio.run(scenario())
    if stock:
        assert sent == []
        return
    assert [p["type"] for p in sent] == ["conversation.item.create", "response.create"]
    item = sent[0]["item"]
    assert item["type"] == "message" and item["role"] == "system"
    assert item["content"] == [{"type": "input_text", "text": "Say goodbye now."}]


def test_the_inactivity_kick_reaches_the_model(monkeypatch):
    agent = _agent(inactivity={"timeout": 1, "message": "Are you still there?"})

    async def scenario():
        async with _running(monkeypatch, agent) as live:
            await _first_run(live)
            # The bot's first turn ends: the aggregator's idle timer starts and
            # fires the kick after the configured second.
            await live.task.queue_frames([BotStoppedSpeakingFrame()])
            await _until(lambda: "response.create" in live.kinds(), timeout=4)
            return list(live.sent)

    sent = asyncio.run(scenario())
    assert [p["type"] for p in sent] == ["conversation.item.create", "response.create"]
    item = sent[0]["item"]
    assert item["role"] == "system"
    assert "<verbatim>Are you still there?</verbatim>" in item["content"][0]["text"]


def test_keypad_digits_reach_the_model(monkeypatch):
    digits_seen: list[str] = []
    service: dict = {}

    async def on_injected_dtmf(digits: str) -> None:
        # CallSession._on_injected_dtmf: the transcript row, then the service.
        digits_seen.append(digits)
        await service["llm"].inject_dtmf(digits)

    async def scenario():
        # A short inter-digit timeout flushes the digits without a terminator.
        async with _running(monkeypatch, _agent(dtmfTimeout=100), on_injected_dtmf=on_injected_dtmf) as live:
            service["llm"] = live.llm
            await _first_run(live)
            await live.task.queue_frames([InputDTMFFrame(button=KeypadEntry.ONE), InputDTMFFrame(button=KeypadEntry.TWO)])
            await _until(lambda: "response.create" in live.kinds())
            return list(live.sent), list(live.context.get_messages())

    sent, messages = asyncio.run(scenario())
    assert digits_seen == ["12"]
    assert [p["type"] for p in sent] == ["conversation.item.create", "response.create"]
    item = sent[0]["item"]
    assert item["role"] == "user"
    assert item["content"] == [{"type": "input_text", "text": DTMF_MESSAGE.format(digits="12")}]
    # The digits went through the service, not the aggregator's user turn.
    assert all(m.get("role") != "user" for m in messages)


def test_the_in_place_handover_opening_reaches_the_model(monkeypatch):
    from pipecat_aplisay import api_client
    from pipecat_aplisay.call_session import CallSession

    async def scenario():
        async with _running(monkeypatch, _agent()) as live:
            await _first_run(live)
            call = api_client.CallRecord(id="c", userId="u", organisationId="o", instanceId="i", agentId="a", persisted=False)
            session = CallSession(
                session_id="s", agent=_agent(), instance={"streamLog": False}, call=call,
                sip_gateway=None, gateway_session=None,  # type: ignore[arg-type]
            )
            session._task = live.task
            session._llm_service = live.llm
            session._registered_tool_names = set()
            session._build_tools_for = lambda agent, extra_builtins=None: []
            new_agent = {"id": "agent-2", "modelName": MODEL, "prompt": "two"}
            await session._apply_agent_transfer(new_agent, "You are agent two.")
            await _until(lambda: "response.create" in live.kinds())
            return list(live.sent), live.llm._settings.system_instruction

    sent, instruction = asyncio.run(scenario())
    assert instruction == "You are agent two."
    # The new prompt as session instructions, the new tools, then the opening
    # and the incoming agent's first turn. The prompt is not sent as an item.
    assert [p["type"] for p in sent] == ["session.update", "session.update", "conversation.item.create", "response.create"]
    assert sent[0]["session"]["instructions"] == "You are agent two."
    item = sent[2]["item"]
    assert item["role"] == "system"
    assert item["content"] == [{"type": "input_text", "text": HANDOVER_OPENING_INSTRUCTION}]


# --- the service on its own ---------------------------------------------------------


def _build() -> tuple[AplisayOpenAIRealtimeLLMService, list[dict]]:
    llm = build_openai_realtime_service(
        api_key="test-key",
        model="gpt-realtime",
        system_prompt=PROMPT,
        session_properties=voice_session._openai_realtime_session_properties(_agent(), text_output=False),
    )
    sent: list[dict] = []

    async def capture(payload: dict) -> None:
        sent.append(payload)

    async def noop(*_args, **_kwargs):
        return None

    llm._ws_send = capture  # type: ignore[method-assign]
    for name in ("push_frame", "push_error", "start_processing_metrics", "start_ttfb_metrics",
                 "stop_processing_metrics", "stop_ttfb_metrics", "stop_all_metrics", "start_llm_usage_metrics"):
        setattr(llm, name, noop)
    llm._api_session_ready = True
    return llm, sent


def _context(messages=None) -> LLMContext:  # noqa: ANN001
    return LLMContext(list(messages or []), tools=ToolsSchema(standard_tools=[]))


def _kinds(sent: list[dict]) -> list[str]:
    return [p["type"] for p in sent]


def _texts(sent: list[dict]) -> list[str]:
    return [p["item"]["content"][0]["text"] for p in sent if p["type"] == "conversation.item.create"]


def test_the_seed_marks_the_packed_history_as_sent():
    llm, sent = _build()
    seed = [{"role": "developer", "content": PROMPT}, {"role": "developer", "content": "Greet warmly."}]
    asyncio.run(llm._handle_context(_context(seed)))
    assert _kinds(sent) == ["conversation.item.create", "session.update", "response.create"]
    assert llm._llm_needs_conversation_setup is False
    assert llm._seen_messages == seed
    sent.clear()
    # The same context again sends nothing.
    asyncio.run(llm._handle_context(_context(seed)))
    assert sent == []


def test_a_caller_turn_never_asks_for_a_response():
    llm, sent = _build()
    asyncio.run(llm._handle_context(_context([{"role": "developer", "content": PROMPT}])))
    sent.clear()
    # The transcribed turn lands in the context: the server already has the audio.
    turn = [{"role": "developer", "content": PROMPT}, {"role": "user", "content": "I need an appointment"}]
    asyncio.run(llm._handle_context(_context(turn)))
    assert sent == []
    # The assistant's reply is added by the assistant aggregator without a run.
    asyncio.run(llm._handle_context(_context([*turn, {"role": "assistant", "content": "Of course."}])))
    assert sent == []
    assert len(llm._seen_messages) == 3


def test_a_platform_message_beside_a_caller_turn_is_sent_without_a_response():
    llm, sent = _build()
    asyncio.run(llm._handle_context(_context([{"role": "developer", "content": PROMPT}])))
    sent.clear()
    ctx = _context([
        {"role": "developer", "content": PROMPT},
        {"role": "developer", "content": [{"type": "text", "text": "Say goodbye now."}]},
        {"role": "user", "content": "hello?"},
    ])
    asyncio.run(llm._handle_context(ctx))
    # The server VAD answers the caller's turn; a second response.create would collide.
    assert _kinds(sent) == ["conversation.item.create"]
    assert _texts(sent) == ["Say goodbye now."]


def test_a_replaced_context_sends_only_what_the_server_lacks():
    """The in-place handover: the new prompt is already the session
    instructions, so only the opening goes out, and the run follows it."""
    llm, sent = _build()
    history = [
        {"role": "developer", "content": PROMPT},
        {"role": "user", "content": "put me through to sales"},
        {"role": "assistant", "content": "One moment."},
    ]
    asyncio.run(llm._handle_context(_context(history[:1])))
    asyncio.run(llm._handle_context(_context(history)))
    asyncio.run(llm._update_settings(LLMSettings(system_instruction="You are agent two.")))
    sent.clear()
    replaced = [
        {"role": "developer", "content": "You are agent two."},
        {"role": "developer", "content": HANDOVER_OPENING_INSTRUCTION},
    ]
    asyncio.run(llm._handle_context(_context(replaced)))
    assert _kinds(sent) == ["conversation.item.create", "response.create"]
    assert _texts(sent) == [HANDOVER_OPENING_INSTRUCTION]
    assert llm._seen_messages == replaced


def test_a_tool_result_creates_one_response_only():
    llm, sent = _build()
    asyncio.run(llm._handle_context(_context([{"role": "developer", "content": PROMPT}])))
    sent.clear()
    ctx = _context([
        {"role": "developer", "content": PROMPT},
        {"role": "developer", "content": "Answer now."},
        {"role": "tool", "tool_call_id": "call-1", "content": '{"ok": true}'},
    ])
    asyncio.run(llm._handle_context(ctx))
    assert _kinds(sent).count("response.create") == 1
    assert [p["item"]["type"] for p in sent if p["type"] == "conversation.item.create"] == ["message", "function_call_output"]


def test_items_wait_for_the_session_and_go_out_before_the_run():
    llm, sent = _build()
    asyncio.run(llm._handle_context(_context([{"role": "developer", "content": PROMPT}])))
    sent.clear()
    llm._api_session_ready = False
    ctx = _context([{"role": "developer", "content": PROMPT}, {"role": "developer", "content": "Say goodbye now."}])
    asyncio.run(llm._handle_context(ctx))
    assert sent == []
    assert llm._run_llm_when_api_session_ready is True
    asyncio.run(llm._handle_evt_session_updated(None))
    assert _kinds(sent) == ["conversation.item.create", "response.create"]
    assert _texts(sent) == ["Say goodbye now."]
    assert llm._pending_items == []


def test_inject_dtmf_is_a_user_item_and_a_response():
    llm, sent = _build()
    asyncio.run(llm._handle_context(_context([{"role": "developer", "content": PROMPT}])))
    sent.clear()
    asyncio.run(llm.inject_dtmf("1234"))
    assert _kinds(sent) == ["conversation.item.create", "response.create"]
    item = sent[0]["item"]
    assert item["type"] == "message" and item["role"] == "user"
    assert item["content"] == [{"type": "input_text", "text": DTMF_MESSAGE.format(digits="1234")}]
    # Before the first turn the item is sent and the first run answers it.
    llm2, sent2 = _build()
    asyncio.run(llm2.inject_dtmf("5"))
    assert _kinds(sent2) == ["conversation.item.create"]
    assert llm2._run_llm_when_api_session_ready is False
    # Before the session is ready the item waits for it.
    llm3, sent3 = _build()
    asyncio.run(llm3._handle_context(_context([{"role": "developer", "content": PROMPT}])))
    sent3.clear()
    llm3._api_session_ready = False
    asyncio.run(llm3.inject_dtmf("6"))
    assert sent3 == []
    asyncio.run(llm3._handle_evt_session_updated(None))
    assert _kinds(sent3) == ["conversation.item.create", "response.create"]
    assert _texts(sent3) == [DTMF_MESSAGE.format(digits="6")]


def test_messages_append_frames_are_left_to_the_aggregator():
    llm, sent = _build()
    asyncio.run(llm._handle_messages_append(LLMMessagesAppendFrame([{"role": "developer", "content": "x"}])))
    assert sent == []
