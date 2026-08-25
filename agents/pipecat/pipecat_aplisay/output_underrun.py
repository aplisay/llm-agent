"""Measure how badly the WebRTC output track starves, and by how long.

WHY THIS EXISTS (measured on staging, 2026-08-25)
-------------------------------------------------
A closed-loop rig that captures the agent's audio both at the platform's own
recording tap (which sits after ``transport.output()``, so it holds the bytes
handed to the track) and at the browser's decoder found gaps that exist ONLY in
the browser copy: 50 ms, 80 ms and 100 ms of **arithmetic zero** across two
calls, each with packets still flowing, nothing lost and nothing concealed.
NetEq's concealment extrapolates waveform and never emits zeroes, so those
samples were transmitted as zeroes — which is ``RawAudioTrack.recv()`` finding
its queue empty and emitting ``bytes(self._bytes_per_10ms)``.

That much is settled. What is NOT settled is the only thing that decides
whether it can be fixed at the transport at all:

  * if the audio **arrives late** — a few tens of milliseconds — then a modest
    output cushion absorbs it and the gap disappears;
  * if the audio **never arrives** — the model or the pipeline simply produced
    nothing for that span — then there is nothing to buffer and no amount of
    pre-roll helps. The gap is real and the fix belongs upstream.

So the number that matters is ``late_by_ms``: the interval from the first
starved ``recv()`` to the moment real audio was next queued. Everything else
here is context for it.

The second measurement is the **queue-depth histogram**, sampled at every
``recv()``. If the queue normally sits at 0 or 1 chunks then there is no
cushion at all and any hiccup at all underruns — which would make a pre-roll
the obvious fix. If it normally sits several chunks deep, a starve means
something upstream stopped for longer than that cushion, and the depth tells
you how much longer would have been needed.

Mechanism: ``RawAudioTrack`` is constructed inside pipecat's
``SmallWebRTCClient._handle_client_connected`` by module-global lookup, so
swapping that global for a subclass instruments it without touching the
transport or duplicating its logic. We observe around ``super()`` rather than
reimplementing ``recv()``, so an upstream change to the pacing cannot silently
diverge from what we measure.

Off with ``WEBRTC_UNDERRUN_STATS=0``.
"""

from __future__ import annotations

import os
import time
from typing import Any, Optional

from loguru import logger

# Depth buckets, sampled every recv(). The first two are the interesting ones:
# time spent at 0 or 1 is time with no cushion.
_BUCKETS = ((0, "0"), (1, "1"), (2, "2"), (5, "3-5"), (10, "6-10"))


def _bucket(depth: int) -> str:
    for limit, label in _BUCKETS:
        if depth <= limit:
            return label
    return ">10"


