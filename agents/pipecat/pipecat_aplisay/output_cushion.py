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
from typing import Any, Optional

import numpy as np
from loguru import logger
from pipecat.frames.frames import Frame, InterruptionFrame, OutputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

DEFAULT_CUSHION_MS = 60
DEFAULT_TARGET_MS = 300
DEFAULT_STRETCH_QUIET_DBFS = -50.0
#: Duplicate one quiet chunk in every N — a ~33% stretch of pause regions, which
#: is what the measurement below is sized against.
DEFAULT_STRETCH_EVERY = 3


def cushioned(base: type) -> type:
    """Subclass of RawAudioTrack that releases backpressure at a queue depth."""

    class _CushionedRawAudioTrack(base):  # type: ignore[misc, valid-type]
        def __init__(self, *a: Any, **kw: Any) -> None:
            super().__init__(*a, **kw)
            ms = float(os.environ.get("WEBRTC_OUTPUT_CUSHION_MS", DEFAULT_CUSHION_MS))
            chunk_ms = 1000.0 * self._samples_per_10ms / max(1, self._sample_rate)
            self._cushion_chunks = max(0, int(round(ms / chunk_ms)))
            target = float(os.environ.get("WEBRTC_OUTPUT_TARGET_MS", DEFAULT_TARGET_MS))
            self._target_chunks = max(self._cushion_chunks, int(round(target / chunk_ms)))
            db = float(os.environ.get("WEBRTC_STRETCH_QUIET_DBFS", DEFAULT_STRETCH_QUIET_DBFS))
            self._quiet_peak = 32767.0 * (10.0 ** (db / 20.0))
            self._stretch_every = max(0, int(os.environ.get("WEBRTC_STRETCH_EVERY", DEFAULT_STRETCH_EVERY)))
            self._quiet_seen = 0
            self.stretched_chunks = 0

        def add_audio_bytes(self, audio_bytes: bytes):  # noqa: ANN201
            cushion = self._cushion_chunks
            if cushion <= 0:
                return super().add_audio_bytes(audio_bytes)
            # We are reimplementing the parent's method rather than delegating,
            # so anything it does BESIDES chunking has to be done here too. The
            # instrumentation underneath closes its open starvation event on
            # refill; without this the counters read zero for ever and the
            # measurement quietly stops working.
            note = getattr(self, "note_refill", None)
            if note is not None:
                note(audio_bytes)
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
                # Build the cushion out of the agent's own pauses. A quarter of
                # in-turn agent audio is pause (measured: 60 s in 240 s, ~360
                # runs of >=40 ms), so repeating one quiet chunk in three banks
                # ~67 ms of cushion per second of audio — 13x what a flat 95%
                # playout rate would yield, and inaudible, because a repeated
                # near-silent frame has no pitch to shift and no transient to
                # smear. Voiced audio is never touched: that would need WSOLA,
                # and these pods have little CPU to spare.
                if self._should_stretch(chunk):
                    self._chunk_queue.append((chunk, None))
                    self.stretched_chunks += 1

            # While the queue is still shallower than the cushion, do not hold
            # the producer at all: this is what lets the cushion form at the
            # start of a turn, when it is most needed and least available.
            if len(self._chunk_queue) <= cushion and not future.done():
                future.set_result(True)
            return future

        def _should_stretch(self, chunk: bytes) -> bool:
            """May this chunk be repeated to lengthen a pause?"""
            if self._stretch_every <= 0 or len(self._chunk_queue) >= self._target_chunks:
                return False
            samples = np.frombuffer(chunk, dtype=np.int16)
            if samples.size == 0 or np.abs(samples).max() > self._quiet_peak:
                self._quiet_seen = 0          # voiced: never stretch, and reset
                return False
            self._quiet_seen += 1
            return self._quiet_seen % self._stretch_every == 0

        def clear(self) -> int:
            """Drop everything queued — the caller has interrupted.

            Without this the cushion is a liability: the track plays out whatever
            it holds no matter what the pipeline decides, so a deeper queue means
            the agent talks over the caller for longer. Any future still riding a
            dropped chunk MUST be resolved here or write_audio_frame waits on it
            for ever and the leg goes silent.
            """
            n = len(self._chunk_queue)
            for _chunk, fut in self._chunk_queue:
                if fut is not None and not fut.done():
                    fut.set_result(True)
            self._chunk_queue.clear()
            self._quiet_seen = 0
            return n

    _CushionedRawAudioTrack.__name__ = "CushionedRawAudioTrack"
    return _CushionedRawAudioTrack


class OutputCushionInterrupt(FrameProcessor):
    """Empty the output track's queue the moment the caller interrupts.

    The track sits below the transport and nothing upstream can reach it, so
    clearing the transport's own buffers is not enough: whatever the track holds
    still goes on the wire. That is tolerable at the 60 ms hard cushion and not
    at a 300 ms stretched one, which is why this ships with the stretcher rather
    than after it.

    Place it immediately before ``transport.output()`` so it sees the
    InterruptionFrame on its way down.

    It also carries the IN-FLIGHT PROBE, because it is the only place that holds
    both halves of the measurement: every OutputAudioRawFrame passes through here
    on its way to the transport, and the track is reachable from here too. The
    difference between what we have forwarded and what the track has received is
    exactly the audio sitting in the transport's own (unbounded) queue. Sampled
    when a starve begins, that number answers the question nothing else can: did
    the audio EXIST and we failed to move it, or had it not arrived at all? The
    two have opposite fixes, so the same class does both jobs rather than
    resolving the track twice.
    """

    def __init__(self, *, output_transport: Any, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._output = output_transport
        self._forwarded_ms = 0.0
        self._wired: Any = None

    def _track(self) -> Optional[Any]:
        # transport.output() -> SmallWebRTCClient -> the live RawAudioTrack.
        # Both hops are private, so a test pins this path: if pipecat renames
        # either, that test fails instead of barge-in quietly regressing.
        client = getattr(self._output, "_client", None)
        return getattr(client, "_audio_output_track", None) if client else None

    def _wire_probe(self) -> None:
        """Give the track a way to ask how much audio is still in flight."""
        track = self._track()
        if track is None or track is self._wired:
            return
        if hasattr(track, "inflight_probe"):
            track.inflight_probe = lambda: self._forwarded_ms
            self._wired = track

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, OutputAudioRawFrame) and frame.audio:
            rate = getattr(frame, "sample_rate", 0) or 0
            if rate:
                self._forwarded_ms += 1000.0 * (len(frame.audio) / 2) / rate
            self._wire_probe()
        if isinstance(frame, InterruptionFrame):
            track = self._track()
            clear = getattr(track, "clear", None)
            if callable(clear):
                dropped = clear()
                if dropped:
                    logger.debug(f"interruption: dropped {dropped} queued output chunks")
        await self.push_frame(frame, direction)


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
