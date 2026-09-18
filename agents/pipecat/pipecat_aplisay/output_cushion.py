"""Release at the hard cushion, but cap stretching against the whole transport-plus-track backlog. See PRs #249 and
#311. Only continuous speech streams may be trimmed; TTS backlogs can contain valid speech produced ahead of time."""

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
                    # Repeat only quiet chunks to build the cushion without altering voiced audio. See PRs #251 and #311.
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
    """Clear the track as well as the transport on interruption; account for audio between them when limiting backlog.
    Place immediately before transport.output(); see PRs #251 and #311."""

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
