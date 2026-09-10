"""Text-output mode: a realtime model paired with an external TTS
(:mod:`pipecat_aplisay.realtime_tts`, :mod:`pipecat_aplisay.voice_session`,
:mod:`pipecat_aplisay.ultravox_compat`, :mod:`pipecat_aplisay.transcript_observer`).

Section 4.3 of docs/livekit-agent-architecture.md: when ``options.tts.vendor``
names a vendor other than the model's own provider, the realtime model emits
text and a discrete TTS speaks it. These tests lock:

* the vendor rule (unset / native / external, scoping and case ignored) and
  which providers this worker can run in text mode;
* the Ultravox /calls params: text medium and no Ultravox voice in text-output
  mode, the voice and default medium otherwise, the language hint either way;
* the user-aggregator params: a local VAD with VAD-driven turn strategies only
  on text-output sessions;
* the shim's text-medium transcript handling, measured against the real
  Ultravox frame shapes (2026-09-10 spike): first ``text`` snapshot, ``delta``
  frames, final ``text`` snapshot; a greeting as one final frame; a truncated
  final after a barge-in; and ``playback_clear_buffer`` raising an interruption;
* the transcript observer logging bot rows from the TTS on such sessions.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from pipecat.frames.frames import (
    AggregationType,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSTextFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService
from pipecat.services.tts_service import TTSService

from pipecat_aplisay import voice_session
from pipecat_aplisay.realtime_tts import (
    external_tts_vendor,
    local_vad_required,
    text_output_enabled,
    tts_vendor,
)
from pipecat_aplisay.transcript_observer import TranscriptForwardingObserver
from pipecat_aplisay.voice_session import (
    _openai_realtime_session_properties,
    _ultravox_one_shot_params,
    _user_aggregator_params_for,
)

ultravox_llm = pytest.importorskip("pipecat.services.ultravox.llm")


def _agent(tts=None, **options) -> dict:
    o = dict(options)
    if tts is not None:
        o["tts"] = tts
    return {"options": o}


# --- the rule -----------------------------------------------------------------


def test_unset_or_blank_vendor_means_the_models_own_voice():
    assert tts_vendor({"options": {}}) is None
    assert tts_vendor(_agent(tts={"vendor": "   "})) is None
    assert external_tts_vendor(_agent(tts={"voice": "Mark"}), "ultravox/ultravox-v0.7") is None


def test_the_providers_own_vendor_is_native():
    assert external_tts_vendor(_agent(tts={"vendor": "ultravox"}), "ultravox/ultravox-v0.7") is None
    assert external_tts_vendor(_agent(tts={"vendor": "openai"}), "openai/gpt-realtime") is None
    # google is a TTS vendor too, but on a Gemini row it is the model's own voice.
    assert external_tts_vendor(_agent(tts={"vendor": "google"}), "google/gemini-2.0-flash-exp") is None


def test_any_other_vendor_is_external():
    assert external_tts_vendor(_agent(tts={"vendor": "elevenlabs"}), "ultravox/ultravox-v0.7") == "elevenlabs"
    assert external_tts_vendor(_agent(tts={"vendor": "google"}), "ultravox/ultravox-v0.6") == "google"
    assert external_tts_vendor(_agent(tts={"vendor": "cartesia"}), "openai/gpt-realtime") == "cartesia"


def test_vendor_scoping_and_case_are_ignored():
    agent = _agent(tts={"vendor": "ElevenLabs/eleven_flash_v2_5"})
    assert external_tts_vendor(agent, "ultravox/ultravox-v0.7") == "elevenlabs"
    assert external_tts_vendor(_agent(tts={"vendor": "Ultravox"}), "ultravox/ultravox-v0.7") is None


def test_text_output_only_where_this_worker_supports_it():
    ext = _agent(tts={"vendor": "deepgram", "voice": "aura-asteria-en"})
    assert text_output_enabled(ext, "ultravox/ultravox-v0.7") is True
    assert text_output_enabled(ext, "ultravox/ultravox-v0.6-gemma3-27b") is True
    assert text_output_enabled(ext, "openai/gpt-realtime") is True
    # No Gemini Live model the API still serves accepts a TEXT modality, so the
    # same request on a Gemini row stays native (and the server rejects it).
    assert text_output_enabled(ext, "google/gemini-2.0-flash-exp") is False
    assert text_output_enabled(_agent(tts={"vendor": "ultravox"}), "ultravox/ultravox-v0.7") is False
    # A pipeline row's TTS is always discrete; the rule never applies there.
    assert text_output_enabled(ext, "openai/gpt-4o-mini") is False


def test_local_vad_only_where_the_service_emits_no_turn_frames():
    ext = _agent(tts={"vendor": "deepgram", "voice": "aura-asteria-en"})
    assert local_vad_required(ext, "ultravox/ultravox-v0.7") is True
    # OpenAI Realtime's server VAD broadcasts the interruption itself.
    assert local_vad_required(ext, "openai/gpt-realtime") is False
    assert local_vad_required(_agent(tts={"voice": "Mark"}), "ultravox/ultravox-v0.7") is False


# --- Ultravox /calls params -----------------------------------------------------


def test_text_output_params_use_the_text_medium_and_no_ultravox_voice(monkeypatch):
    monkeypatch.setenv("ULTRAVOX_API_KEY", "test-key")
    agent = _agent(
        tts={"vendor": "elevenlabs", "voice": "Rachel", "language": "en-GB"},
        greeting={"text": "Hello there"},
    )
    params = _ultravox_one_shot_params(agent, "sys", "ultravox-v0.7", text_output=True)
    assert params.output_medium == "text"
    # The voice belongs to the external TTS now, not to Ultravox.
    assert params.voice is None
    assert params.model == "ultravox-v0.7"
    # The greeting still rides firstSpeakerSettings: it arrives as text and the TTS speaks it.
    assert params.extra["firstSpeakerSettings"] == {"agent": {"text": "Hello there", "uninterruptible": True}}
    # The language is still the recognition hint for Ultravox's own ASR.
    assert params.extra["languageHint"] == "en-GB"


def test_native_params_keep_the_voice_and_the_default_medium(monkeypatch):
    monkeypatch.setenv("ULTRAVOX_API_KEY", "test-key")
    params = _ultravox_one_shot_params(_agent(tts={"voice": "Mark"}), "sys", "ultravox-v0.6", text_output=False)
    assert params.output_medium is None
    assert params.voice == "Mark"
    assert params.extra["firstSpeakerSettings"] == {"agent": {}}


# --- OpenAI Realtime session properties ---------------------------------------


def test_openai_text_output_session_has_text_modality_and_no_output_voice():
    props = _openai_realtime_session_properties(_agent(tts={"vendor": "elevenlabs", "voice": "Rachel"}), text_output=True)
    assert props.output_modalities == ["text"]
    assert props.audio.output is None
    # The caller's transcription stays on: it is how user rows reach the transaction log.
    assert props.audio.input.transcription is not None


def test_openai_native_session_keeps_the_voice_and_audio_output():
    props = _openai_realtime_session_properties(_agent(tts={"voice": "coral"}), text_output=False)
    assert props.output_modalities is None
    assert props.audio.output.voice == "coral"
    assert _openai_realtime_session_properties(_agent(), text_output=False).audio.output.voice == "alloy"


# --- user aggregator params -----------------------------------------------------


def test_text_output_sessions_get_a_local_vad_with_vad_turn_strategies(monkeypatch):
    from pipecat.turns.user_start import VADUserTurnStartStrategy
    from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy

    sentinel = object()
    monkeypatch.setattr(voice_session, "_local_vad_analyzer", lambda: sentinel)

    params = _user_aggregator_params_for(_agent(), local_vad=True)
    assert params is not None
    assert params.vad_analyzer is sentinel
    assert [type(s) for s in params.user_turn_strategies.start] == [VADUserTurnStartStrategy]
    assert [type(s) for s in params.user_turn_strategies.stop] == [SpeechTimeoutUserTurnStopStrategy]
    # Unrelated behaviour is untouched.
    assert params.user_mute_strategies == []
    assert params.user_idle_timeout == 0


def test_native_sessions_keep_the_previous_aggregator_params():
    assert _user_aggregator_params_for(_agent()) is None
    params = _user_aggregator_params_for(_agent(greeting={"text": "Hi"}))
    assert params.vad_analyzer is None
    assert params.user_turn_strategies is None
    assert len(params.user_mute_strategies) == 1


def test_local_vad_needs_a_deliberate_onset():
    # Close to Ultravox's own minimumInterruptionDuration (0.48s), so a cough does
    # not clear the TTS unless Ultravox would also have treated it as a turn.
    assert 0.3 <= voice_session.LOCAL_VAD_START_SECS <= 0.5


# --- the shim: text-medium agent transcripts ------------------------------------


def _new_service():
    """A real shim instance WITHOUT running __init__ (no socket / keys), with the
    frame and metrics plumbing the transcript handler touches stubbed out."""
    from pipecat_aplisay.ultravox_compat import AplisayUltravoxRealtimeLLMService

    llm = object.__new__(AplisayUltravoxRealtimeLLMService)
    llm._bot_responding = None
    llm._disconnecting = False
    llm.pushed = []

    async def push_frame(frame, direction=FrameDirection.DOWNSTREAM):
        llm.pushed.append(frame)

    async def noop(*_args, **_kwargs):
        return None

    llm.push_frame = push_frame
    llm.start_processing_metrics = noop
    llm.stop_processing_metrics = noop
    llm.stop_ttfb_metrics = noop
    return llm


def _texts(frames) -> list[str]:
    return [f.text for f in frames if isinstance(f, LLMTextFrame)]


def _drive(llm, *frames) -> None:
    async def run():
        for medium, text, delta, final in frames:
            await llm._handle_agent_transcript(medium, text, delta, final)

    asyncio.run(run())


def test_a_streamed_turn_pushes_each_chunk_exactly_once():
    llm = _new_service()
    # Measured shape: first frame is a `text` snapshot of the first token, then
    # deltas, then a final `text` snapshot of the whole turn.
    _drive(
        llm,
        ("text", "In", None, False),
        ("text", None, " a", False),
        ("text", None, " small", False),
        ("text", "In a small", None, True),
    )
    assert _texts(llm.pushed) == ["In", " a", " small"]
    assert isinstance(llm.pushed[0], LLMFullResponseStartFrame)
    assert isinstance(llm.pushed[-1], LLMFullResponseEndFrame)
    assert llm._bot_responding is None
    assert llm._text_turn_streamed == ""


def test_a_greeting_arriving_as_one_final_frame_is_still_spoken():
    llm = _new_service()
    _drive(llm, ("text", "Hello, this is the greeting.", None, True))
    assert [type(f) for f in llm.pushed] == [LLMFullResponseStartFrame, LLMTextFrame, LLMFullResponseEndFrame]
    assert _texts(llm.pushed) == ["Hello, this is the greeting."]


def test_a_truncated_final_after_a_barge_in_pushes_nothing_more():
    llm = _new_service()
    _drive(
        llm,
        ("text", "Once", None, False),
        ("text", None, " upon", None or False),
        ("text", "Once", None, True),
    )
    assert _texts(llm.pushed) == ["Once", " upon"]
    assert isinstance(llm.pushed[-1], LLMFullResponseEndFrame)


def test_a_mid_turn_snapshot_pushes_only_the_new_part():
    llm = _new_service()
    _drive(
        llm,
        ("text", "The", None, False),
        ("text", None, " cat", False),
        ("text", "The cat sat", None, False),
        ("text", "The cat sat", None, True),
    )
    assert _texts(llm.pushed) == ["The", " cat", " sat"]


def test_voice_medium_is_left_to_upstream(monkeypatch):
    calls = []

    async def upstream(self, medium, text, delta, final):
        calls.append((medium, text, delta, final))

    monkeypatch.setattr(ultravox_llm.UltravoxRealtimeLLMService, "_handle_agent_transcript", upstream)
    llm = _new_service()
    _drive(llm, ("voice", None, "hello", False))
    assert calls == [("voice", None, "hello", False)]
    assert llm.pushed == []


class _Socket:
    """An async iterable standing in for the Ultravox websocket."""

    def __init__(self, messages):
        self._messages = list(messages)

    def __aiter__(self):
        return self

    async def __anext__(self):
        if not self._messages:
            raise StopAsyncIteration
        return self._messages.pop(0)


def test_playback_clear_buffer_broadcasts_an_interruption():
    llm = _new_service()
    interruptions = []

    async def broadcast_interruption():
        interruptions.append(True)

    llm.broadcast_interruption = broadcast_interruption
    llm._socket = _Socket([json.dumps({"type": "playback_clear_buffer"}), json.dumps({"type": "state", "state": "listening"})])
    asyncio.run(llm._receive_messages())
    assert interruptions == [True]


# --- transcript observer --------------------------------------------------------


class _FakeTTS(TTSService):
    """A concrete TTSService so a frame can be attributed to a TTS source."""

    async def run_tts(self, text: str):  # pragma: no cover - never driven
        if False:
            yield None


def _push(observer, *frames, source) -> None:
    async def run():
        for fr in frames:
            await observer.on_push_frame(
                FramePushed(
                    source=source, destination=None, frame=fr,
                    direction=FrameDirection.DOWNSTREAM, timestamp=0,
                )
            )

    asyncio.run(run())


def test_text_output_sessions_log_bot_rows_from_the_tts_not_the_model():
    sent = []

    async def send_message(message, *, is_final):
        sent.append((message, is_final))

    observer = TranscriptForwardingObserver(send_message, mode="realtime", bot_text_from="tts")
    # The model's own text is what the TTS speaks; logging it too would double up,
    # and after a barge-in it would record words the caller never heard.
    _push(observer, LLMTextFrame(text="ignored"), source=object.__new__(LLMService))
    assert sent == []
    _push(observer, TTSTextFrame(text="Hello there.", aggregated_by=AggregationType.SENTENCE), source=object.__new__(_FakeTTS))
    assert sent == [({"agent": "Hello there."}, False)]


def test_native_realtime_sessions_still_log_the_models_text():
    sent = []

    async def send_message(message, *, is_final):
        sent.append((message, is_final))

    observer = TranscriptForwardingObserver(send_message, mode="realtime")
    _push(observer, TTSTextFrame(text="ignored", aggregated_by=AggregationType.SENTENCE), source=object.__new__(_FakeTTS))
    assert sent == []
    _push(observer, LLMTextFrame(text="Hello"), source=object.__new__(LLMService))
    assert sent == [({"agent": "Hello"}, False)]
