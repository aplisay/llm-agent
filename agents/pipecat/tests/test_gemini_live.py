"""Gemini Live on the Pipecat worker (``pipecat:google/gemini-2.5-flash-native-audio-preview-12-2025``).

Three defects found by reading the code on 2026-09-23, each reproduced through a
real user aggregator and Pipecat's own Gemini service against a fake Live
session (no network):

* The row's model id and voice never reached the service, which ran Pipecat's
  default Live model with its default voice whatever the row or the agent said.
* A message appended mid-call (the inactivity kick: a developer message and an
  ``LLMRunFrame``) landed in the local context only. The service forwards tool
  results from an updated context and nothing else, so the prompt was never
  spoken. ``gemini_service.AplisayGeminiLiveLLMService`` sends it as a user turn.
* A same-model ``transfer_agent`` took the in-place route, whose frames the
  service stores or ignores: the old prompt and tools stayed and the new agent
  never opened. Gemini rows now restart, as Ultravox, GPT-Live and Grok do.
* Keypad digits became a ``TranscriptionFrame``, then a user message the
  service never sends. The DTMF aggregator now hands them to the service, which
  sends them as a user turn (``inject_dtmf``), as on GPT-Live and Grok.
* Each spoken caller turn was logged as several final ``user`` transcript rows,
  one per sentence, because the service pushed a final frame per sentence. It
  now pushes cumulative interim frames and one final frame per turn.
"""

from __future__ import annotations

import asyncio
from typing import Callable

import pytest
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import (
    EndFrame,
    InputDTMFFrame,
    InterruptionFrame,
    KeypadEntry,
    LLMMessagesAppendFrame,
    LLMMessagesUpdateFrame,
    LLMRunFrame,
    LLMSetToolsFrame,
    LLMUpdateSettingsFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
    LLMUserAggregatorParams,
)
from pipecat.services.settings import LLMSettings
from pipecat.turns.user_start import VADUserTurnStartStrategy
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

gemini_live = pytest.importorskip("pipecat.services.google.gemini_live.llm")

from pipecat_aplisay import gemini_service, voice_session  # noqa: E402
from pipecat_aplisay.gemini import (  # noqa: E402
    DTMF_MESSAGE,
    GEMINI_LIVE_DEFAULT_VOICE,
    GEMINI_LIVE_MODEL_ID,
    MODEL_ALIASES,
    gemini_live_voice,
    is_gemini_live_model_id,
)
from pipecat_aplisay.gemini_service import (  # noqa: E402
    AplisayGeminiLiveLLMService,
    build_gemini_live_service,
)
from pipecat_aplisay.transcript_observer import TranscriptForwardingObserver  # noqa: E402
from pipecat_aplisay.transfer_prompts import HANDOVER_OPENING_INSTRUCTION  # noqa: E402
from pipecat_aplisay.usage import usage_vendors  # noqa: E402
from pipecat_aplisay.voice_mode import model_id_from_name  # noqa: E402

BARE = "gemini-2.5-flash-native-audio-preview-12-2025"
GEMINI = f"pipecat:{GEMINI_LIVE_MODEL_ID}"
RETIRED = "pipecat:google/gemini-2.0-flash-exp"
SYSTEM = "You are Sam."
GREETING = "Say exactly: Acme Dental, Sam speaking."
KICK = "Speak the following message verbatim: Are you still there?"
NEW_PROMPT = "You are Alex, the sales agent."

STOCK = gemini_live.GeminiLiveLLMService


# --- ids, aliases and options ------------------------------------------------------


def test_model_id_rules():
    assert is_gemini_live_model_id(GEMINI_LIVE_MODEL_ID) is True
    assert is_gemini_live_model_id("google/gemini-2.0-flash-exp") is True
    # the Gemini pipeline rows are not Live rows
    assert is_gemini_live_model_id("google/gemini-2.5-flash") is False
    assert is_gemini_live_model_id("openai/gpt-realtime") is False
    assert is_gemini_live_model_id(None) is False


