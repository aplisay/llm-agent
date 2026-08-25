"""The output track reports how long it starved for, and how late the audio was.

A rig comparing the platform's own recording tap against the browser's decoder
found gaps that exist only in the browser copy — arithmetic zero, with packets
flowing and nothing lost or concealed. That is ``RawAudioTrack.recv()`` finding
an empty queue and sending ``bytes(bytes_per_10ms)``.

These tests pin the measurement that decides what to do about it: **lateness**.
Audio that turns up a few tens of milliseconds after the queue ran dry could
have been covered by a cushion. Audio that never turns up could not have been,
by anything, and the fix would belong upstream. A counter that only said "an
underrun happened" would not tell those two apart, and that is the whole point.
"""

from __future__ import annotations

import asyncio
import time

import pytest
from pipecat.transports.smallwebrtc.transport import RawAudioTrack

from pipecat_aplisay.output_underrun import install, instrumented

RATE = 16000
CHUNK = RATE * 10 // 1000 * 2  # bytes in 10 ms of s16 mono


def _track(**kw):
    return instrumented(RawAudioTrack)(sample_rate=RATE, **kw)


def _audio(chunks: int = 1) -> bytes:
    return b"\x01\x00" * (RATE * 10 // 1000) * chunks


class TestStarvationIsCounted:
    def test_a_full_queue_never_reports_an_underrun(self) -> None:
        async def run() -> None:
            t = _track()
            t.add_audio_bytes(_audio(3))
            for _ in range(3):
                await t.recv()
            assert t.underrun.events == 0
            assert t.underrun.chunks_filled == 0
            assert "no output underruns" in t.underrun.summary()

        asyncio.run(run())

    def test_an_empty_queue_is_counted_as_inserted_silence(self) -> None:
        async def run() -> None:
            t = _track()
            for _ in range(4):
                await t.recv()
            assert t.underrun.chunks_filled == 4
            assert t.underrun.silence_ms == pytest.approx(40.0)
            # still open — nothing has come back yet, so there is no lateness
            assert t.underrun.events == 0

        asyncio.run(run())

    def test_the_event_closes_when_real_audio_returns(self) -> None:
        async def run() -> None:
            t = _track()
            for _ in range(3):
                await t.recv()
            t.add_audio_bytes(_audio())
            assert t.underrun.events == 1
            assert t.underrun.max_gap_ms == pytest.approx(30.0)

        asyncio.run(run())


class TestLatenessIsTheAnswer:
    """The distinction the whole module exists for."""

    def test_late_audio_reports_a_lateness_a_cushion_could_cover(self) -> None:
        async def run() -> None:
            t = _track()
            await t.recv()                      # queue dry
            await asyncio.sleep(0.05)           # ...audio is 50 ms late
            t.add_audio_bytes(_audio())
            assert t.underrun.events == 1
            (late,) = t.underrun.late_ms
            assert 40 <= late <= 200, late
            summary = t.underrun.summary()
            assert "refill lateness" in summary, summary
            assert "0 never refilled" in summary, summary

        asyncio.run(run())

    def test_audio_that_never_returns_is_reported_separately(self) -> None:
        """The case no amount of buffering can fix: the track ends still starved."""

        async def run() -> None:
            t = _track()
            for _ in range(5):
                await t.recv()
            t.stop()
            assert t.underrun.never_refilled == 1
            assert t.underrun.late_ms == [], "nothing arrived, so nothing can be late"

        asyncio.run(run())

    def test_lateness_is_measured_from_the_starve_not_the_refill_slot(self) -> None:
        """Closing on add_audio_bytes rather than the next recv() keeps up to one
        slot of error out of the number the decision rests on."""

        async def run() -> None:
            t = _track()
            await t.recv()
            t0 = time.monotonic()
            await asyncio.sleep(0.03)
            t.add_audio_bytes(_audio())
            measured = t.underrun.late_ms[0]
            elapsed = (time.monotonic() - t0) * 1000.0
            assert measured >= elapsed - 5, (measured, elapsed)

        asyncio.run(run())


class TestQueueDepth:
    def test_depth_is_sampled_every_slot(self) -> None:
        """If the queue normally sits at 0 or 1 there is no cushion at all, and
        that is what would justify adding one."""

        async def run() -> None:
            t = _track()
            t.add_audio_bytes(_audio(3))
            for _ in range(3):
                await t.recv()
            assert t.underrun.recvs == 3
            assert sum(t.underrun.depth.values()) == 3
            assert t.underrun.depth["3-5"] == 1     # first recv saw 3 queued
            assert t.underrun.depth["2"] == 1
            assert t.underrun.depth["1"] == 1

        asyncio.run(run())


class TestInstall:
    def test_install_is_idempotent_and_reversible_by_env(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        from pipecat.transports.smallwebrtc import transport as t

        original = t.RawAudioTrack
        try:
            monkeypatch.setenv("WEBRTC_UNDERRUN_STATS", "1")
            assert install() is True
            assert t.RawAudioTrack.__name__ == "InstrumentedRawAudioTrack"
            assert install() is False, "must not wrap the wrapper"
        finally:
            t.RawAudioTrack = original

    def test_disabled_by_env(self, monkeypatch: pytest.MonkeyPatch) -> None:
        from pipecat.transports.smallwebrtc import transport as t

        original = t.RawAudioTrack
        monkeypatch.setenv("WEBRTC_UNDERRUN_STATS", "0")
        assert install() is False
        assert t.RawAudioTrack is original

    def test_the_subclass_still_paces_and_emits_like_the_original(self) -> None:
        """Observation only — the parent's pacing and frame shape must survive."""

        async def run() -> None:
            plain = RawAudioTrack(sample_rate=RATE)
            inst = _track()
            plain.add_audio_bytes(_audio())
            inst.add_audio_bytes(_audio())
            a, b = await plain.recv(), await inst.recv()
            assert a.sample_rate == b.sample_rate
            assert a.samples == b.samples
            assert bytes(a.planes[0]) == bytes(b.planes[0])

        asyncio.run(run())
