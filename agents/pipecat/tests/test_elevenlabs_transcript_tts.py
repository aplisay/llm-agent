"""Offline streaming and cancellation regressions using Pipecat's real queues."""

import asyncio
from unittest.mock import AsyncMock

from pipecat.frames.frames import (
    BotStartedSpeakingFrame, InterruptionFrame, LLMFullResponseEndFrame,
    LLMFullResponseStartFrame, LLMTextFrame, TTSAudioRawFrame, TTSStartedFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.tests.utils import SleepFrame, run_test

from pipecat_aplisay.elevenlabs_transcript_tts import ElevenLabsTranscriptTTSService, _PhraseDeadline
from pipecat_aplisay.transcript_tts_latency import TRACE_KEY, TranscriptTtsPlaybackProbe, TranscriptTtsTrace


def recording_service(monkeypatch):
    service = ElevenLabsTranscriptTTSService(
        api_key="test", first_phrase_secs=0.02, following_phrase_secs=0.04,
    )
    monkeypatch.setattr(service, "_connect", AsyncMock())
    monkeypatch.setattr(service, "_disconnect", AsyncMock())
    monkeypatch.setattr(service, "_push_tts_frames", AsyncMock())
    return service


def texts(service):
    return [call.args[0].text for call in service._push_tts_frames.call_args_list]


def test_deadline_sends_complete_words_before_response_end(monkeypatch):
    service = recording_service(monkeypatch)

    async def run():
        await run_test(service, frames_to_send=[
            LLMFullResponseStartFrame(), LLMTextFrame("Hello wor"), SleepFrame(0.08),
            LLMTextFrame("ld"), SleepFrame(0.08), LLMTextFrame(" again."),
            LLMFullResponseEndFrame(),
        ])

    asyncio.run(run())
    assert texts(service) == ["Hello ", "world again."]
    assert service._deadline is None


def test_punctuation_streams_first_phrase_and_retains_fragment_spacing(monkeypatch):
    service = recording_service(monkeypatch)
    asyncio.run(run_test(service, frames_to_send=[
        LLMFullResponseStartFrame(), LLMTextFrame("Hel"), LLMTextFrame("lo,"),
        SleepFrame(0.04), LLMTextFrame(" I can help"), LLMTextFrame(" you."),
        LLMFullResponseEndFrame(),
    ]))
    assert texts(service) == ["Hello,", " I can help you."]
    assert service._auto_mode is True


def test_final_unpunctuated_fragment_is_flushed_once(monkeypatch):
    service = recording_service(monkeypatch)
    asyncio.run(run_test(service, frames_to_send=[
        LLMFullResponseStartFrame(), LLMTextFrame("Goodbye"), LLMFullResponseEndFrame(),
    ]))
    assert texts(service) == ["Goodbye"]


def test_interruption_invalidates_queued_deadline_and_buffer(monkeypatch):
    service = recording_service(monkeypatch)
    asyncio.run(run_test(service, frames_to_send=[
        LLMFullResponseStartFrame(), LLMTextFrame("Old"), SleepFrame(0.04),
        InterruptionFrame(), SleepFrame(0.04), _PhraseDeadline(0),
        LLMFullResponseStartFrame(), LLMTextFrame("New answer."), LLMFullResponseEndFrame(),
    ]))
    assert texts(service) == ["New answer."]
    assert service._deadline is None


def test_factory_scopes_fast_path_to_explicit_transcript_mode(monkeypatch):
    from pipecat_aplisay.voice_session import build_tts_service

    monkeypatch.setenv("ELEVENLABS_API_KEY", "test")
    agent = {"options": {"tts": {"vendor": "elevenlabs", "voice": "voice-id"}}}
    normal = build_tts_service(agent)
    fast = build_tts_service(agent, transcript_tts=True)
    assert type(normal) is ElevenLabsTTSService
    assert isinstance(fast, ElevenLabsTranscriptTTSService)
    assert fast._auto_mode and fast._settings.model == "eleven_flash_v2_5"
    assert fast._settings.voice == "voice-id"


def test_latency_follows_context_and_playback_not_synthesis_notification(monkeypatch):
    service = recording_service(monkeypatch)
    # Exercise the real context hooks; only replace provider I/O and queues.
    monkeypatch.setattr(ElevenLabsTTSService, "on_turn_context_created", AsyncMock())
    monkeypatch.setattr(ElevenLabsTTSService, "append_to_audio_context", AsyncMock())
    monkeypatch.setattr(ElevenLabsTTSService, "push_frame", AsyncMock())

    async def fake_run(self, text, context_id):
        yield None

    monkeypatch.setattr(ElevenLabsTTSService, "run_tts", fake_run)
    probe = TranscriptTtsPlaybackProbe()
    monkeypatch.setattr(probe, "push_frame", AsyncMock())
    trace = TranscriptTtsTrace()

    async def run():
        trace.mark("first_transcript")
        service._trace = trace
        await service.on_turn_context_created("first")
        async for _ in service.run_tts("Hello", "first"):
            pass
        # A subsequent response must not steal the first response's audio timing.
        service._trace = TranscriptTtsTrace()
        await service.append_to_audio_context("first", TTSAudioRawFrame(b"\1\0" * 320, 16000, 1))
        start = TTSStartedFrame(context_id="first")
        await service.push_frame(start)
        assert start.metadata[TRACE_KEY] is trace
        await probe.process_frame(start, FrameDirection.DOWNSTREAM)
        await probe.process_frame(BotStartedSpeakingFrame(), FrameDirection.DOWNSTREAM)
        assert "playback_start" not in trace.stages
        # Transport rebuilt the audio frame, dropping metadata/context_id.
        audio = TTSAudioRawFrame(b"\1\0" * 320, 16000, 1)
        await probe.process_frame(audio, FrameDirection.DOWNSTREAM)
        first_playback = trace.stages["playback_start"]
        await probe.process_frame(audio, FrameDirection.DOWNSTREAM)
        assert trace.stages["playback_start"] == first_playback

    asyncio.run(run())
    assert list(trace.stages) == ["first_transcript", "first_tts_submission", "first_audio", "playback_start"]
    assert list(trace.stages.values()) == sorted(trace.stages.values())


def test_real_elevenlabs_pipeline_submits_and_plays_before_live_turn_ends(monkeypatch):
    from types import SimpleNamespace
    from pipecat.frames.frames import DataFrame, TTSStoppedFrame
    from pipecat.processors.frame_processor import FrameProcessor
    from pipecat.transports.base_output import BaseOutputTransport
    from pipecat.transports.base_transport import TransportParams
    from websockets.protocol import State

    class Replay(DataFrame):
        pass

    submitted = asyncio.Event()
    played = asyncio.Event()
    trace = TranscriptTtsTrace()
    requests = []

    class Output(BaseOutputTransport):
        async def start(self, frame):
            await super().start(frame)
            await self.set_transport_ready(frame)

        async def write_audio_frame(self, frame):
            if isinstance(frame, TTSAudioRawFrame):
                played.set()
            return True

    class Source(FrameProcessor):
        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, Replay):
                start = LLMFullResponseStartFrame()
                start.metadata[TRACE_KEY] = trace
                await self.push_frame(start)
                trace.mark("first_transcript")
                await self.push_frame(LLMTextFrame("Hello wor"))
                # With sentence aggregation this times out: no punctuation or
                # turn-end frame has arrived, but we already need speech.
                await asyncio.wait_for(submitted.wait(), 1)
                await asyncio.wait_for(played.wait(), 1)
                await self.push_frame(LLMTextFrame("ld."))
                await self.push_frame(LLMFullResponseEndFrame())
            else:
                await self.push_frame(frame, direction)

    async def run():
        service = ElevenLabsTranscriptTTSService(api_key="test", first_phrase_secs=0.02)
        service._websocket = SimpleNamespace(state=State.OPEN)
        monkeypatch.setattr(service, "_connect", AsyncMock())
        monkeypatch.setattr(service, "_disconnect", AsyncMock())
        monkeypatch.setattr(service, "_send_context_init", AsyncMock())
        monkeypatch.setattr(service, "flush_audio", AsyncMock())

        async def send_text(text, context_id):
            requests.append((text, context_id))
            submitted.set()
            await service.append_to_audio_context(
                context_id, TTSAudioRawFrame(b"\1\0" * 640, 16000, 1, context_id=context_id),
            )

        async def close(context_id):
            await service.append_to_audio_context(context_id, TTSStoppedFrame(context_id=context_id))
            await service.remove_audio_context(context_id)

        monkeypatch.setattr(service, "_send_text", send_text)
        monkeypatch.setattr(service, "_close_context", close)
        output = Output(TransportParams(audio_out_enabled=True, audio_out_sample_rate=16000))
        down, _ = await run_test(Pipeline([
            Source(), service, output, TranscriptTtsPlaybackProbe(),
        ]), frames_to_send=[Replay()])
        assert len([f for f in down if isinstance(f, TTSStartedFrame)]) == 1
        assert "first_audio" in trace.stages and "playback_start" in trace.stages
        assert trace.stages["playback_start"] >= trace.stages["first_audio"]

    asyncio.run(run())
    assert [text for text, _ in requests] == ["Hello ", "world."]
    assert len({context for _, context in requests}) == 1


def test_number_and_title_punctuation_do_not_split_the_first_phrase(monkeypatch):
    service = recording_service(monkeypatch)
    asyncio.run(run_test(service, frames_to_send=[
        LLMFullResponseStartFrame(), LLMTextFrame("Dr."), LLMTextFrame(" Smith, "),
        LLMTextFrame("that's 1,"), LLMTextFrame("250."), LLMTextFrame("50."),
        LLMFullResponseEndFrame(),
    ]))
    assert "".join(texts(service)) == "Dr. Smith, that's 1,250.50."
    assert any("1,250.50." in text for text in texts(service))


def test_cancel_drops_unspoken_fragment_and_cleans_deadline(monkeypatch):
    from pipecat.frames.frames import CancelFrame

    service = recording_service(monkeypatch)
    asyncio.run(run_test(service, frames_to_send=[
        LLMFullResponseStartFrame(), LLMTextFrame("Unfinished"), SleepFrame(0.005), CancelFrame(),
    ], send_end_frame=False))
    assert texts(service) == []
    assert service._deadline is None