def test_the_retired_id_runs_as_the_row_and_bills_on_it():
    assert MODEL_ALIASES == {"google/gemini-2.0-flash-exp": GEMINI_LIVE_MODEL_ID}
    assert model_id_from_name(RETIRED) == GEMINI_LIVE_MODEL_ID
    assert model_id_from_name(GEMINI) == GEMINI_LIVE_MODEL_ID
    assert model_id_from_name("pipecat:openai/gpt-realtime") == "openai/gpt-realtime"
    for name in (GEMINI, RETIRED):
        assert usage_vendors({}, name)["llm"] == {
            "vendor": "google", "model": GEMINI_LIVE_MODEL_ID, "authoritative": True,
        }


def test_voice_option():
    assert gemini_live_voice({"options": {"tts": {"voice": " Kore "}}}) == "Kore"
    assert gemini_live_voice({"options": {"tts": {"voice": ""}}}) == GEMINI_LIVE_DEFAULT_VOICE
    assert gemini_live_voice({}) == GEMINI_LIVE_DEFAULT_VOICE == "Charon"


def test_service_settings_carry_the_model_and_voice_and_no_language():
    llm = build_gemini_live_service(api_key="test-key", model=BARE, system_prompt=SYSTEM, voice="Kore")
    assert isinstance(llm, AplisayGeminiLiveLLMService)
    assert llm._settings.model == f"models/{BARE}"
    assert llm._settings.system_instruction == SYSTEM
    assert llm._settings.voice == "Kore"
    # Pipecat's default: native-audio Live models take no language code.
    assert llm._settings.language == "en-US"
    assert build_gemini_live_service(
        api_key="k", model=f"models/{BARE}", system_prompt=SYSTEM, voice="Puck"
    )._settings.model == f"models/{BARE}"


class _Stop(Exception):
    """Ends a session build at the point under test."""


@pytest.mark.parametrize("model_name", [GEMINI, RETIRED])
def test_build_voice_session_passes_the_rows_model_and_the_agents_voice(monkeypatch, model_name):
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    seen: dict = {}

    def fake_build(**kwargs):
        seen.update(kwargs)
        raise _Stop

    monkeypatch.setattr(gemini_service, "build_gemini_live_service", fake_build)
    agent = {"options": {"tts": {"voice": "Kore", "language": "en-GB"}, "stt": {"language": "en-GB"}}}
    with pytest.raises(_Stop):
        asyncio.run(
            voice_session.build_voice_session(
                transport=None, model_name=model_name, agent=agent, metadata={}, tools=[], system_prompt="sys"
            )
        )
    assert seen == {"api_key": "test-key", "model": BARE, "system_prompt": "sys", "voice": "Kore"}


# --- the live session, through a real aggregator pair ----------------------------------


class _Session:
    """Stands in for google-genai's ``AsyncSession``: records what the service sends."""

    def __init__(self) -> None:
        self.client_content: list[tuple[list, bool]] = []
        self.realtime_input: list[dict] = []
        self.closed = False

    async def send_client_content(self, *, turns=None, turn_complete: bool = True) -> None:
        self.client_content.append((list(turns or []), turn_complete))

    async def send_realtime_input(self, **kwargs) -> None:
        self.realtime_input.append(kwargs)

    async def close(self) -> None:
        self.closed = True


def _service(cls):
    if cls is AplisayGeminiLiveLLMService:
        return build_gemini_live_service(api_key="test-key", model=BARE, system_prompt=SYSTEM, voice="Kore")
    return cls(api_key="test-key", settings=cls.Settings(model=f"models/{BARE}", system_instruction=SYSTEM, voice="Kore"))


def _offline(llm) -> tuple[_Session, list[int]]:
    """Replace the connection with the fake session: ``setup()`` would otherwise
    open a websocket to Google. Every connect is counted."""
    session = _Session()
    connects: list[int] = []

    async def connect(session_resumption_handle=None) -> None:
        connects.append(1)
        await llm._handle_session_ready(session)

    llm._connect = connect
    return session, connects


def _turns(sent: tuple[list, bool]) -> list[tuple[str, str]]:
    turns, _complete = sent
    return [(turn.role, turn.parts[0].text) for turn in turns]


