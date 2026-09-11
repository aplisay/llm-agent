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

THE KNOBS, AND WHAT ``WEBRTC_OUTPUT_TARGET_MS`` ACTUALLY DOES
------------------------------------------------------------
``WEBRTC_OUTPUT_TARGET_MS`` (300) is a **ceiling on the stretcher, not a depth
the queue reaches.** Measured on staging: with it at 300 the queue never
exceeded 10 chunks — 100 ms — because backpressure still releases at
``WEBRTC_OUTPUT_CUSHION_MS`` (60). The producer is held once the queue passes
the hard cushion, so stretching can push depth to roughly cushion+4 and no
further. The target only ever stops the stretcher going higher.

That is deliberate as it stands, because the result was good: pause-stretching
took mid-speech starvation from 39 events per call to 1, at an effective cushion
of 60-100 ms. Raising the release point to the target instead would triple the
audio queued behind an interrupting caller for no measured benefit — the
experiment below says the depth was never the binding constraint.

Do not "fix" this by keying the release point to the target without re-running
that measurement. If the knob's name is the problem, rename the knob.

Until 2026-09-11 the target was compared with this track's queue, which never
gets near it, so in practice the stretcher had no ceiling at all. It is now
compared with the whole output backlog. See WHY THE CEILING COUNTS THE WHOLE
BACKLOG below.

WHAT THE RELEASE POINT IS *NOT* FOR
-----------------------------------
Tested directly (staging, 2026-08-26): ``WEBRTC_OUTPUT_CUSHION_MS=300`` with
``WEBRTC_STRETCH_EVERY=0`` — release backpressure at 30 chunks, no stretching.
The queue **still never exceeded 10 chunks** and mid-speech starvation was
essentially unchanged (36 events, 5.38 ms/s against 6.46 stock). The producer
was free to run 300 ms ahead and could not: there was no audio to buffer.

So Ultravox really does deliver at about realtime with no surplus, and the
transport's own audio queue is an UNBOUNDED ``asyncio.Queue`` — holding the
track's future never back-pressures anything upstream. Releasing backpressure
later achieves almost nothing; the stretcher works precisely because it
MANUFACTURES slack that does not otherwise exist.

  ================================  =========  ==============
  configuration                     starves    ms/s of speech
  ================================  =========  ==============
  60 ms release, no stretch              39              6.46
  300 ms release, no stretch             36              5.38
  60 ms release + pause-stretch           1              0.06
  ================================  =========  ==============

WHY THE CEILING COUNTS THE WHOLE BACKLOG (staging, 2026-09-11)
-------------------------------------------------------------
A repeated chunk is 10 ms that the track plays and the source never sent, so it
delays all the audio behind it by 10 ms. That delay goes away only when the
source stops sending and the queue empties. Ultravox stops between turns, so its
queue empties and the delay is gone before the next turn starts.

GPT-Live never stops. It streams audio at real-time pace, silence included
(pipecat marks this with ``SpeechOutputAudioRawFrame``), so the queue never
empties and every repeated chunk stays as delay. The ceiling counted only this
track's queue, so it never engaged, and the extra audio waited in the
transport's unbounded queue instead. One test call stretched 1800 chunks in
109 s. Frames queued behind that audio reached the end of the pipeline 7.8 s
late at 42 s into the call and 14.9 s late at 74 s, and each reply started later
than the one before. The transcript does not wait in that queue, so it arrived
long before the audio.

So the ceiling now counts the whole output backlog: this track's queue plus the
audio ``OutputCushionInterrupt`` has forwarded that the transport has not yet
handed to the track. The stretcher runs only while that total is under
``WEBRTC_OUTPUT_TARGET_MS``, so it can add at most that much delay to any
source. On GPT-Live the backlog settles at the target, so the target is the
delay the cushion adds there, in exchange for that much protection against late
audio. In a long Ultravox turn the stretcher used to add about 67 ms per second
of speech until the turn ended; it now stops at the target there too.

TRIMMING A SPEECH STREAM BACK TO THE TARGET
-------------------------------------------
The backlog can still pass the target without the stretcher: a source that
delivers late and then catches up in a burst leaves the burst queued. On a
continuous speech stream nothing ever empties the queue, so that would be extra
delay for the rest of the call. Once the backlog passes ``WEBRTC_OUTPUT_MAX_MS``
(500), one quiet chunk in ``WEBRTC_TRIM_EVERY`` (3) is dropped until the backlog
is back at the target. As with the stretcher, voiced audio is never touched, and
neither is the chunk that carries the producer's future.

Only speech streams are trimmed. TTS audio (Ultravox, OpenAI Realtime, Gemini
Live and the TTS services) arrives faster than real time and waits ahead of the
playhead, so a large backlog there is speech made early, not delay, and
shortening its pauses would gain nothing.

``WEBRTC_OUTPUT_CUSHION_MS=0`` restores the stock lock-step behaviour;
``WEBRTC_STRETCH_EVERY=0`` keeps the hard cushion but disables stretching;
``WEBRTC_TRIM_EVERY=0`` disables trimming.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Optional

