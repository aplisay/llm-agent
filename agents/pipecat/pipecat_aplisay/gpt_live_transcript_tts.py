"""Experimental GPT-Live transcript synthesis on Pipecat.

The Live API still generates audio. Discard it, emit assistant transcript
deltas once as LLMTextFrames, and let the downstream TTS own speech frames.
This cannot synchronise Live's internal speech timeline with external playout.
"""

from typing import Any

from pipecat.audio.vad.vad_analyzer import VADState
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterruptionFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from .gpt_live_service import AplisayOpenAILiveLLMService
from .output_rate_guard import _RateAgileResampler
from .transcript_tts_latency import TRACE_KEY, TranscriptTtsTrace


class GptLiveTranscriptTtsService(AplisayOpenAILiveLLMService):
    """Speak captions through a separate TTS, with local playback interruption.

    VAD runs here rather than in the user aggregator so interruptions go only
    downstream to synthesis/playout. GPT-Live's delegated tool calls continue,
    just as they do with its native audio. Input is always streamed to Live.
    """

    def __init__(self, *, vad_analyzer: Any = None, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        if vad_analyzer is None:
            from .voice_session import _local_vad_analyzer

            vad_analyzer = _local_vad_analyzer()
        self._transcript_vad = vad_analyzer
        self._transcript_vad.set_sample_rate(16000)
        self._vad_resampler = _RateAgileResampler()
        self._vad_speaking = False
        self._discard_assistant_turn = False
        self._awaiting_user_transcript = False
        self._discard_through_ms = 0
        self._greeting_text_done = False
        self._bot_speaking = False
        self._speech_interrupts = False
        self._preplay_speech_secs = 0.0
        self._tts_trace = None

    async def cleanup(self) -> None:
        try:
            await super().cleanup()
        finally:
            await self._transcript_vad.cleanup()

    async def _handle_evt_session_started(self, evt) -> None:
        self._vad_speaking = False
        self._discard_assistant_turn = False
        self._awaiting_user_transcript = False
        self._discard_through_ms = 0
        self._greeting_text_done = False
        self._bot_speaking = False
        self._speech_interrupts = False
        self._preplay_speech_secs = 0.0
        self._tts_trace = None
        self._transcript_vad.set_sample_rate(16000)
        self._vad_resampler = _RateAgileResampler()
        await super()._handle_evt_session_started(evt)

    async def _handle_evt_audio_delta(self, evt) -> None:
        # Do not decode, play, record or send native speech to the output STT tap.
        pass

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        if direction == FrameDirection.DOWNSTREAM and isinstance(frame, LLMFullResponseStartFrame):
            self._tts_trace = TranscriptTtsTrace()
            frame.metadata[TRACE_KEY] = self._tts_trace
        if direction == FrameDirection.DOWNSTREAM and isinstance(
            frame, (TTSStartedFrame, TTSStoppedFrame, TTSTextFrame)
        ):
            # Upstream Live treats its captions as already spoken. Only the
            # downstream TTS can make that claim in this mode.
            return
        await super().push_frame(frame, direction)

    async def _push_assistant_text(self, text: str) -> None:
        if (
            text and not (self._vad_speaking and self._speech_interrupts)
            and not self._discard_assistant_turn
        ):
            # Keep exact delta spacing. TTS consumes this frame and appends its
            # own spoken text to context, so no TTSTextFrame is emitted here.
            if self._tts_trace:
                self._tts_trace.mark("first_transcript")
            await self.push_frame(LLMTextFrame(text))

    async def _append_turn(self, role, delta, accumulated, evt) -> None:
        if role == "user" and self._awaiting_user_transcript:
            self._discard_through_ms = max(self._discard_through_ms, evt.end_ms or 0)
        if role == "assistant" and evt.end_ms is not None and evt.end_ms <= self._discard_through_ms:
            # A delayed fragment from before the interruption must not restart
            # synthesis. The provider/delegation transcript is still retained.
            return
        if (
            role == "assistant" and self._discard_assistant_turn and not self._vad_speaking
            and self._discard_through_ms and evt.start_ms is not None
            and evt.start_ms >= self._discard_through_ms
        ):
            # Live may begin its new answer without the 800 ms caption gap
            # needed to close the previous inferred turn. Don't suppress it.
            await self._end_turn("assistant")
            self._assistant_turn.open = True
            self._assistant_turn.text = delta
            accumulated = delta
            await self._open_turn("assistant")
        await super()._append_turn(role, delta, accumulated, evt)

    async def _interrupt_external_speech(self):
        self._speech_interrupts = True
        self._awaiting_user_transcript = True
        self._discard_assistant_turn = self._assistant_turn.open
        if self._tts_trace:
            self._tts_trace.mark("interrupted")
        # Skip LLMService.process_frame: delegated tools must keep running.
        await self.push_frame(InterruptionFrame())

    async def _send_user_audio(self, frame) -> None:
        if not self.greeting_guard_active:
            audio = await self._vad_resampler.resample(frame.audio, frame.sample_rate, 16000)
            state = await self._transcript_vad.analyze_audio(audio)
            if state == VADState.SPEAKING and not self._vad_speaking:
                self._vad_speaking = True
                self._preplay_speech_secs = 0.0
                self._speech_interrupts = False
                if self._bot_speaking:
                    await self._interrupt_external_speech()
            if state == VADState.SPEAKING and not self._speech_interrupts:
                # Measure audio duration, allowing brief acknowledgments before playback; retain that grace if playback starts.
                # Sustained speech cancels the queue; see PR #328.
                self._preplay_speech_secs += len(audio) / (16000 * 2)
                if self._preplay_speech_secs >= 0.6:
                    await self._interrupt_external_speech()
            if state == VADState.QUIET:
                self._vad_speaking = False
        await super()._send_user_audio(frame)

    async def _end_turn(self, role: str) -> None:
        was_open = self._assistant_turn.open if role == "assistant" else False
        guard = self._greeting_guard_until
        await super()._end_turn(role)
        if role == "user":
            self._awaiting_user_transcript = False
        if role == "assistant" and was_open:
            self._discard_assistant_turn = False
            if guard is not None:
                # Native transcript completion precedes external playback.
                # Keep feeding silence until TTS playout stops (or the existing
                # bounded greeting guard expires if synthesis fails).
                self._greeting_guard_until = guard
                self._greeting_text_done = True

    async def process_frame(self, frame, direction) -> None:
        if isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
        if isinstance(frame, BotStoppedSpeakingFrame) and self._greeting_text_done:
            self._greeting_guard_until = None
        await super().process_frame(frame, direction)
