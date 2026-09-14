"""Offline prototype checks against the installed Pipecat Live event types."""

import asyncio
from unittest.mock import AsyncMock

import pytest
from pipecat.audio.vad.vad_analyzer import VADState
from pipecat.frames.frames import (
    AggregationType,
    BotStoppedSpeakingFrame,
    InputAudioRawFrame,
    InterruptionFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.openai.live import events

from pipecat_aplisay.gpt_live_service import AplisayOpenAILiveLLMService, build_gpt_live_service
from pipecat_aplisay.gpt_live_transcript_tts import GptLiveTranscriptTtsService
from pipecat_aplisay.realtime_tts import external_tts_enabled, text_output_enabled, transcript_tts_enabled


class Vad:
    def __init__(self):
        self.state = VADState.QUIET
        self.audio = []
        self.cleaned = False

    def set_sample_rate(self, rate):
        self.rate = rate

    async def analyze_audio(self, audio):
        self.audio.append(audio)
        return self.state

    async def cleanup(self):
        self.cleaned = True


@pytest.fixture
def service(monkeypatch):
    vad = Vad()
    llm = GptLiveTranscriptTtsService(api_key="test", vad_analyzer=vad)
    pushed = []

    async def push(_self, frame, direction=FrameDirection.DOWNSTREAM):
        pushed.append((frame, direction))

    monkeypatch.setattr(AplisayOpenAILiveLLMService, "push_frame", push)
    monkeypatch.setattr(llm, "_restart_turn_timer", AsyncMock())
    return llm, vad, pushed


def test_opt_in_does_not_claim_a_text_modality():
    agent = {"options": {"tts": {"vendor": "deepgram", "experimentalTranscript": True}}}
    assert transcript_tts_enabled(agent, "openai/gpt-live-1")
    assert external_tts_enabled(agent, "openai/gpt-live-1")
    assert not text_output_enabled(agent, "openai/gpt-live-1")
    assert not transcript_tts_enabled(agent, "openai/gpt-realtime")
    assert not transcript_tts_enabled(agent, "google/gemini-2.0-flash-exp")
    for value in (False, None, "true", 1):
        agent["options"]["tts"]["experimentalTranscript"] = value
        assert not external_tts_enabled(agent, "openai/gpt-live-1")
    agent["options"]["tts"].update(experimentalTranscript=True, vendor="openai")
    assert not transcript_tts_enabled(agent, "openai/gpt-live-1")


def test_native_audio_is_discarded_and_caption_fragments_emitted_exactly_once(service):
    llm, _, pushed = service

    async def run():
        # Invalid base64 proves the unused audio is not even decoded.
        await llm._handle_evt_audio_delta(events.OutputAudioDeltaEvent(type="session.output_audio.delta", delta="!"))
        for i, text in enumerate(["Hel", "lo", " there."]):
            await llm._handle_evt_transcript_delta(events.TranscriptDeltaEvent(
                type="session.output_transcript.delta", delta=text, start_ms=i * 100, end_ms=(i + 1) * 100,
            ))
        await llm._end_turn("assistant")

    asyncio.run(run())
    frames = [f for f, _ in pushed]
    assert [type(f) for f in frames] == [
        LLMFullResponseStartFrame, LLMTextFrame, LLMTextFrame, LLMTextFrame, LLMFullResponseEndFrame,
    ]
    assert "".join(f.text for f in frames if isinstance(f, LLMTextFrame)) == "Hello there."
    assert all(f.append_to_context for f in frames if isinstance(f, LLMTextFrame))


def test_upstream_tts_notifications_are_not_swallowed(service):
    llm, _, pushed = service

    async def run():
        for frame in (TTSStartedFrame(), TTSStoppedFrame(), TTSTextFrame("native", aggregated_by=AggregationType.SENTENCE)):
            await llm.push_frame(frame)
            await llm.push_frame(frame, FrameDirection.UPSTREAM)

    asyncio.run(run())
    assert len(pushed) == 3
    assert all(direction == FrameDirection.UPSTREAM for _, direction in pushed)


def test_barge_in_clears_tts_without_cancelling_delegation_and_discards_old_turn(service, monkeypatch):
    llm, vad, pushed = service
    sent_audio = AsyncMock()
    monkeypatch.setattr(AplisayOpenAILiveLLMService, "_send_user_audio", sent_audio)
    # No incoming InterruptionFrame is processed by LLMService (which would
    # cancel tools); only the downstream pipeline receives it.
    process = AsyncMock()
    monkeypatch.setattr(AplisayOpenAILiveLLMService, "process_frame", process)
    audio = InputAudioRawFrame(audio=b"\x01\x00" * 320, sample_rate=16000, num_channels=1)

    async def run():
        llm._assistant_turn.open = True
        vad.state = VADState.SPEAKING
        await llm._send_user_audio(audio)
        await llm._send_user_audio(audio)
        await llm._push_assistant_text("old speech during interruption")
        vad.state = VADState.QUIET
        await llm._send_user_audio(audio)
        await llm._push_assistant_text("old speech after user stops")
        await llm._end_turn("assistant")
        await llm._open_turn("assistant")
        await llm._push_assistant_text("New reply.")

    asyncio.run(run())
    assert sent_audio.await_count == 3
    process.assert_not_called()
    assert len([f for f, _ in pushed if isinstance(f, InterruptionFrame)]) == 1
    assert [f.text for f, _ in pushed if isinstance(f, LLMTextFrame)] == ["New reply."]
    assert all(direction == FrameDirection.DOWNSTREAM for _, direction in pushed)


def test_late_timestamped_caption_does_not_restart_speech(service):
    llm, _, pushed = service
    llm._discard_through_ms = 2000

    async def run():
        for end, text in [(1900, "stale"), (2100, "Fresh reply.")]:
            evt = events.TranscriptDeltaEvent(type="session.output_transcript.delta", delta=text, end_ms=end)
            await llm._append_turn("assistant", text, text, evt)

    asyncio.run(run())
    assert [f.text for f, _ in pushed] == ["Fresh reply."]


def test_user_transcript_after_local_speech_stops_still_sets_discard_timestamp(service, monkeypatch):
    llm, _, _ = service
    llm._awaiting_user_transcript = True
    llm._vad_speaking = False
    monkeypatch.setattr(llm, "_push_interim_transcription", AsyncMock())
    event = events.TranscriptDeltaEvent(type="session.input_transcript.delta", delta="Wait.", end_ms=1200)
    asyncio.run(llm._append_turn("user", "Wait.", "Wait.", event))
    assert llm._discard_through_ms == 1200


def test_greeting_guard_waits_for_external_playback(service, monkeypatch):
    llm, vad, _ = service
    monkeypatch.setattr(AplisayOpenAILiveLLMService, "process_frame", AsyncMock())
    monkeypatch.setattr(AplisayOpenAILiveLLMService, "_send_user_audio", AsyncMock())

    async def run():
        deadline = asyncio.get_running_loop().time() + 20
        llm._greeting_guard_until = deadline
        llm._assistant_turn.open = True
        await llm._send_user_audio(InputAudioRawFrame(audio=b"\0" * 640, sample_rate=16000, num_channels=1))
        assert vad.audio == []  # caller cannot clear greeting TTS
        await llm.process_frame(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)
        assert llm.greeting_guard_active
        await llm._end_turn("assistant")
        assert llm._greeting_guard_until == deadline
        await llm.process_frame(BotStoppedSpeakingFrame(), FrameDirection.UPSTREAM)
        assert not llm.greeting_guard_active

    asyncio.run(run())


def test_factory_keeps_external_voice_out_of_live_session(monkeypatch):
    from pipecat_aplisay import voice_session
    from pipecat_aplisay.gpt_live import DelegateSpec, GptLiveSession
    from pipecat.processors.aggregators.llm_context import LLMContext

    monkeypatch.setattr(voice_session, "_local_vad_analyzer", Vad)
    session = GptLiveSession(
        delegate=DelegateSpec(agent={"modelName": "text:openai/gpt-5.6-luna"}, synthetic=True, mode="responses"),
        voice_instructions="VOICE", backend_instructions="BACKEND", tools=[], settings={}, overrides={},
    )
    llm = build_gpt_live_service(api_key="test", voice="aura-athena-en", session=session, transcript_tts=True)
    assert isinstance(llm, GptLiveTranscriptTtsService)
    llm._context = LLMContext([])
    llm._ws_send = AsyncMock()
    asyncio.run(llm._send_session_config())
    payload = llm._ws_send.call_args.args[0]["session"]
    assert payload["audio"]["output"]["voice"] == "marin"
    assert "modalities" not in payload and "output_modalities" not in payload
    assert payload["delegation"]["type"] == "responses"


def test_vad_handles_24khz_input_and_is_cleaned_up(service, monkeypatch):
    llm, vad, _ = service
    monkeypatch.setattr(AplisayOpenAILiveLLMService, "_send_user_audio", AsyncMock())
    monkeypatch.setattr(AplisayOpenAILiveLLMService, "cleanup", AsyncMock())

    async def run():
        await llm._send_user_audio(InputAudioRawFrame(audio=b"\0" * 4800, sample_rate=24000, num_channels=1))
        assert vad.rate == 16000
        assert vad.audio and len(vad.audio[0]) < 4800
        await llm.cleanup()
        assert vad.cleaned

    asyncio.run(run())


def test_replayed_live_events_flow_through_real_tts_pipeline_once(monkeypatch):
    from pipecat.frames.frames import DataFrame, TTSAudioRawFrame, SpeechOutputAudioRawFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.services.tts_service import TTSService
    from pipecat.tests.utils import run_test
    from pipecat_aplisay.transcript_observer import TranscriptForwardingObserver

    class Replay(DataFrame):
        pass

    class ReplayLive(GptLiveTranscriptTtsService):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, Replay):
                await self._handle_evt_audio_delta(events.OutputAudioDeltaEvent(type="session.output_audio.delta", delta="!"))
                for text in ["Hel", "lo", " there."]:
                    await self._handle_evt_transcript_delta(events.TranscriptDeltaEvent(
                        type="session.output_transcript.delta", delta=text,
                    ))
                await self._close_turn("assistant")

    spoken = []

    class FakeTts(TTSService):
        def __init__(self):
            super().__init__(sample_rate=16000, push_start_frame=True, push_stop_frames=True)

        async def run_tts(self, text, context_id):
            spoken.append(text)
            yield TTSAudioRawFrame(audio=b"\x01\x00" * 320, sample_rate=16000, num_channels=1)

    async def run():
        llm = ReplayLive(api_key="test", vad_analyzer=Vad())
        monkeypatch.setattr(llm, "_connect", AsyncMock())
        messages = []

        async def record(message, **kwargs):
            messages.append(message)

        observer = TranscriptForwardingObserver(record, mode="realtime", bot_text_from="tts")
        down, _ = await run_test(
            Pipeline([llm, FakeTts()]), frames_to_send=[Replay()], observers=[observer],
        )
        assert not any(isinstance(f, SpeechOutputAudioRawFrame) for f in down)
        assert len([f for f in down if isinstance(f, TTSAudioRawFrame)]) == 1
        assert [f.text for f in down if isinstance(f, TTSTextFrame)] == ["Hello there."]
        assert len([f for f in down if isinstance(f, TTSStartedFrame)]) == 1
        assert len([f for f in down if isinstance(f, TTSStoppedFrame)]) == 1
        assert messages  # bot audit observer sees only the real TTS source

    asyncio.run(run())
    assert spoken == ["Hello there."]