def _kick_frames() -> list:
    """Exactly what ``_wire_inactivity_kick`` queues on a realtime row."""
    return [LLMMessagesAppendFrame([{"role": "developer", "content": KICK}], run_llm=False), LLMRunFrame()]


async def _until(predicate: Callable[[], bool], timeout: float = 5.0) -> None:
    async def poll() -> None:
        while not predicate():
            await asyncio.sleep(0.01)

    await asyncio.wait_for(poll(), timeout)


class _Call:
    """A pipeline of the worker's DTMF aggregator, a real aggregator pair and
    ``llm``, the way the worker builds one, on the fake Live session. The
    greeting seeds it: the first context frame carries the system prompt and
    the greeting instruction. ``digits_through_service`` wires the DTMF
    aggregator to the service (the fix) instead of a ``TranscriptionFrame``."""

    def __init__(self, cls, *, digits_through_service: bool = False) -> None:
        self.context = LLMContext([{"role": "developer", "content": SYSTEM}], tools=ToolsSchema(standard_tools=[]))
        # Light strategies: the default stop strategy loads the smart-turn model.
        user, assistant = LLMContextAggregatorPair(
            self.context,
            user_params=LLMUserAggregatorParams(
                user_turn_strategies=UserTurnStrategies(
                    start=[VADUserTurnStartStrategy()], stop=[SpeechTimeoutUserTurnStopStrategy()]
                )
            ),
        )
        self.llm = _service(cls)
        self.session, self.connects = _offline(self.llm)
        dtmf = voice_session._dtmf_aggregator_for(
            {}, on_digits=self.llm.inject_dtmf if digits_through_service else None
        )
        # The worker's transcript observer, recording what it would log.
        self.rows: list[tuple[dict, bool]] = []

        async def record(payload: dict, *, is_final: bool) -> None:
            self.rows.append((payload, is_final))

        self.task = PipelineTask(
            Pipeline([dtmf, user, self.llm, assistant]),
            params=PipelineParams(),
            idle_timeout_secs=None,
            observers=[TranscriptForwardingObserver(record, mode="realtime")],
        )
        self.run: asyncio.Task | None = None

    def user_rows(self) -> list[tuple[str, bool]]:
        return [(payload["user"], is_final) for payload, is_final in self.rows if "user" in payload]

    async def __aenter__(self) -> "_Call":
        self.run = asyncio.create_task(PipelineRunner(handle_sigint=False).run(self.task))
        await self.task.queue_frames(
            [LLMMessagesAppendFrame([{"role": "developer", "content": GREETING}], run_llm=False), LLMRunFrame()]
        )
        await _until(lambda: len(self.session.client_content) == 1)
        return self

    async def __aexit__(self, *_exc) -> None:
        # Frames are processed in order, so once the EndFrame has passed the
        # service every frame queued before it has too.
        await self.task.queue_frame(EndFrame())
        try:
            await asyncio.wait_for(self.run, 10)
        except asyncio.TimeoutError:
            await self.task.cancel()
            raise


def _after(cls, frames: list, **call_options) -> _Call:
    """Run ``frames`` after the seed and return the call for inspection."""

    async def scenario() -> _Call:
        async with _Call(cls, **call_options) as call:
            await call.task.queue_frames(frames)
        return call

    return asyncio.run(asyncio.wait_for(scenario(), 20))


@pytest.mark.parametrize("cls", [STOCK, AplisayGeminiLiveLLMService], ids=["pipecat", "aplisay"])
def test_the_greeting_seeds_the_session_once(cls):
    call = _after(cls, [])
    assert call.connects == [1]
    [(turns, complete)] = call.session.client_content
    assert complete is True
    # the leading developer message is the prompt, the greeting instruction is
    # the last (user) turn the model answers
    assert turns[-1].role == "user" and turns[-1].parts[0].text == GREETING
    assert call.session.closed is True


def test_pipecat_service_never_hears_a_message_appended_after_the_seed():
    call = _after(STOCK, _kick_frames())
    # the aggregator added it and ran the LLM, as the frames ask
    assert [m.get("content") for m in call.context.get_messages()][-1] == KICK
    # nothing after the seed reached the Live session: the kick was silent
    assert len(call.session.client_content) == 1


