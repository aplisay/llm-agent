"""Hand a continuous speech stream to the output transport in whole chunks.

The transport cuts audio into ``audio_chunk_size`` chunks and keeps the
remainder. On a ``TTSStoppedFrame`` it pads that remainder with zeros, and when
it decides the bot stopped speaking it discards it. Both assume the stream has
ended. A speech stream (``SpeechOutputAudioRawFrame``, e.g. OpenAI Live) has
not: its service emits ``TTSStoppedFrame`` on a transcript pause while audio
carries on. So each event cut up to one chunk of zeros into speech, or dropped
up to one chunk of it (pipecat#5982). Holding the remainder here leaves the
transport nothing to pad or drop.

Place immediately before ``transport.output()``, after ``OutputRateGuard``.
"""

from __future__ import annotations

from typing import Any, Optional

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InterruptionFrame,
    OutputAudioRawFrame,
    SpeechOutputAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class SpeechStreamAligner(FrameProcessor):
    """Forward speech-stream audio only in multiples of the transport's chunk."""

    def __init__(self, *, output_transport: Any, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._output = output_transport
        self._held = b""
        self._template: Optional[SpeechOutputAudioRawFrame] = None

    def _chunk_bytes(self, frame: OutputAudioRawFrame) -> int:
        """The transport's chunk size, or 0 when aligning would not help."""
        size = getattr(self._output, "audio_chunk_size", 0) or 0
        rate = getattr(self._output, "sample_rate", 0) or 0
        # A rate mismatch means the transport resamples, which changes the byte
        # count; OutputRateGuard upstream should make this unreachable.
        if size <= 0 or rate != frame.sample_rate:
            return 0
        return size

    @staticmethod
    def _like(frame: OutputAudioRawFrame, audio: bytes) -> OutputAudioRawFrame:
        out = type(frame)(audio=audio, sample_rate=frame.sample_rate, num_channels=frame.num_channels)
        out.transport_destination = frame.transport_destination
        return out

    async def _flush(self) -> None:
        """Send what is held, so audio of another kind keeps its place behind it."""
        if self._held and self._template is not None:
            held, self._held = self._held, b""
            await self.push_frame(self._like(self._template, held), FrameDirection.DOWNSTREAM)

    async def _align(self, frame: SpeechOutputAudioRawFrame) -> None:
        size = self._chunk_bytes(frame)
        if size <= 0:
            await self._flush()
            await self.push_frame(frame, FrameDirection.DOWNSTREAM)
            return
        data = self._held + frame.audio
        whole = len(data) - len(data) % size
        self._held = data[whole:]
        self._template = frame
        if whole:
            await self.push_frame(self._like(frame, data[:whole]), FrameDirection.DOWNSTREAM)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, SpeechOutputAudioRawFrame):
                await self._align(frame)
                return
            if isinstance(frame, InterruptionFrame):
                # The transport drops its own unsent audio on an interruption.
                self._held = b""
            elif isinstance(frame, (OutputAudioRawFrame, EndFrame, CancelFrame)):
                await self._flush()
        await self.push_frame(frame, direction)
