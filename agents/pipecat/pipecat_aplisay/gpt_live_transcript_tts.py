"""Experimental GPT-Live transcript synthesis on Pipecat.

The Live API still generates audio. Discard it, emit assistant transcript
deltas once as LLMTextFrames, and let the downstream TTS own speech frames.
This cannot synchronise Live's internal speech timeline with external playout.
"""

from typing import Any

from pipecat.audio.vad.vad_analyzer import VADState
from pipecat.frames.frames import (
    BotStoppedSpeakingFrame,
    InterruptionFrame,
    LLMTextFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    TTSTextFrame,
)
from pipecat.processors.frame_processor import FrameDirection

from .gpt_live_service import AplisayOpenAILiveLLMService
from .output_rate_guard import _RateAgileResampler


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
        self._transcript_vad.set_sample_rate(16000)
        self._vad_resampler = _RateAgileResampler()
        await super()._handle_evt_session_started(evt)

    async def _handle_evt_audio_delta(self, evt) -> None:
        # Do not decode, play, record or send native speech to the output STT tap.
        pass

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        if direction == FrameDirection.DOWNSTREAM and isinstance(
            frame, (TTSStartedFrame, TTSStoppedFrame, TTSTextFrame)
        ):
            # Upstream Live treats its captions as already spoken. Only the
            # downstream TTS can make that claim in this mode.
            return
        await super().push_frame(frame, direction)

    async def _push_assistant_text(self, text: str) -> None:
        if text and not self._vad_speaking and not self._discard_assistant_turn:
            # Keep exact delta spacing. TTS consumes this frame and appends its
            # own spoken text to context, so no TTSTextFrame is emitted here.
            await self.push_frame(LLMTextFrame(text))

    async def _append_turn(self, role, delta, accumulated, evt) -> None:
        if role == "user" and self._awaiting_user_transcript:
            self._discard_through_ms = max(self._discard_through_ms, evt.end_ms or 0)
        if role == "assistant" and evt.end_ms is not None and evt.end_ms <= self._discard_through_ms:
            # A delayed fragment from before the interruption must not restart
            # synthesis. The provider/delegation transcript is still retained.
            return
        await super()._append_turn(role, delta, accumulated, evt)

    async def _send_user_audio(self, frame) -> None:
        if not self.greeting_guard_active:
            audio = await self._vad_resampler.resample(frame.audio, frame.sample_rate, 16000)
            state = await self._transcript_vad.analyze_audio(audio)
            if state == VADState.SPEAKING and not self._vad_speaking:
                self._vad_speaking = True
                self._awaiting_user_transcript = True
                self._discard_assistant_turn = self._assistant_turn.open
                # Skip LLMService.process_frame: that would cancel delegated
                # tools. Clear the external TTS and output buffers only.
                await self.push_frame(InterruptionFrame())
            elif state == VADState.QUIET:
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
        if isinstance(frame, BotStoppedSpeakingFrame) and self._greeting_text_done:
            self._greeting_guard_until = None
        await super().process_frame(frame, direction)
