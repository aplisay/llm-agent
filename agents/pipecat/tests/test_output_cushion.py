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
"""

from __future__ import annotations

import asyncio

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