def test_an_appended_instruction_is_sent_as_a_user_turn_that_completes():
    call = _after(AplisayGeminiLiveLLMService, _kick_frames())
    assert len(call.session.client_content) == 2
    assert _turns(call.session.client_content[1]) == [("user", KICK)]
    assert call.session.client_content[1][1] is True
    # the realtime nudge is a Gemini 3.x need; this is a 2.5 model
    assert call.session.realtime_input == []
    # the same instruction is not sent again on the next run
    assert call.llm._sent_messages == len(call.context.get_messages())


def test_user_and_assistant_messages_are_never_resent():
    frames = [
        LLMMessagesAppendFrame(
            [{"role": "user", "content": "I need an appointment"}, {"role": "assistant", "content": "Of course."}],
            run_llm=True,
        ),
        LLMMessagesAppendFrame([{"role": "developer", "content": [{"type": "text", "text": KICK}]}], run_llm=True),
    ]
    call = _after(AplisayGeminiLiveLLMService, frames)
    assert [_turns(sent) for sent in call.session.client_content[1:]] == [[("user", KICK)]]


def test_an_instruction_waits_for_the_end_of_the_bot_turn():
    from google.genai.types import LiveServerContent, LiveServerMessage

    async def scenario() -> _Call:
        async with _Call(AplisayGeminiLiveLLMService) as call:
            call.llm._bot_is_responding = True
            await call.task.queue_frames(_kick_frames())
            await _until(lambda: call.llm._held_instructions == [KICK])
            assert len(call.session.client_content) == 1, "a running generation is not interrupted"
            await call.llm._handle_msg_turn_complete(
                LiveServerMessage(server_content=LiveServerContent(turn_complete=True))
            )
            await _until(lambda: len(call.session.client_content) == 2)
            assert call.llm._held_instructions == []
        return call

    call = asyncio.run(asyncio.wait_for(scenario(), 20))
    assert _turns(call.session.client_content[1]) == [("user", KICK)]


def test_a_caller_interruption_drops_a_held_instruction():
    async def scenario() -> _Call:
        async with _Call(AplisayGeminiLiveLLMService) as call:
            call.llm._bot_is_responding = True
            await call.task.queue_frames(_kick_frames())
            await _until(lambda: call.llm._held_instructions == [KICK])
            await call.task.queue_frame(InterruptionFrame())
            await _until(lambda: call.llm._held_instructions == [] and not call.llm._bot_is_responding)
        return call

    call = asyncio.run(asyncio.wait_for(scenario(), 20))
    assert len(call.session.client_content) == 1


# --- keypad digits --------------------------------------------------------------------


def _keys(*buttons: KeypadEntry) -> list:
    return [InputDTMFFrame(button=button) for button in buttons]


@pytest.mark.parametrize("cls", [STOCK, AplisayGeminiLiveLLMService], ids=["pipecat", "aplisay"])
def test_digits_as_a_transcription_never_reach_the_live_session(cls):
    # The stock wiring: the aggregator turns the digits into a TranscriptionFrame,
    # then a user message, which the service never sends (the server holds
    # audio for the real user turns, and these have none).
    call = _after(cls, _keys(KeypadEntry.ONE, KeypadEntry.POUND))
    assert len(call.session.client_content) == 1


def test_digits_through_the_service_are_a_user_turn_that_completes():
    call = _after(
        AplisayGeminiLiveLLMService,
        _keys(KeypadEntry.ONE, KeypadEntry.TWO, KeypadEntry.POUND),
        digits_through_service=True,
    )
    assert len(call.session.client_content) == 2
    assert _turns(call.session.client_content[1]) == [("user", DTMF_MESSAGE.format(digits="12#"))]
    assert call.session.client_content[1][1] is True
    # the digits are not a context message, so the next run does not resend them
    assert call.llm._sent_messages == len(call.context.get_messages())


