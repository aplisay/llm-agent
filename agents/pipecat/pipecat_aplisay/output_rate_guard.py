"""Normalise to the transport rate: its resampler latches the first rate pair and rejects later changes. See PR #235.
Modify frames in place to preserve their subclass and metadata."""

from __future__ import annotations

from typing import Any, Optional

from loguru import logger
from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import Frame, OutputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


class _RateAgileResampler:
    """A stream resampler that survives a rate change by rebuilding itself.

    ``SOXRStreamAudioResampler`` is stateful (it carries filter history across
    chunks, which is what makes it right for a continuous stream) and therefore
    refuses to change rates. Rebuilding on a genuine rate change costs one
    chunk's worth of discontinuity — a click at worst — where the alternative is
    silence for the remainder of the call.
    """

    def __init__(self) -> None:
        self._resampler = create_stream_resampler()
        self._pair: Optional[tuple[int, int]] = None

    async def resample(self, audio: bytes, in_rate: int, out_rate: int) -> bytes:
        if in_rate == out_rate:
            return audio
        pair = (in_rate, out_rate)
        if self._pair is not None and self._pair != pair:
            logger.warning(
                f"output rate guard: resample rate changed {self._pair[0]}->{self._pair[1]} "
                f"to {in_rate}->{out_rate}; rebuilding the stream resampler"
            )
            self._resampler = create_stream_resampler()
        self._pair = pair
        return await self._resampler.resample(audio, in_rate, out_rate)


class OutputRateGuard(FrameProcessor):
    """Normalise outbound audio to the output transport's sample rate.

    Spliced immediately before ``transport.output()``. Inert until the
    transport has started (``sample_rate`` is 0 until its StartFrame lands) and
    inert for frames that already match — the common case, costing one integer
    compare.
    """

    def __init__(self, output_transport: Any = None) -> None:
        super().__init__()
        self._output_transport = output_transport
        self._resampler = _RateAgileResampler()

    def bind_output(self, output_transport: Any) -> None:
        self._output_transport = output_transport

    def _target_rate(self) -> Optional[int]:
        rate = getattr(self._output_transport, "sample_rate", None)
        if isinstance(rate, int) and rate > 0:
            return rate
        return None

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)

        if direction == FrameDirection.DOWNSTREAM and isinstance(
            frame, OutputAudioRawFrame
        ):
            target = self._target_rate()
            if target is not None and frame.sample_rate != target:
                # NOT logged: a mismatch here is the NORMAL case, not a fault.
                # Ultravox renders at 48 kHz and the SIP transports are pinned
                # to 16 kHz, so every bot frame on a phone call needs
                # converting — the transport would have done exactly this work
                # one processor later. Only a rate CHANGE is newsworthy, and
                # _RateAgileResampler logs that.
                try:
                    frame.audio = await self._resampler.resample(
                        frame.audio, frame.sample_rate, target
                    )
                    frame.sample_rate = target
                except Exception as e:  # noqa: BLE001
                    # Never let the guard itself break the audio path: pass the
                    # frame through untouched and let the transport do what it
                    # would have done without us.
                    logger.warning(f"output rate guard: resample failed, passing through: {e}")

        await self.push_frame(frame, direction)
