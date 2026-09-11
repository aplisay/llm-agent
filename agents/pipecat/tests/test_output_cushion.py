"""The output queue is allowed to run ahead, so a short stall drains it not the wire.

Measured cause (see output_cushion's docstring): `write_audio_frame` awaits the
future `add_audio_bytes` returns, and the stock track hands that future to the
LAST chunk of the batch — so the producer is released only once the track has
drained everything. The queue is pinned near empty by design, and a stall of
more than a few tens of milliseconds becomes arithmetic zero on the wire.

These tests pin the two properties that make the fix a fix: the producer is
released while audio remains queued, and a stall the cushion is sized for is
absorbed without a single silent frame. Plus the shape of the parent's queue,
because we append to it directly and an upstream change there would break us
quietly.

They also pin the ceiling (2026-09-11). The stretcher counts the whole output
backlog, so a source that never stops sending (GPT-Live) cannot push its audio
further and further behind, and a speech stream that has fallen behind is
trimmed back to the target.
"""

from __future__ import annotations

import asyncio
from collections import deque
from dataclasses import dataclass
from typing import Optional

import pytest
from pipecat.transports.smallwebrtc.transport import RawAudioTrack

from pipecat_aplisay.output_cushion import cushioned, install

RATE = 16000
PER_CHUNK = RATE * 10 // 1000            # samples in 10 ms


def _track(monkeypatch: pytest.MonkeyPatch, ms: int):
    monkeypatch.setenv("WEBRTC_OUTPUT_CUSHION_MS", str(ms))
    return cushioned(RawAudioTrack)(sample_rate=RATE)


def _audio(chunks: int) -> bytes:
    return b"\x11\x11" * PER_CHUNK * chunks


def _is_silence(frame) -> bool:
    return not any(bytes(frame.planes[0]))


