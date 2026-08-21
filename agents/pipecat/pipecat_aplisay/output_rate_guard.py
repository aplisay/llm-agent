"""Last processor before the output transport: make every audio frame match the
transport's sample rate, so nothing upstream can ever mute the call.

WHY THIS EXISTS (beta incident, 2026-08-21)
------------------------------------------
``BaseOutputTransport`` hands all outbound audio to a single
``SOXRStreamAudioResampler`` per ``MediaSender``, created once in
``MediaSender.__init__`` and reused for the life of the call
(``base_output.py:426``, used at ``:574``). That resampler LATCHES the first
``(in_rate, out_rate)`` pair it is given: ``_maybe_initialize_sox_stream``
raises ``ValueError`` on any later pair and pipecat surfaces this only as a
NON-FATAL ``ErrorFrame``. The frame is dropped, the call carries on, and the
caller hears nothing — for the rest of the call. On the live incident that was
1283 dropped frames over 55 seconds while the agent talked to no one.

``resample()`` short-circuits when ``in_rate == out_rate`` and never even builds
the stream. So if every frame reaching the transport already carries the
transport's own rate, the latch can never happen and the failure mode is gone
by construction — which is exactly what this processor guarantees.

That makes this defence in depth, not a duplicate of the transport's own
resampling: the transport still resamples, it just always takes the
equal-rates fast path. The specific bug that motivated this (the confidence
tone emitting at ``StartFrame``'s 24 kHz into a 16 kHz-pinned SIP transport) is
fixed at source in ``confidence_tone.py``; this stops the NEXT component that
gets it wrong — a relay injector, a fallback TTS voice, a model swapped
mid-handover — from costing a customer a call.

We convert in place rather than rebuilding the frame so that subclass identity
(``TTSAudioRawFrame`` and friends) and every other field survive; the transport
keys off ``type(frame)`` downstream.
"""

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
