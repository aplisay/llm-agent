"""Provider-buffered GPT-Live captions, scoped to the experimental TTS path."""

from pipecat.frames.frames import (
    CancelFrame, InterruptionFrame, LLMFullResponseStartFrame,
    TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.tts_service import TextAggregationMode

from .transcript_tts_latency import TRACE_KEY


class ElevenLabsTranscriptTTSService(ElevenLabsTTSService):
    """Forward captions immediately; let ElevenLabs buffer for speech context.

    TOKEN mode preserves delta boundaries/spacing and bypasses Pipecat's
    sentence wait. auto_mode=False enables the provider's default scheduling.
    Pipecat retains one context per inferred response and flushes its remainder
    on response completion; interruptions close the cancelled context.
    """

    def __init__(self, **kwargs):
        super().__init__(
            text_aggregation_mode=TextAggregationMode.TOKEN, auto_mode=False, **kwargs,
        )
        self._trace = None
        self._context_traces = {}

    async def cleanup(self):
        self._context_traces.clear()
        await super().cleanup()

    async def process_frame(self, frame, direction):
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, (InterruptionFrame, CancelFrame)):
                for trace in self._context_traces.values():
                    trace.mark("interrupted" if isinstance(frame, InterruptionFrame) else "cancelled")
                self._context_traces.clear()
            elif isinstance(frame, LLMFullResponseStartFrame):
                self._trace = frame.metadata.get(TRACE_KEY)
        await super().process_frame(frame, direction)

    async def run_tts(self, text, context_id):
        if self._trace:
            self._context_traces[context_id] = self._trace
            self._trace.mark("first_tts_submission")
        async for frame in super().run_tts(text, context_id):
            yield frame

    async def on_turn_context_created(self, context_id):
        if self._trace:
            self._context_traces[context_id] = self._trace
        await super().on_turn_context_created(context_id)

    async def append_to_audio_context(self, context_id, frame):
        trace = self._context_traces.get(context_id)
        if trace and isinstance(frame, TTSAudioRawFrame) and frame.audio:
            trace.mark("first_audio")
        await super().append_to_audio_context(context_id, frame)

    async def push_frame(self, frame, direction=FrameDirection.DOWNSTREAM):
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, TTSStartedFrame):
                trace = self._context_traces.get(frame.context_id)
                if trace:
                    frame.metadata[TRACE_KEY] = trace
            elif isinstance(frame, TTSStoppedFrame):
                self._context_traces.pop(frame.context_id, None)
        await super().push_frame(frame, direction)
