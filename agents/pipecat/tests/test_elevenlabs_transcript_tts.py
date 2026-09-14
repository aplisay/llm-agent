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

from pipecat_aplisay.elevenlabs_transcript_tts import ElevenLabsTranscriptTTSService
from pipecat_aplisay.transcript_tts_latency import TRACE_KEY, TranscriptTtsPlaybackProbe, TranscriptTtsTrace


def recording_service(monkeypatch):
    service = ElevenLabsTranscriptTTSService(api_key="test")
    monkeypatch.setattr(service, "_connect", AsyncMock())
    monkeypatch.setattr(service, "_disconnect", AsyncMock())
    monkeypatch.setattr(service, "_push_tts_frames", AsyncMock())
    return service


def texts(service):
    return [call.args[0].text for call in service._push_tts_frames.call_args_list]


def test_fragments_bypass_local_aggregation_and_preserve_split_words(monkeypatch):
    service = recording_service(monkeypatch)
    fragments = ["Hel", "lo", " ", "world", ".", " Dr.", " Smith owes 1,", "250.50"]
    asyncio.run(run_test(service, frames_to_send=[
        LLMFullResponseStartFrame(), *[LLMTextFrame(text) for text in fragments],
        LLMFullResponseEndFrame(),
    ]))
    assert texts(service) == fragments


def test_factory_scopes_fast_path_to_explicit_transcript_mode(monkeypatch):
    from pipecat_aplisay.voice_session import build_tts_service

    monkeypatch.setenv("ELEVENLABS_API_KEY", "test")
    agent = {"options": {"tts": {"vendor": "elevenlabs", "voice": "voice-id"}}}
    normal = build_tts_service(agent)
    fast = build_tts_service(agent, transcript_tts=True)
    assert type(normal) is ElevenLabsTTSService
    assert isinstance(fast, ElevenLabsTranscriptTTSService)
    assert fast._auto_mode is False
    assert fast._settings.model == "eleven_flash_v2_5"
    assert "auto_mode=false" in fast._build_websocket_url()
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
    import json
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
                # Forward partial text without a local timer or sentence wait.
                await asyncio.wait_for(submitted.wait(), 1)
                assert "first_audio" not in trace.stages
                await self.push_frame(LLMTextFrame("ld."))
                await asyncio.wait_for(played.wait(), 1)
                await self.push_frame(LLMFullResponseEndFrame())
            else:
                await self.push_frame(frame, direction)

    async def run():
        service = ElevenLabsTranscriptTTSService(api_key="test")
        messages = []

        class Socket:
            state = State.OPEN

            async def send(self, message):
                payload = json.loads(message)
                messages.append(payload)
                context_id = payload["context_id"]
                if payload.get("text", "").strip():
                    await send_text(payload["text"], context_id)
                if payload.get("close_context"):
                    await close(context_id)

        service._websocket = Socket()
        monkeypatch.setattr(service, "_connect", AsyncMock())
        monkeypatch.setattr(service, "_disconnect", AsyncMock())

        async def send_text(text, context_id):
            requests.append((text, context_id))
            submitted.set()
            # Simulate a provider waiting for more text before emitting audio.
            if len(requests) >= 2:
                await service.append_to_audio_context(
                    context_id, TTSAudioRawFrame(b"\1\0" * 640, 16000, 1, context_id=context_id),
                )

        async def close(context_id):
            await service.append_to_audio_context(context_id, TTSStoppedFrame(context_id=context_id))
            await service.remove_audio_context(context_id)

        output = Output(TransportParams(audio_out_enabled=True, audio_out_sample_rate=16000))
        down, _ = await run_test(Pipeline([
            Source(), service, output, TranscriptTtsPlaybackProbe(),
        ]), frames_to_send=[Replay()])
        flushes = [i for i, m in enumerate(messages) if m.get("flush")]
        text_messages = [i for i, m in enumerate(messages) if m.get("text", "").strip()]
        assert len(flushes) == 1 and flushes[0] > max(text_messages)
        assert messages[-1].get("close_context") is True
        assert len([f for f in down if isinstance(f, TTSStartedFrame)]) == 1
        assert "first_audio" in trace.stages and "playback_start" in trace.stages
        assert trace.stages["playback_start"] >= trace.stages["first_audio"]

    asyncio.run(run())
    assert [text for text, _ in requests] == ["Hello wor", "ld."]
    assert len({context for _, context in requests}) == 1



def test_interruption_closes_buffered_context_without_flushing_it(monkeypatch):
    import json
    from pipecat.frames.frames import TTSStoppedFrame
    from websockets.protocol import State
    from pipecat.transports.base_output import BaseOutputTransport
    from pipecat.transports.base_transport import TransportParams

    class Output(BaseOutputTransport):
        async def start(self, frame):
            await super().start(frame)
            await self.set_transport_ready(frame)

        async def write_audio_frame(self, frame):
            return True

    async def run():
        service = ElevenLabsTranscriptTTSService(api_key="test")
        messages = []

        class Socket:
            state = State.OPEN

            async def send(self, message):
                payload = json.loads(message)
                messages.append(payload)
                context_id = payload["context_id"]
                if payload.get("flush"):
                    # The short answer stays buffered until turn completion.
                    await service.append_to_audio_context(
                        context_id, TTSAudioRawFrame(b"\1\0" * 640, 16000, 1, context_id=context_id),
                    )
                    await service.append_to_audio_context(context_id, TTSStoppedFrame(context_id=context_id))
                    await service.remove_audio_context(context_id)

        service._websocket = Socket()
        monkeypatch.setattr(service, "_connect", AsyncMock())
        monkeypatch.setattr(service, "_disconnect", AsyncMock())
        output = Output(TransportParams(audio_out_enabled=True, audio_out_sample_rate=16000))
        await asyncio.wait_for(run_test(Pipeline([service, output]), frames_to_send=[
            LLMFullResponseStartFrame(), LLMTextFrame("Old reply"), SleepFrame(0.04),
            InterruptionFrame(), SleepFrame(0.04),
            LLMFullResponseStartFrame(), LLMTextFrame("New reply"), LLMFullResponseEndFrame(),
        ]), 5)
        requests = [m for m in messages if m.get("text", "").strip()]
        assert [m["text"] for m in requests] == ["Old reply", "New reply"]
        old, new = [m["context_id"] for m in requests]
        assert old != new
        assert [m["context_id"] for m in messages if m.get("flush")] == [new]
        assert {m["context_id"] for m in messages if m.get("close_context")} == {old, new}

    asyncio.run(run())