def test_digits_before_the_session_is_ready_are_dropped():
    llm = _service(AplisayGeminiLiveLLMService)
    asyncio.run(llm.inject_dtmf("1"))
    session = _Session()
    llm._session = session
    asyncio.run(llm.inject_dtmf("5"))
    assert [_turns(sent) for sent in session.client_content] == [[("user", DTMF_MESSAGE.format(digits="5"))]]


def test_build_voice_session_hands_the_digits_to_the_session_callback(monkeypatch):
    """The whole realtime build for the row, offline: the DTMF aggregator is
    wired to the call session's injected-digits callback, and the service is
    the subclass with the row's model and the agent's voice."""
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    # The default stop strategy loads the smart-turn model; keep it light.
    monkeypatch.setattr(voice_session, "_user_aggregator_params_for", lambda *_a, **_k: _light_params())
    seen: dict = {}
    real = voice_session._dtmf_aggregator_for

    def recording(agent, *, on_digits=None):
        seen["on_digits"] = on_digits
        return real(agent, on_digits=on_digits)

    monkeypatch.setattr(voice_session, "_dtmf_aggregator_for", recording)

    async def on_injected_dtmf(_digits: str) -> None:
        return None

    async def build():
        return await voice_session.build_voice_session(
            transport=_FakeTransport(),
            model_name=GEMINI,
            agent={"options": {"tts": {"voice": "Kore"}}},
            metadata={},
            tools=[],
            system_prompt=SYSTEM,
            on_injected_dtmf=on_injected_dtmf,
        )

    _task, _audio_buffer, _context, llm = asyncio.run(build())
    assert seen["on_digits"] is on_injected_dtmf
    assert isinstance(llm, AplisayGeminiLiveLLMService)
    assert llm._settings.model == f"models/{BARE}" and llm._settings.voice == "Kore"


def _light_params() -> LLMUserAggregatorParams:
    return LLMUserAggregatorParams(
        user_turn_strategies=UserTurnStrategies(
            start=[VADUserTurnStartStrategy()], stop=[SpeechTimeoutUserTurnStopStrategy()]
        )
    )


class _FakeTransport:
    """Enough of a transport for the realtime build: one input and one output processor."""

    def __init__(self) -> None:
        self._input = FrameProcessor(name="fake-input")
        self._output = FrameProcessor(name="fake-output")

    def input(self) -> FrameProcessor:
        return self._input

    def output(self) -> FrameProcessor:
        return self._output


# --- the caller's transcription ----------------------------------------------------------


def _heard(text: str):
    """An input transcription piece, as the Live API sends them."""
    from google.genai.types import LiveServerContent, LiveServerMessage, Transcription

    return LiveServerMessage(server_content=LiveServerContent(input_transcription=Transcription(text=text)))


def _model_audio():
    from google.genai.types import Blob, Content, LiveServerContent, LiveServerMessage, Part

    part = Part(inline_data=Blob(mime_type="audio/pcm;rate=24000", data=b"\x00" * 480))
    return LiveServerMessage(server_content=LiveServerContent(model_turn=Content(role="model", parts=[part])))


def _turn_complete():
    from google.genai.types import LiveServerContent, LiveServerMessage

    return LiveServerMessage(server_content=LiveServerContent(turn_complete=True))


FIRST = "Hi, I'd like to book an appointment."
SECOND = "Tomorrow if possible."
TURN = f"{FIRST} {SECOND}"


def _user_messages(call: _Call) -> list[str]:
    return [m["content"] for m in call.context.get_messages() if m.get("role") == "user"]


def _spoken_turn(cls) -> _Call:
    """The caller says two sentences, the model answers, its turn completes."""

    async def scenario() -> _Call:
        async with _Call(cls) as call:
            await call.llm._handle_msg_input_transcription(_heard(FIRST))
            await call.llm._handle_msg_input_transcription(_heard(f" {SECOND}"))
            await call.llm._handle_msg_model_turn(_model_audio())
            await call.llm._handle_msg_turn_complete(_turn_complete())
            # the aggregator writes the user message when the answer completes
            await _until(lambda: _user_messages(call) != [])
        return call

    return asyncio.run(asyncio.wait_for(scenario(), 20))


