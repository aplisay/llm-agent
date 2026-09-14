"""Phrase streaming for GPT-Live captions, scoped to the experimental TTS path."""

import asyncio
import re
from dataclasses import dataclass

from pipecat.frames.frames import (
    AggregatedTextFrame, AggregationType, CancelFrame, DataFrame, EndFrame,
    InterruptionFrame, LLMFullResponseEndFrame, LLMFullResponseStartFrame,
    TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.tts_service import TextAggregationMode

from .transcript_tts_latency import TRACE_KEY


@dataclass
class _PhraseDeadline(DataFrame):
    generation: int


class ElevenLabsTranscriptTTSService(ElevenLabsTTSService):
    """Send complete words/phrases without waiting for Live's turn-gap timer.

    First chunk: punctuation, four complete words, or 250 ms with complete
    words available. Later chunks: punctuation, twelve words, or 600 ms.
    Deadlines never split a word. Keep one ElevenLabs context per inferred
    response and auto_mode=True, avoiding server-side token chunk scheduling.
    """

    def __init__(self, *, first_phrase_secs=0.25, following_phrase_secs=0.6, **kwargs):
        super().__init__(
            text_aggregation_mode=TextAggregationMode.SENTENCE, auto_mode=True, **kwargs,
        )
        self._first_phrase_secs = first_phrase_secs
        self._following_phrase_secs = following_phrase_secs
        self._phrase = ""
        self._first_phrase = True
        self._deadline = None
        self._generation = 0
        self._deadline_elapsed = False
        self._trace = None
        self._context_traces = {}

    async def _cancel_deadline(self):
        self._generation += 1
        if self._deadline is not None:
            await self.cancel_task(self._deadline)
            self._deadline = None
        self._deadline_elapsed = False

    async def _reset_phrase(self):
        await self._cancel_deadline()
        self._phrase = ""
        self._first_phrase = True

    async def cleanup(self):
        await self._cancel_deadline()
        self._context_traces.clear()
        await super().cleanup()

    def _complete_word_end(self):
        ends = [m.end() for m in re.finditer(r"\S+\s+", self._phrase)]
        return ends[-1] if ends else 0

    def _boundary(self):
        # A final period after digits may be a decimal split across deltas.
        # Common title abbreviations likewise need more text before release.
        for match in re.finditer(r"[,;:!?。！？](?:[\"'’”]*)\s*|\.(?:[\"'’”]*)\s*", self._phrase):
            prefix = self._phrase[:match.end()]
            if match.group()[0] in ",.:" and match.start() and self._phrase[match.start() - 1].isdigit():
                continue
            if match.group().startswith(".") and re.search(
                r"(?:\d|\bMr|\bMrs|\bMs|\bDr|\bProf|\bSt)\.$", prefix.rstrip(), re.I,
            ):
                continue
            return match.end()
        words = list(re.finditer(r"\S+\s+", self._phrase))
        count = 4 if self._first_phrase else 12
        return words[count - 1].end() if len(words) >= count else 0

    async def _emit_phrase(self, end):
        text, self._phrase = self._phrase[:end], self._phrase[end:]
        generation = self._generation + 1
        await self._cancel_deadline()
        if generation != self._generation:
            # An urgent interruption can reset state while cancellation yields.
            return
        if text.strip():
            self._first_phrase = False
            await self._push_tts_frames(
                AggregatedTextFrame(text, AggregationType.SENTENCE, raw_text=text),
            )

    def _start_deadline(self):
        if self._deadline is not None or self._deadline_elapsed or not self._phrase:
            return
        generation = self._generation
        delay = self._first_phrase_secs if self._first_phrase else self._following_phrase_secs

        async def expire():
            await asyncio.sleep(delay)
            # Queue alongside text/end frames; a generation token invalidates
            # deadlines already queued when an interruption resets the buffer.
            await self.queue_frame(_PhraseDeadline(generation))

        self._deadline = self.create_task(expire())

    async def _process_text_frame(self, frame):
        self._phrase += frame.text
        while end := self._boundary():
            await self._emit_phrase(end)
        if self._deadline_elapsed and (end := self._complete_word_end()):
            await self._emit_phrase(end)
        self._start_deadline()

    async def process_frame(self, frame, direction):
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, _PhraseDeadline):
                if frame.generation == self._generation:
                    self._deadline = None
                    self._deadline_elapsed = True
                    if end := self._complete_word_end():
                        await self._emit_phrase(end)
                    self._start_deadline()
                return
            if isinstance(frame, (InterruptionFrame, CancelFrame)):
                await self._reset_phrase()
                for trace in self._context_traces.values():
                    trace.mark("interrupted" if isinstance(frame, InterruptionFrame) else "cancelled")
                self._context_traces.clear()
            elif isinstance(frame, LLMFullResponseStartFrame):
                await self._reset_phrase()
                self._trace = frame.metadata.get(TRACE_KEY)
            elif isinstance(frame, (LLMFullResponseEndFrame, EndFrame)):
                await self._emit_phrase(len(self._phrase))
                await self._reset_phrase()
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
