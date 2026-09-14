"""Per-response timing for experimental transcript synthesis (no transcript logging)."""

import time
from dataclasses import dataclass, field
from uuid import uuid4

from loguru import logger
from pipecat.frames.frames import InterruptionFrame, TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

TRACE_KEY = "aplisay_transcript_tts_trace"


@dataclass
class TranscriptTtsTrace:
    id: str = field(default_factory=lambda: uuid4().hex[:12])
    stages: dict[str, float] = field(default_factory=dict)

    def mark(self, stage: str) -> None:
        if stage in self.stages:
            return
        now = time.monotonic()
        self.stages[stage] = now
        origin = self.stages.get("first_transcript", now)
        logger.info(
            "transcript_tts_latency trace={} stage={} monotonic_s={:.6f} since_transcript_ms={:.1f}",
            self.id, stage, now, (now - origin) * 1000,
        )


class TranscriptTtsPlaybackProbe(FrameProcessor):
    """After output(): audio here has been written successfully to the transport.

    Transport chunking reconstructs audio frames, so carry the trace on the
    ordered TTSStartedFrame instead. This measures local transport playout,
    not arrival at the remote speaker (which includes network/jitter buffering).
    """

    def __init__(self):
        super().__init__()
        self._trace = None

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if direction == FrameDirection.DOWNSTREAM:
            if isinstance(frame, TTSStartedFrame):
                self._trace = frame.metadata.get(TRACE_KEY)
            elif isinstance(frame, TTSAudioRawFrame) and frame.audio and self._trace:
                self._trace.mark("playback_start")
            elif isinstance(frame, (InterruptionFrame, TTSStoppedFrame)):
                self._trace = None
        await self.push_frame(frame, direction)
