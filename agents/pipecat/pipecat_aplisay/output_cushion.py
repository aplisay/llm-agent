"""Let the WebRTC output queue run a little ahead of the playhead.

WHY THIS EXISTS (measured on staging, 2026-08-25/26)
---------------------------------------------------
``RawAudioTrack.recv()`` emits one 10 ms chunk per 10 ms of media time and, when
its queue is empty, emits ``bytes(self._bytes_per_10ms)`` — arithmetic zero, on
the wire, in real packets. A rig capturing the agent's audio at both the
platform's recording tap and the browser's decoder found exactly that: holes of
digital zero present only in the browser copy, with nothing lost and nothing
concealed. Instrumenting the track (see ``output_underrun``) confirmed it from
the other end and measured the shape of it, gated on the bot's own speaking
window so that the silence between turns is not miscounted as starvation:

  39 starves inside speech over a 6-minute call, 1.79 s of inserted silence.
  Gap ladder: 20 ms x20, 30 x9, 40 x2, 50 x1, 60 x2, then 140, 150, 160, 210, 210.

Two things follow. The distribution is bimodal with **nothing at all between
60 ms and 140 ms**, so 60 ms covers the whole small-jitter cluster — 34 of 39
events — and anything up to 140 ms buys not one extra event. And the audio was
always merely late: ``never_refilled`` was zero, so there is something to
buffer.

WHY THERE IS NO CUSHION TODAY — and why this costs no latency
--------------------------------------------------------------
``write_audio_frame`` awaits the future ``add_audio_bytes`` returns, and the
parent attaches that future to the LAST chunk of the batch. So the producer is
released only once the track has drained everything it just handed over: the
queue is held near empty by design, and the measured depth bears that out (0 or
1 chunk for ~44 % of slots, never more than 5). Any upstream hiccup longer than
that lands as a hole.

This does not add a pre-roll and does not delay playout. The pacer still emits
chunk N at ``start + N * 10 ms``; the first chunk of a turn still goes out at
the very next slot. All that changes is WHEN backpressure is released — at a
queue depth of ``cushion`` rather than at zero — so a burst from the model can
sit in the queue instead of being refused, and the next stall drains the queue
instead of the wire. The cushion only ever forms out of audio the model has
already produced.

The one real cost: the track has no ``clear()``, so whatever is queued plays out
even after a barge-in. That is true today at up to 5 chunks; this raises the
ceiling to ``cushion``, so an interrupted bot may talk over the caller for a few
tens of milliseconds longer than it does now.

``WEBRTC_OUTPUT_CUSHION_MS=0`` restores the stock lock-step behaviour.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from loguru import logger

DEFAULT_CUSHION_MS = 60


def cushioned(base: type) -> type:
    """Subclass of RawAudioTrack that releases backpressure at a queue depth."""

    class _CushionedRawAudioTrack(base):  # type: ignore[misc, valid-type]
        def __init__(self, *a: Any, **kw: Any) -> None:
            super().__init__(*a, **kw)
            ms = float(os.environ.get("WEBRTC_OUTPUT_CUSHION_MS", DEFAULT_CUSHION_MS))
            chunk_ms = 1000.0 * self._samples_per_10ms / max(1, self._sample_rate)
            self._cushion_chunks = max(0, int(round(ms / chunk_ms)))

        def add_audio_bytes(self, audio_bytes: bytes):  # noqa: ANN201
            cushion = self._cushion_chunks
            if cushion <= 0:
                return super().add_audio_bytes(audio_bytes)
            if len(audio_bytes) % self._bytes_per_10ms != 0:
                # Same contract as the parent — an odd-sized write is a bug
                # upstream and must not be silently repacked.
                raise ValueError("Audio bytes must be a multiple of 10ms size.")

            future = asyncio.get_running_loop().create_future()
            step = self._bytes_per_10ms
            chunks = [audio_bytes[i : i + step] for i in range(0, len(audio_bytes), step)]
            if not chunks:
                future.set_result(True)
                return future

            # Hand the future to the chunk that leaves `cushion` behind it, so
            # the producer wakes while the queue still has that much to play.
            release = max(0, len(chunks) - 1 - cushion)
            for i, chunk in enumerate(chunks):
                self._chunk_queue.append((chunk, future if i == release else None))

            # While the queue is still shallower than the cushion, do not hold
            # the producer at all: this is what lets the cushion form at the
            # start of a turn, when it is most needed and least available.
            if len(self._chunk_queue) <= cushion and not future.done():
                future.set_result(True)
            return future

    _CushionedRawAudioTrack.__name__ = "CushionedRawAudioTrack"
    return _CushionedRawAudioTrack


def install() -> bool:
    """Swap pipecat's RawAudioTrack for the cushioned subclass. Idempotent.

    Layer this AFTER output_underrun.install() so the cushioned class inherits
    the instrumented one and both measurements survive.
    """
    ms = float(os.environ.get("WEBRTC_OUTPUT_CUSHION_MS", DEFAULT_CUSHION_MS))
    if ms <= 0:
        return False
    from pipecat.transports.smallwebrtc import transport as _t

    current = getattr(_t, "RawAudioTrack", None)
    if current is None or getattr(current, "__name__", "") == "CushionedRawAudioTrack":
        return False
    _t.RawAudioTrack = cushioned(current)
    logger.info(f"output cushion installed on RawAudioTrack: {ms:.0f} ms")
    return True