class TestBackpressure:
    def test_stock_behaviour_holds_the_producer_until_the_queue_drains(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The thing being fixed: nothing may accumulate."""

        async def run() -> None:
            t = _track(monkeypatch, 0)
            fut = t.add_audio_bytes(_audio(3))
            assert not fut.done(), "stock track releases only after the last chunk"
            for _ in range(3):
                await t.recv()
            assert fut.done()

        asyncio.run(run())

    def test_a_cushion_releases_the_producer_while_audio_is_still_queued(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def run() -> None:
            t = _track(monkeypatch, 60)          # 6 chunks
            fut = t.add_audio_bytes(_audio(3))
            assert fut.done(), "below the cushion the producer must not be held"
            assert len(t._chunk_queue) == 3, "and the audio stays queued"

        asyncio.run(run())

    def test_the_producer_is_held_once_the_cushion_is_full(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """It is a cushion, not an unbounded buffer — flow control still applies."""

        async def run() -> None:
            t = _track(monkeypatch, 60)
            for _ in range(3):
                t.add_audio_bytes(_audio(3))     # 9 chunks queued, over the cushion
            fut = t.add_audio_bytes(_audio(3))
            assert not fut.done(), "past the cushion the producer waits again"

        asyncio.run(run())


class TestStallsAreAbsorbed:
    def test_sixty_ms_of_stall_produces_no_silence(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The measured cluster is 20-60 ms. None of it should reach the wire."""

        async def run() -> None:
            t = _track(monkeypatch, 60)
            # producer runs until the cushion holds it
            while True:
                fut = t.add_audio_bytes(_audio(3))
                if not fut.done():
                    break
            # ...then stalls completely for six slots
            frames = [await t.recv() for _ in range(6)]
            assert not any(_is_silence(f) for f in frames), "a stall reached the wire"

        asyncio.run(run())

    def test_without_the_cushion_the_same_stall_reaches_the_wire(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The control: same stall, stock track, silence goes out."""

        async def run() -> None:
            t = _track(monkeypatch, 0)
            t.add_audio_bytes(_audio(3))         # all a held producer could deliver
            frames = [await t.recv() for _ in range(6)]
            assert sum(_is_silence(f) for f in frames) == 3

        asyncio.run(run())


class TestContract:
    def test_an_odd_sized_write_still_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def run() -> None:
            t = _track(monkeypatch, 60)
            with pytest.raises(ValueError, match="multiple of 10ms"):
                t.add_audio_bytes(b"\x00" * 7)

        asyncio.run(run())

    def test_the_parent_queue_is_still_chunk_future_pairs(self) -> None:
        """We append to _chunk_queue directly; if upstream changes its shape this
        breaks quietly, so fail loudly here instead."""

        async def run() -> None:
            stock = RawAudioTrack(sample_rate=RATE)
            stock.add_audio_bytes(_audio(2))
            assert len(stock._chunk_queue) == 2
            for entry in stock._chunk_queue:
                assert isinstance(entry, tuple) and len(entry) == 2
                chunk, fut = entry
                assert isinstance(chunk, (bytes, bytearray))
                assert fut is None or isinstance(fut, asyncio.Future)

        asyncio.run(run())

    def test_frames_are_identical_to_the_stock_track(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def run() -> None:
            a = RawAudioTrack(sample_rate=RATE)
            b = _track(monkeypatch, 60)
            a.add_audio_bytes(_audio(1))
            b.add_audio_bytes(_audio(1))
            fa, fb = await a.recv(), await b.recv()
            assert fa.sample_rate == fb.sample_rate and fa.samples == fb.samples
            assert bytes(fa.planes[0]) == bytes(fb.planes[0])

        asyncio.run(run())


class TestInstall:
    def test_install_is_idempotent_and_disabled_by_zero(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from pipecat.transports.smallwebrtc import transport as t

        original = t.RawAudioTrack
        try:
            monkeypatch.setenv("WEBRTC_OUTPUT_CUSHION_MS", "60")
            assert install() is True
            assert t.RawAudioTrack.__name__ == "CushionedRawAudioTrack"
            assert install() is False
        finally:
            t.RawAudioTrack = original
        monkeypatch.setenv("WEBRTC_OUTPUT_CUSHION_MS", "0")
        assert install() is False
        assert t.RawAudioTrack is original

    def test_it_layers_over_the_instrumented_track(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Both must survive: we still want to measure what the cushion changed."""
        from pipecat.transports.smallwebrtc import transport as t

        from pipecat_aplisay.output_underrun import install as install_stats

        original = t.RawAudioTrack
        try:
            monkeypatch.setenv("WEBRTC_UNDERRUN_STATS", "1")
            monkeypatch.setenv("WEBRTC_OUTPUT_CUSHION_MS", "60")
            assert install_stats() is True
            assert install() is True
            made = t.RawAudioTrack(sample_rate=RATE)
            assert hasattr(made, "underrun"), "lost the instrumentation"
            assert made._cushion_chunks == 6

            # Attributes surviving is not the same as the instrument WORKING.
            # The cushion reimplements add_audio_bytes instead of delegating,
            # so unless it calls the refill hook the event never closes and the
            # counters read zero for ever — which is exactly what happened on
            # the first call after this shipped.
            async def starve_then_refill() -> None:
                await made.recv()          # queue empty: starvation begins
                await made.recv()
                made.add_audio_bytes(_audio(1))

            asyncio.run(starve_then_refill())
            assert made.underrun.events == 1, "the cushion swallowed the measurement"
            assert made.underrun.max_gap_ms == pytest.approx(20.0)
        finally:
            t.RawAudioTrack = original


class TestPauseStretching:
    """Build the cushion out of the agent's own pauses.

    Measured on two calls: ~25% of in-turn agent audio is pause (60 s in 240 s),
    across ~360 runs of >=40 ms. Repeating one quiet chunk in three banks ~67 ms
    of cushion per second of audio — against 5 ms/s for a flat 95% playout rate,
    and with no pitch shift to hear, because a repeated near-silent frame has
    neither pitch nor transient.
    """

    def _quiet(self, chunks: int) -> bytes:
        return b"\x05\x00" * PER_CHUNK * chunks      # ~-76 dBFS

    def test_quiet_chunks_are_repeated_to_lengthen_a_pause(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def run() -> None:
            t = _track(monkeypatch, 60)
            t.add_audio_bytes(self._quiet(9))
            # one in three repeated => 9 in, 12 queued
            assert len(t._chunk_queue) == 12
            assert t.stretched_chunks == 3

        asyncio.run(run())

    def test_voiced_audio_is_never_stretched(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Stretching speech would need WSOLA and would be audible; this must
        only ever touch pauses."""

        async def run() -> None:
            t = _track(monkeypatch, 60)
            t.add_audio_bytes(_audio(9))          # loud
            assert len(t._chunk_queue) == 9
            assert t.stretched_chunks == 0

        asyncio.run(run())

    def test_stretching_stops_at_the_target(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def run() -> None:
            monkeypatch.setenv("WEBRTC_OUTPUT_TARGET_MS", "100")   # 10 chunks
            t = _track(monkeypatch, 60)
            for _ in range(6):
                t.add_audio_bytes(self._quiet(3))
            assert len(t._chunk_queue) >= 10
            # once at target, no further repeats
            before = t.stretched_chunks
            t.add_audio_bytes(self._quiet(3))
            assert t.stretched_chunks == before

        asyncio.run(run())

    def test_a_voiced_chunk_resets_the_run(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Two pauses of two quiet chunks each must not add up to a repeat that
        lands in the middle of the speech between them."""

        async def run() -> None:
            t = _track(monkeypatch, 60)
            t.add_audio_bytes(self._quiet(2) + _audio(1) + self._quiet(2))
            assert t.stretched_chunks == 0

        asyncio.run(run())

    def test_disabled_by_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def run() -> None:
            monkeypatch.setenv("WEBRTC_STRETCH_EVERY", "0")
            t = _track(monkeypatch, 60)
            t.add_audio_bytes(self._quiet(9))
            assert t.stretched_chunks == 0
            assert len(t._chunk_queue) == 9

        asyncio.run(run())


class TestClearOnInterruption:
    def test_clear_drops_the_queue(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def run() -> None:
            t = _track(monkeypatch, 60)
            t.add_audio_bytes(_audio(5))
            assert t.clear() == 5
            assert len(t._chunk_queue) == 0

        asyncio.run(run())

    def test_clear_resolves_a_future_riding_a_dropped_chunk(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Otherwise write_audio_frame waits on it for ever and the leg dies."""

        async def run() -> None:
            t = _track(monkeypatch, 60)
            for _ in range(4):
                fut = t.add_audio_bytes(_audio(3))
                if not fut.done():
                    break
            assert not fut.done(), "expected a held producer to set the test up"
            t.clear()
            assert fut.done(), "clear() stranded the producer"

        asyncio.run(run())

    def test_the_processor_clears_the_live_track(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from types import SimpleNamespace

        from pipecat.frames.frames import InterruptionFrame

        from pipecat_aplisay.output_cushion import OutputCushionInterrupt

        async def run() -> None:
            t = _track(monkeypatch, 60)
            t.add_audio_bytes(_audio(4))
            transport = SimpleNamespace(_client=SimpleNamespace(_audio_output_track=t))
            proc = OutputCushionInterrupt(output_transport=transport)
            assert proc._track() is t
            proc._track().clear()
            assert len(t._chunk_queue) == 0

        asyncio.run(run())

    def test_the_private_path_to_the_track_still_exists(self) -> None:
        """We reach the track through two private attributes. If pipecat renames
        either, fail here rather than let barge-in quietly regress."""
        import inspect

        from pipecat.transports.smallwebrtc.transport import (
            SmallWebRTCClient,
            SmallWebRTCOutputTransport,
        )

        # transport.output() -> _client
        init = inspect.getsource(SmallWebRTCOutputTransport.__init__)
        assert "self._client = client" in init, (
            "SmallWebRTCOutputTransport no longer stores the client as _client — "
            "OutputCushionInterrupt._track() cannot reach the track"
        )
        # _client -> _audio_output_track
        client_src = inspect.getsource(SmallWebRTCClient)
        assert "self._audio_output_track = RawAudioTrack(" in client_src, (
            "SmallWebRTCClient no longer holds the output track as _audio_output_track — "
            "barge-in will not clear the queue"
        )


class TestInflightProbe:
    """Did the audio exist and we failed to move it, or had it not arrived?

    The transport's own audio queue is an UNBOUNDED asyncio.Queue, so holding
    the track's future never back-pressures anything upstream — frames simply
    accumulate there. Which means a starve has two possible causes with opposite
    fixes: audio waiting in that queue (ours to move) versus nothing arriving
    (upstream's to deliver). Every OutputAudioRawFrame passes through the
    processor and everything the track holds passed through it first, so the
    difference between the two counters is exactly what is sitting in between.

    The track anchors that count when the probe is wired, since audio forwarded
    before a track existed was dropped by the transport. So these tests wire
    first and forward after, as the processor does.
    """

    def _mk(self, monkeypatch: pytest.MonkeyPatch):
        from types import SimpleNamespace

        from pipecat_aplisay.output_cushion import OutputCushionInterrupt
        from pipecat_aplisay.output_underrun import instrumented

        monkeypatch.setenv("WEBRTC_OUTPUT_CUSHION_MS", "60")
        track = cushioned(instrumented(RawAudioTrack))(sample_rate=RATE)
        transport = SimpleNamespace(_client=SimpleNamespace(_audio_output_track=track))
        return track, OutputCushionInterrupt(output_transport=transport)

    def test_audio_waiting_in_the_transport_is_visible_at_a_starve(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def run() -> None:
            track, proc = self._mk(monkeypatch)
            proc._wire_probe()
            proc._forwarded_ms += 100.0         # 100 ms forwarded downstream...
            track.add_audio_bytes(_audio(3))    # ...of which 30 ms reached the track
            for _ in range(3):
                await track.recv()
            await track.recv()                  # queue now empty: starve begins
            assert track.underrun.inflight_at_starve, "nothing sampled"
            assert track.underrun.inflight_at_starve[0] == pytest.approx(70.0, abs=1.0)
            # the starve is still OPEN — summary() only reports once an event
            # closes, so give it the refill that closes one
            track.add_audio_bytes(_audio(1))
            assert "starved with audio waiting" in track.underrun.summary()

        asyncio.run(run())

    def test_nothing_in_flight_reads_as_zero(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The other answer: upstream had delivered everything it had."""

        async def run() -> None:
            track, proc = self._mk(monkeypatch)
            proc._wire_probe()
            proc._forwarded_ms += 30.0
            track.add_audio_bytes(_audio(3))    # all 30 ms handed over
            for _ in range(3):
                await track.recv()
            await track.recv()
            assert track.underrun.inflight_at_starve[0] == pytest.approx(0.0, abs=1.0)

        asyncio.run(run())

    def test_the_processor_counts_what_it_forwards(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from pipecat.frames.frames import OutputAudioRawFrame

        async def run() -> None:
            track, proc = self._mk(monkeypatch)
            f = OutputAudioRawFrame(audio=_audio(5), sample_rate=RATE, num_channels=1)
            # _note_audio is what process_frame runs for each audio frame; call
            # it directly, since process_frame needs a running processor
            proc._note_audio(f)
            assert proc._forwarded_ms == pytest.approx(50.0)
            assert track.upstream_ms() == pytest.approx(50.0), "the frame is in flight"

        asyncio.run(run())


class TestStretcherIsVisible:
    def test_the_per_call_line_reports_what_the_stretcher_banked(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Counted but never logged is the same as not measured — that gap cost
        a run's worth of ambiguity about whether the stretcher had fired."""
        from loguru import logger

        from pipecat_aplisay.output_underrun import instrumented

        monkeypatch.setenv("WEBRTC_OUTPUT_CUSHION_MS", "60")
        lines: list[str] = []
        sink = logger.add(lines.append, format="{message}", level="INFO")
        try:
            t = cushioned(instrumented(RawAudioTrack))(sample_rate=RATE)

            async def run() -> None:
                t.add_audio_bytes(b"\x05\x00" * PER_CHUNK * 9)   # quiet: stretchable
                await t.recv()

            asyncio.run(run())
            assert t.stretched_chunks == 3
            t.stop()
            banked = [l for l in lines if "stretched 3 chunks" in l]
            assert banked, lines
            assert "banked from pauses" in banked[0]
        finally:
            logger.remove(sink)

    def test_the_per_call_line_reports_trims_and_the_peak_backlog(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The peak backlog is the number that shows whether the output fell
        behind at all; the trims show how much of it was recovered."""
        from loguru import logger

        from pipecat_aplisay.output_underrun import instrumented

        monkeypatch.setenv("WEBRTC_OUTPUT_CUSHION_MS", "60")
        lines: list[str] = []
        sink = logger.add(lines.append, format="{message}", level="INFO")
        try:
            t = cushioned(instrumented(RawAudioTrack))(sample_rate=RATE)

            async def run() -> None:
                forwarded = _wire(t)
                forwarded[0] += 1000.0          # a second of audio already waiting
                t.speech_stream = True
                for _ in range(3):
                    t.add_audio_bytes(_quiet(3))
                await t.recv()

            asyncio.run(run())
            assert t.trimmed_chunks == 3
            t.stop()
            (line,) = [l for l in lines if "track finished" in l]
            assert "trimmed 3 quiet chunks" in line, line
            assert "peak output backlog 1000 ms" in line, line
        finally:
            logger.remove(sink)


def _quiet(chunks: int) -> bytes:
    return b"\x05\x00" * PER_CHUNK * chunks      # ~-76 dBFS: a pause


def _wire(track) -> list[float]:
    """Wire a forwarded-audio counter to the track, as OutputCushionInterrupt
    does. Add to the returned counter to put audio in the transport's queue."""
    forwarded = [0.0]
    track.inflight_probe = lambda: forwarded[0]
    track.anchor_upstream()
    return forwarded


@dataclass
class _Played:
    backlog: list[float]                 # whole output backlog after each step, ms
    first_voiced_step: Optional[int]     # when the first voiced chunk played


async def _play(track, steps: int, source) -> _Played:
    """Drive a track the way the transport and the pacer do, 10 ms per step.

    ``source(step)`` returns the audio the model delivers at that step, or b"".
    The transport splits it into 40 ms pieces in its own queue, hands the track
    one piece at a time, and waits on the future each hand-over returns. The
    pacer plays one chunk per step.
    """
    forwarded = _wire(track)
    piece = 4 * PER_CHUNK * 2
    waiting: deque[bytes] = deque()      # the transport's own queue
    held = None                          # the future the transport waits on
    backlog: list[float] = []
    first_voiced = None
    for step in range(steps):
        audio = source(step)
        if audio:
            for i in range(0, len(audio), piece):
                waiting.append(audio[i : i + piece])
            forwarded[0] += 1000.0 * (len(audio) / 2) / RATE
        while waiting and (held is None or held.done()):
            held = track.add_audio_bytes(waiting.popleft())
        if track._chunk_queue:
            chunk, fut = track._chunk_queue.popleft()
            if fut is not None and not fut.done():
                fut.set_result(True)
            if first_voiced is None and chunk[:2] == b"\x11\x11":
                first_voiced = step
        backlog.append(track.backlog_ms())
    return _Played(backlog, first_voiced)


class TestContinuousSpeechStreams:
    """GPT-Live streams audio at real-time pace, silence included, and never stops.

    Staging, 2026-09-11: the stretcher's ceiling counted only this track's queue,
    which backpressure holds at 6-10 chunks, so it never engaged. Every repeated
    chunk stayed in the transport's queue as delay: 1800 chunks in a 109 s call,
    and the replies reached the caller many seconds after their transcript.
    """

    @staticmethod
    def _stream(reply_at: Optional[int] = None):
        """40 ms frames at real-time pace: silence, then speech from ``reply_at``."""

        def source(step: int) -> bytes:
            if step % 4:
                return b""
            if reply_at is not None and step >= reply_at:
                return _audio(4)
            return _quiet(4)

        return source

    def test_the_backlog_settles_at_the_target_instead_of_growing(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def run() -> None:
            t = _track(monkeypatch, 60)
            t.speech_stream = True
            played = await _play(t, 110 * 100, self._stream())
            # Counting only the track's queue, this grew by a quarter of the
            # elapsed time: over 27 s after 110 s of silence.
            assert max(played.backlog) <= 300 + 60, max(played.backlog)
            assert t.stretched_chunks <= 40, t.stretched_chunks

        asyncio.run(run())

    def test_a_reply_after_a_minute_plays_within_the_target(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The number the caller hears: how long after the model speaks the
        audio plays, however long the call has run."""

        async def run() -> None:
            t = _track(monkeypatch, 60)
            t.speech_stream = True
            reply_at = 60 * 100
            played = await _play(t, reply_at + 200, self._stream(reply_at))
            assert played.first_voiced_step is not None, "the reply never played"
            delay_ms = (played.first_voiced_step - reply_at) * 10
            assert delay_ms <= 300 + 60, delay_ms

        asyncio.run(run())

    def test_audio_waiting_in_the_transport_stops_the_stretcher(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        async def run() -> None:
            t = _track(monkeypatch, 60)
            forwarded = _wire(t)
            forwarded[0] += 400.0                # already more than the target
            t.add_audio_bytes(_quiet(9))
            assert t.stretched_chunks == 0
            assert len(t._chunk_queue) == 9

        asyncio.run(run())


class TestTurnBasedSources:
    """Ultravox and the TTS services stop sending between turns, so the queue
    empties and a stretch never outlives its turn. That must keep working."""

    def test_a_turn_still_builds_its_cushion_and_the_gap_empties_it(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        def source(step: int) -> bytes:
            if step % 4 or (step // 500) % 2:    # 5 s turns, then 5 s gaps
                return b""
            # a quarter of each turn is pause, as measured on Ultravox
            return _quiet(4) if (step // 40) % 4 == 3 else _audio(4)

        async def run() -> None:
            t = _track(monkeypatch, 60)
            played = await _play(t, 2000, source)
            assert t.stretched_chunks > 0, "the stretcher must still build a cushion"
            assert max(played.backlog) <= 300 + 60, max(played.backlog)
            assert played.backlog[999] == 0.0, "the gap between turns empties the queue"

        asyncio.run(run())


class TestTrimming:
    """A speech stream that has fallen behind is brought back to the target."""

    def test_a_burst_on_a_speech_stream_is_trimmed_back_to_the_target(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Late audio that arrives in a burst would otherwise stay queued as delay
        for the rest of the call, because the stream never stops."""

        def source(step: int) -> bytes:
            if step == 0:
                return _quiet(100)               # a second of audio at once
            return _quiet(4) if step % 4 == 0 else b""

        async def run() -> None:
            t = _track(monkeypatch, 60)
            t.speech_stream = True
            played = await _play(t, 1000, source)
            assert played.backlog[0] > 500
            assert t.trimmed_chunks > 0
            assert max(played.backlog[500:]) <= 300 + 60, max(played.backlog[500:])

        asyncio.run(run())

    def test_voiced_audio_is_never_trimmed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def run() -> None:
            t = _track(monkeypatch, 60)
            t.speech_stream = True
            forwarded = _wire(t)
            forwarded[0] += 1000.0
            t.add_audio_bytes(_audio(9))
            assert t.trimmed_chunks == 0
            assert len(t._chunk_queue) == 9

        asyncio.run(run())

    def test_the_chunk_carrying_the_future_is_kept(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The transport waits on that future. Dropping its chunk would hold the
        producer for ever and the call would go silent."""

        async def run() -> None:
            t = _track(monkeypatch, 60)
            t.speech_stream = True
            forwarded = _wire(t)
            forwarded[0] += 1000.0
            t.add_audio_bytes(_audio(10))        # a full queue: the producer is held
            t._quiet_seen = 2                    # the next quiet chunk is due a trim
            fut = t.add_audio_bytes(_quiet(4))   # ...and that chunk carries the future
            assert t.trimmed_chunks == 1, "the fourth chunk goes instead"
            assert not fut.done()
            assert any(f is fut for _chunk, f in t._chunk_queue), "the future was dropped"
            while t._chunk_queue:
                _chunk, f = t._chunk_queue.popleft()
                if f is not None and not f.done():
                    f.set_result(True)
            assert fut.done()

        asyncio.run(run())

    def test_tts_audio_is_not_trimmed(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """TTS arrives faster than real time, so a deep queue there is speech
        made early. Shortening its pauses would gain nothing."""

        async def run() -> None:
            t = _track(monkeypatch, 60)          # speech_stream stays False
            forwarded = _wire(t)
            forwarded[0] += 1000.0
            t.add_audio_bytes(_quiet(9))
            assert t.trimmed_chunks == 0
            assert len(t._chunk_queue) == 9

        asyncio.run(run())

    def test_disabled_by_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def run() -> None:
            monkeypatch.setenv("WEBRTC_TRIM_EVERY", "0")
            t = _track(monkeypatch, 60)
            t.speech_stream = True
            forwarded = _wire(t)
            forwarded[0] += 1000.0
            t.add_audio_bytes(_quiet(9))
            assert t.trimmed_chunks == 0

        asyncio.run(run())

    def test_trimming_runs_on_to_the_target(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """It starts above the max and stops at the target, so the stretcher
        and the trimmer do not take turns on the same chunks."""
        t = _track(monkeypatch, 60)
        t.speech_stream = True
        assert t._trim_due(600.0) is True        # over the max: start
        assert t._trim_due(400.0) is True        # between the two: keep going
        assert t._trim_due(300.0) is False       # at the target: stop
        assert t._trim_due(400.0) is False       # between again: stay stopped


class TestInFlightCount:
    """The transport's share of the backlog is the difference of two running
    totals, so each way they can drift apart has to be handled."""

    def test_audio_forwarded_before_the_track_existed_is_not_counted(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The transport drops audio while it has no track. Counting it would
        read as seconds of backlog for the whole call."""

        async def run() -> None:
            t = _track(monkeypatch, 60)
            forwarded = [5000.0]
            t.inflight_probe = lambda: forwarded[0]
            t.anchor_upstream()
            assert t.upstream_ms() == 0.0
            forwarded[0] += 40.0
            assert t.upstream_ms() == pytest.approx(40.0)

        asyncio.run(run())

    def test_an_interruption_starts_the_count_again(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The transport empties its queue on an interruption, so what was
        waiting there will never arrive."""

        async def run() -> None:
            t = _track(monkeypatch, 60)
            forwarded = _wire(t)
            forwarded[0] += 800.0
            assert t.upstream_ms() == pytest.approx(800.0)
            t.clear()
            assert t.upstream_ms() == 0.0
            forwarded[0] += 40.0
            assert t.upstream_ms() == pytest.approx(40.0)

        asyncio.run(run())

    def test_more_arriving_than_was_forwarded_reads_as_nothing_waiting(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The transport pads a turn's last chunk with silence, so a little more
        can reach the track than was forwarded. Later counts must not come up
        short because of it."""

        async def run() -> None:
            t = _track(monkeypatch, 60)
            forwarded = _wire(t)
            forwarded[0] += 30.0
            t.add_audio_bytes(_audio(4))         # 40 ms arrived: 10 ms of padding
            assert t.upstream_ms() == 0.0
            forwarded[0] += 100.0
            assert t.upstream_ms() == pytest.approx(100.0)

        asyncio.run(run())

    def test_the_processor_anchors_a_new_track_before_counting_the_frame(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from types import SimpleNamespace

        from pipecat.frames.frames import OutputAudioRawFrame

        from pipecat_aplisay.output_cushion import OutputCushionInterrupt

        async def run() -> None:
            client = SimpleNamespace(_audio_output_track=None)
            proc = OutputCushionInterrupt(output_transport=SimpleNamespace(_client=client))
            frame = OutputAudioRawFrame(audio=_quiet(4), sample_rate=RATE, num_channels=1)
            proc._note_audio(frame)              # no track yet: the transport drops it
            t = _track(monkeypatch, 60)
            client._audio_output_track = t
            proc._note_audio(frame)
            assert t.upstream_ms() == pytest.approx(40.0), "only the second frame is waiting"

        asyncio.run(run())


class TestFrameKinds:
    def test_speech_stream_frames_mark_the_track_and_tts_frames_do_not(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from types import SimpleNamespace

        from pipecat.frames.frames import SpeechOutputAudioRawFrame, TTSAudioRawFrame

        from pipecat_aplisay.output_cushion import OutputCushionInterrupt

        async def run() -> None:
            t = _track(monkeypatch, 60)
            transport = SimpleNamespace(_client=SimpleNamespace(_audio_output_track=t))
            proc = OutputCushionInterrupt(output_transport=transport)
            proc._note_audio(
                SpeechOutputAudioRawFrame(audio=_quiet(4), sample_rate=RATE, num_channels=1)
            )
            assert t.speech_stream is True
            proc._note_audio(TTSAudioRawFrame(audio=_quiet(4), sample_rate=RATE, num_channels=1))
            assert t.speech_stream is False

        asyncio.run(run())