def test_pipecat_service_logs_a_user_row_per_sentence():
    call = _spoken_turn(STOCK)
    # two final rows for one turn, which the transcript reads as two turns
    assert call.user_rows() == [(FIRST, True), (SECOND, True)]
    # the context was never the problem: the aggregator joins the pieces
    assert _user_messages(call) == [TURN]


def test_one_user_row_per_turn_with_live_interims():
    call = _spoken_turn(AplisayGeminiLiveLLMService)
    # cumulative interim rows while the caller speaks, one final row when the
    # model answers, which is when the turn is over
    assert call.user_rows() == [(FIRST, False), (TURN, False), (TURN, True)]
    assert _user_messages(call) == [TURN]


def test_a_quiet_caller_turn_closes_without_an_answer(monkeypatch):
    monkeypatch.setattr(gemini_service, "USER_TRANSCRIPTION_IDLE_SECS", 0.05)

    async def scenario() -> _Call:
        async with _Call(AplisayGeminiLiveLLMService) as call:
            await call.llm._handle_msg_input_transcription(_heard(FIRST))
            await _until(lambda: (FIRST, True) in call.user_rows())
        return call

    call = asyncio.run(asyncio.wait_for(scenario(), 20))
    assert call.user_rows() == [(FIRST, False), (FIRST, True)]


def test_words_before_the_call_ends_get_their_row():
    async def scenario() -> _Call:
        async with _Call(AplisayGeminiLiveLLMService) as call:
            await call.llm._handle_msg_input_transcription(_heard(FIRST))
        return call

    call = asyncio.run(asyncio.wait_for(scenario(), 20))
    assert call.user_rows() == [(FIRST, False), (FIRST, True)]


# --- handover -------------------------------------------------------------------------


def _in_place_swap_frames() -> list:
    """Exactly what ``CallSession._apply_agent_transfer`` queues for a same-model handover."""
    tools = ToolsSchema(standard_tools=[FunctionSchema(name="book", description="book", properties={}, required=[])])
    return [
        LLMUpdateSettingsFrame(delta=LLMSettings(system_instruction=NEW_PROMPT)),
        LLMMessagesUpdateFrame(
            [{"role": "developer", "content": NEW_PROMPT}, {"role": "developer", "content": HANDOVER_OPENING_INSTRUCTION}],
            run_llm=False,
        ),
        LLMSetToolsFrame(tools=tools),
        LLMRunFrame(),
    ]


@pytest.mark.parametrize("cls", [STOCK, AplisayGeminiLiveLLMService], ids=["pipecat", "aplisay"])
def test_in_place_swap_frames_never_reach_the_live_session(cls):
    call = _after(cls, _in_place_swap_frames())
    # the new prompt is stored locally, the session was never rebuilt with it or
    # with the new tools, and the opening was never sent: the old agent stays
    assert call.llm._settings.system_instruction == NEW_PROMPT
    assert call.connects == [1]
    assert len(call.session.client_content) == 1


@pytest.mark.parametrize("current", [GEMINI, RETIRED])
@pytest.mark.parametrize("target", [GEMINI, RETIRED, None])
def test_gemini_rows_always_restart_on_handover(current, target):
    from pipecat_aplisay import api_client
    from pipecat_aplisay.call_session import CallSession

    call = api_client.CallRecord(id="c", userId="u", organisationId="o", instanceId="i", agentId="a", persisted=False)
    session = CallSession(
        session_id="s", agent={"id": "a", "modelName": current, "prompt": SYSTEM}, instance={}, call=call,
        sip_gateway=None, gateway_session=None,  # type: ignore[arg-type]
    )
    session._active_model_name = current
    new_agent = {"id": "x"} if target is None else {"id": "x", "modelName": target}
    assert session._needs_full_handover(new_agent) is True
    # an OpenAI Realtime row still swaps in place
    session.agent = {"modelName": "pipecat:openai/gpt-realtime"}
    session._active_model_name = "pipecat:openai/gpt-realtime"
    assert session._needs_full_handover({"modelName": "pipecat:openai/gpt-realtime"}) is False