import numpy as np
from loguru import logger
from pipecat.frames.frames import (
    Frame,
    InterruptionFrame,
    OutputAudioRawFrame,
    SpeechOutputAudioRawFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

DEFAULT_CUSHION_MS = 60
DEFAULT_TARGET_MS = 300
#: On a continuous speech stream, a whole-output backlog above this is trimmed
#: back down to the target.
DEFAULT_MAX_MS = 500
DEFAULT_STRETCH_QUIET_DBFS = -50.0
#: Duplicate one quiet chunk in every N — a ~33% stretch of pause regions, which
#: is what the measurement below is sized against.
DEFAULT_STRETCH_EVERY = 3
#: While trimming, drop one quiet chunk in every N: pauses shrink by a third,
#: the reverse of the stretch.
DEFAULT_TRIM_EVERY = 3

# What _pause_action can decide for a chunk.
_STRETCH = "stretch"
_TRIM = "trim"


def cushioned(base: type) -> type:
    """Subclass of RawAudioTrack that releases backpressure at a queue depth."""

    class _CushionedRawAudioTrack(base):  # type: ignore[misc, valid-type]
        def __init__(self, *a: Any, **kw: Any) -> None:
            super().__init__(*a, **kw)
            ms = float(os.environ.get("WEBRTC_OUTPUT_CUSHION_MS", DEFAULT_CUSHION_MS))
            chunk_ms = 1000.0 * self._samples_per_10ms / max(1, self._sample_rate)
            self._chunk_ms = chunk_ms
            self._cushion_chunks = max(0, int(round(ms / chunk_ms)))
            target = float(os.environ.get("WEBRTC_OUTPUT_TARGET_MS", DEFAULT_TARGET_MS))
            self._target_chunks = max(self._cushion_chunks, int(round(target / chunk_ms)))
            self._target_ms = self._target_chunks * chunk_ms
            ceiling = float(os.environ.get("WEBRTC_OUTPUT_MAX_MS", DEFAULT_MAX_MS))
            self._max_ms = max(self._target_ms, ceiling)
            db = float(os.environ.get("WEBRTC_STRETCH_QUIET_DBFS", DEFAULT_STRETCH_QUIET_DBFS))
            self._quiet_peak = 32767.0 * (10.0 ** (db / 20.0))
            self._stretch_every = max(0, int(os.environ.get("WEBRTC_STRETCH_EVERY", DEFAULT_STRETCH_EVERY)))
            self._trim_every = max(0, int(os.environ.get("WEBRTC_TRIM_EVERY", DEFAULT_TRIM_EVERY)))
            self._quiet_seen = 0
            self._trimming = False
            self.stretched_chunks = 0
            self.trimmed_chunks = 0
            #: The largest whole-output backlog seen, in ms, for the per-call line.
            self.peak_backlog_ms = 0.0
            #: True while the audio reaching the transport is a continuous speech
            #: stream. OutputCushionInterrupt sets it from each frame's type.
            self.speech_stream = False
            # The transport's share of the backlog (see upstream_ms). The
            # instrumented base defines the probe as well; define it here too so
            # the cushion still works with the instrumentation switched off.
            if not hasattr(self, "inflight_probe"):
                self.inflight_probe = None
            self._handed_ms = 0.0
            self._upstream_offset_ms = 0.0

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
            # This audio has left the transport's queue for ours.
            self._handed_ms += 1000.0 * (len(audio_bytes) / 2) / max(1, self._sample_rate)

            future = asyncio.get_running_loop().create_future()
            step = self._bytes_per_10ms
            chunks = [audio_bytes[i : i + step] for i in range(0, len(audio_bytes), step)]
            if not chunks:
                future.set_result(True)
                return future

            # The whole output backlog once this batch is queued. Stretching and
            # trimming are decided against this, never against our queue alone:
            # see WHY THE CEILING COUNTS THE WHOLE BACKLOG.
            backlog = self.backlog_ms() + len(chunks) * self._chunk_ms
            if backlog > self.peak_backlog_ms:
                self.peak_backlog_ms = backlog

            # Hand the future to the chunk that leaves `cushion` behind it, so
            # the producer wakes while the queue still has that much to play.
            release = max(0, len(chunks) - 1 - cushion)
            for i, chunk in enumerate(chunks):
                action = self._pause_action(chunk, backlog)
                if action == _TRIM and i != release:
                    # A speech stream has fallen behind: shorten this pause. The
                    # chunk carrying the future is always kept, because the
                    # producer waits on it.
                    backlog -= self._chunk_ms
                    self.trimmed_chunks += 1
                    continue
                self._chunk_queue.append((chunk, future if i == release else None))
                if action == _STRETCH:
                    # Build the cushion out of the agent's own pauses. A quarter
                    # of in-turn agent audio is pause (measured: 60 s in 240 s,
                    # ~360 runs of >=40 ms), so repeating one quiet chunk in three
                    # banks ~67 ms of cushion per second of audio: 13x what a
                    # flat 95% playout rate would yield, and inaudible, because a
                    # repeated near-silent frame has no pitch to shift and no
                    # transient to smear. Voiced audio is never touched: that
                    # would need WSOLA, and these pods have little CPU to spare.
                    self._chunk_queue.append((chunk, None))
                    backlog += self._chunk_ms
                    self.stretched_chunks += 1

            # While the queue is still shallower than the cushion, do not hold
            # the producer at all: this is what lets the cushion form at the
            # start of a turn, when it is most needed and least available.
            if len(self._chunk_queue) <= cushion and not future.done():
                future.set_result(True)
            return future

        def _pause_action(self, chunk: bytes, backlog_ms: float) -> Optional[str]:
            """Repeat this chunk to lengthen a pause, drop it to shorten one, or neither.

            Only quiet chunks are ever touched, and only one in N of a run of
            them, so pauses change length and speech does not.
            """
            trim = self._trim_due(backlog_ms)
            stretch = self._stretch_every > 0 and backlog_ms < self._target_ms
            if not (trim or stretch):
                return None
            samples = np.frombuffer(chunk, dtype=np.int16)
            if samples.size == 0 or np.abs(samples).max() > self._quiet_peak:
                self._quiet_seen = 0          # voiced: never touched, and reset
                return None
            self._quiet_seen += 1
            if trim:
                return _TRIM if self._quiet_seen % self._trim_every == 0 else None
            return _STRETCH if self._quiet_seen % self._stretch_every == 0 else None

        def _trim_due(self, backlog_ms: float) -> bool:
            """Is a speech stream far enough behind to trim at this backlog?

            Trimming starts above the max and runs until the backlog is back at
            the target. The gap between the two stops the stretcher and the
            trimmer from taking turns on the same few chunks.
            """
            if self._trim_every <= 0 or not self.speech_stream:
                self._trimming = False
            elif backlog_ms > self._max_ms:
                self._trimming = True
            elif backlog_ms <= self._target_ms:
                self._trimming = False
            return self._trimming

        def upstream_ms(self) -> float:
            """Audio forwarded towards this track that it has not been handed yet.

            That is the audio in the transport's own queue: the total forwarded,
            from OutputCushionInterrupt's probe, less what has reached this
            track, less the offset set when the count was last anchored.
            """
            probe = self.inflight_probe
            if probe is None:
                return 0.0
            try:
                ahead = probe() - self._handed_ms - self._upstream_offset_ms
            except Exception:  # noqa: BLE001
                return 0.0
            if ahead < 0.0:
                # More reached us than was forwarded: the transport pads a turn's
                # last chunk with silence, and it can hand over a chunk after an
                # interruption anchored the count. It cannot hold less than
                # nothing, so anchor again here instead of keeping the error.
                self._upstream_offset_ms += ahead
                return 0.0
            return ahead

        def backlog_ms(self) -> float:
            """The whole output backlog: this track's queue plus the transport's."""
            return len(self._chunk_queue) * self._chunk_ms + self.upstream_ms()

        def anchor_upstream(self) -> None:
            """Count nothing as in flight from here on.

            Called when the probe is wired, because audio forwarded before this
            track existed was dropped by the transport and never reached a
            track, and on an interruption, because the transport empties its
            queue then.
            """
            probe = self.inflight_probe
            if probe is None:
                return
            try:
                self._upstream_offset_ms = probe() - self._handed_ms
            except Exception:  # noqa: BLE001
                pass

        def clear(self) -> int:
            """Drop everything queued — the caller has interrupted.

            Without this the cushion is a liability: the track plays out whatever
            it holds no matter what the pipeline decides, so a deeper queue means
            the agent talks over the caller for longer. Any future still riding a
            dropped chunk MUST be resolved here or write_audio_frame waits on it
            for ever and the leg goes silent.

            The transport empties its own queue on the same interruption, so the
            count of audio in flight starts again from zero.
            """
            n = len(self._chunk_queue)
            for _chunk, fut in self._chunk_queue:
                if fut is not None and not fut.done():
                    fut.set_result(True)
            self._chunk_queue.clear()
            self._quiet_seen = 0
            self._trimming = False
            self.anchor_upstream()
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

    The same number is half of the whole output backlog that the track's
    stretcher and trimmer steer by. The track anchors the count when the probe
    is wired and on each interruption. This processor also tells the track what
    kind of audio is arriving: a ``SpeechOutputAudioRawFrame`` is part of a
    continuous speech stream (GPT-Live), the only kind the track may trim.
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
            # Audio forwarded before this track existed never reached it.
            anchor = getattr(track, "anchor_upstream", None)
            if callable(anchor):
                anchor()
            self._wired = track

    def _note_audio(self, frame: OutputAudioRawFrame) -> None:
        """Count a frame on its way to the transport and tell the track its kind."""
        # Wire first: a new track anchors on the total so far, and this frame
        # then counts as in flight to it.
        self._wire_probe()
        rate = getattr(frame, "sample_rate", 0) or 0
        if rate:
            self._forwarded_ms += 1000.0 * (len(frame.audio) / 2) / rate
        track = self._wired
        if track is not None and hasattr(track, "speech_stream"):
            track.speech_stream = isinstance(frame, SpeechOutputAudioRawFrame)

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, OutputAudioRawFrame) and frame.audio:
            self._note_audio(frame)
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