class UnderrunStats:
    """Counters for one output track."""

    def __init__(self, chunk_ms: float) -> None:
        self.chunk_ms = chunk_ms
        self.events = 0
        self.chunks_filled = 0            # 10 ms slots filled with zeroes
        self.max_gap_ms = 0.0
        self.late_ms: list[float] = []    # one per event that was refilled
        self.never_refilled = 0           # starved and the track ended first
        self.depth = {label: 0 for _, label in _BUCKETS}
        self.depth[">10"] = 0
        self.recvs = 0

    @property
    def silence_ms(self) -> float:
        return self.chunks_filled * self.chunk_ms

    def summary(self) -> str:
        if not self.events:
            return f"no output underruns in {self.recvs} slots"
        late = sorted(self.late_ms)
        p50 = late[len(late) // 2] if late else float("nan")
        p90 = late[int(len(late) * 0.9)] if late else float("nan")
        worst = late[-1] if late else float("nan")
        depth = " ".join(
            f"{k}:{100.0 * v / max(1, self.recvs):.0f}%" for k, v in self.depth.items() if v
        )
        return (
            f"output underruns: {self.events} events, {self.silence_ms:.0f} ms of inserted "
            f"silence over {self.recvs * self.chunk_ms / 1000:.0f} s, worst gap "
            f"{self.max_gap_ms:.0f} ms; refill lateness p50 {p50:.0f} ms / p90 {p90:.0f} ms / "
            f"max {worst:.0f} ms ({self.never_refilled} never refilled); queue depth {depth}"
        )


def instrumented(base: type) -> type:
    """Build a subclass of pipecat's RawAudioTrack that counts its own starvation."""

    class _InstrumentedRawAudioTrack(base):  # type: ignore[misc, valid-type]
        def __init__(self, *a: Any, **kw: Any) -> None:
            super().__init__(*a, **kw)
            chunk_ms = 1000.0 * self._samples_per_10ms / max(1, self._sample_rate)
            self.underrun = UnderrunStats(chunk_ms)
            self._starved_at: Optional[float] = None
            self._starved_slots = 0
            self._last_summary = time.monotonic()
            self._event_log_ms = float(os.environ.get("WEBRTC_UNDERRUN_LOG_MS", "20"))
            self._summary_s = float(os.environ.get("WEBRTC_UNDERRUN_SUMMARY_S", "30"))

        # --- observation points ------------------------------------------
        def add_audio_bytes(self, audio_bytes: bytes):  # noqa: ANN201
            # The instant real audio comes back is what makes lateness
            # measurable at all; close the open event here rather than waiting
            # for the next recv(), which would add up to one slot of error.
            if self._starved_at is not None and audio_bytes:
                self._close(time.monotonic())
            return super().add_audio_bytes(audio_bytes)

        async def recv(self):  # noqa: ANN201
            st = self.underrun
            depth = len(self._chunk_queue)
            st.recvs += 1
            st.depth[_bucket(depth)] += 1
            starving = depth == 0 and getattr(self, "_auto_silence", True)
            if starving:
                if self._starved_at is None:
                    self._starved_at = time.monotonic()
                    self._starved_slots = 0
                self._starved_slots += 1
                st.chunks_filled += 1
            frame = await super().recv()
            self._maybe_summarise()
            return frame

        # --- bookkeeping --------------------------------------------------
        def _close(self, now: float) -> None:
            st = self.underrun
            gap_ms = self._starved_slots * st.chunk_ms
            late_ms = (now - (self._starved_at or now)) * 1000.0
            st.events += 1
            st.max_gap_ms = max(st.max_gap_ms, gap_ms)
            st.late_ms.append(late_ms)
            if gap_ms >= self._event_log_ms:
                # The verdict this line exists to support: a lateness of a few
                # tens of ms means a cushion would have covered it; a lateness
                # far larger than the gap means the audio was never coming.
                logger.info(
                    f"output underrun: {gap_ms:.0f} ms of silence sent, real audio arrived "
                    f"{late_ms:.0f} ms after the queue ran dry"
                )
            self._starved_at = None
            self._starved_slots = 0

        def _maybe_summarise(self) -> None:
            now = time.monotonic()
            if now - self._last_summary < self._summary_s:
                return
            self._last_summary = now
            if self.underrun.events:
                logger.info(self.underrun.summary())

        def stop(self) -> None:  # noqa: ANN201
            if self._starved_at is not None:
                self.underrun.never_refilled += 1
                self._starved_at = None
            if self.underrun.events:
                logger.info(f"track finished — {self.underrun.summary()}")
            return super().stop()

    _InstrumentedRawAudioTrack.__name__ = "InstrumentedRawAudioTrack"
    return _InstrumentedRawAudioTrack


def install() -> bool:
    """Swap pipecat's RawAudioTrack for the instrumented subclass. Idempotent."""
    if os.environ.get("WEBRTC_UNDERRUN_STATS", "1").strip() in ("0", "false", "no"):
        return False
    from pipecat.transports.smallwebrtc import transport as _t

    current = getattr(_t, "RawAudioTrack", None)
    if current is None or getattr(current, "__name__", "") == "InstrumentedRawAudioTrack":
        return False
    _t.RawAudioTrack = instrumented(current)
    logger.info("output underrun stats installed on RawAudioTrack")
    return True
