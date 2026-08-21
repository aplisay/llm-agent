"""The output rate guard makes the resampler-latch failure impossible.

Background: ``BaseOutputTransport``'s ``MediaSender`` holds ONE
``SOXRStreamAudioResampler`` for the whole call, and it latches the first
``(in_rate, out_rate)`` pair it is handed — every later pair raises and the
frame is DROPPED, silently and permanently (2026-08-21 beta incident: 1283
frames lost over 55 s of dead air).

The guard sits immediately before ``transport.output()`` and rewrites every
outbound frame to the transport's own rate. Because ``resample()``
short-circuits on equal rates, the transport's resampler is then never
constructed at all and can never latch. That is the invariant these tests pin.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import OutputAudioRawFrame, TTSAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import run_test

from pipecat_aplisay.output_rate_guard import OutputRateGuard, _RateAgileResampler


def _pcm(samples: int) -> bytes:
    """`samples` frames of s16le silence."""
    return b"\x00\x00" * samples


def _guard(rate) -> OutputRateGuard:
    return OutputRateGuard(output_transport=SimpleNamespace(sample_rate=rate))


class TestRateAgileResampler:
    def test_equal_rates_pass_through_untouched(self) -> None:
        async def run() -> None:
            r = _RateAgileResampler()
            audio = _pcm(160)
            assert await r.resample(audio, 16000, 16000) is audio

        asyncio.run(run())

    def test_the_stock_resampler_really_does_latch(self) -> None:
        """Guards the premise. If pipecat ever makes this survivable upstream,
        this test fails and _RateAgileResampler can be deleted."""

        async def run() -> None:
            stock = create_stream_resampler()
            await stock.resample(_pcm(480), 24000, 16000)
            with pytest.raises(ValueError, match="cannot be reused"):
                await stock.resample(_pcm(960), 48000, 16000)

        asyncio.run(run())

    def test_survives_a_rate_change_that_would_latch_the_stock_resampler(self) -> None:
        """The exact incident sequence: 24k->16k, then 48k->16k.

        soxr's ResampleStream emits in bursts (it holds filter delay), so an
        individual chunk may legitimately return b"" — the invariant is that
        the rate change does not RAISE and that audio keeps coming out
        afterwards, which is precisely what the stock resampler stops doing.
        """

        async def run() -> None:
            r = _RateAgileResampler()
            before = 0
            for _ in range(6):
                before += len(await r.resample(_pcm(480), 24000, 16000))
            assert before > 0
            after = 0
            for _ in range(6):
                after += len(await r.resample(_pcm(960), 48000, 16000))
            assert after > 0, "no audio survived the rate change"

        asyncio.run(run())

    def test_many_alternating_rates_all_produce_audio(self) -> None:
        async def run() -> None:
            r = _RateAgileResampler()
            for rate in (24000, 48000, 24000, 8000, 48000):
                out = 0
                for _ in range(6):
                    out += len(await r.resample(_pcm(rate // 50), rate, 16000))
                assert out > 0, f"{rate} produced nothing"

        asyncio.run(run())


class TestGuardRewritesToTransportRate:
    def test_mismatched_frame_is_converted(self) -> None:
        async def run() -> None:
            guard = _guard(16000)
            frame = OutputAudioRawFrame(_pcm(1200), sample_rate=24000, num_channels=1)
            await run_test(
                guard,
                frames_to_send=[frame],
                expected_down_frames=[OutputAudioRawFrame],
            )
            # Converted IN PLACE, so the transport downstream sees its own rate
            # and its resampler takes the equal-rates fast path.
            assert frame.sample_rate == 16000

        asyncio.run(run())

    def test_matching_frame_is_left_alone(self) -> None:
        async def run() -> None:
            guard = _guard(16000)
            audio = _pcm(320)
            frame = OutputAudioRawFrame(audio, sample_rate=16000, num_channels=1)
            await run_test(
                guard,
                frames_to_send=[frame],
                expected_down_frames=[OutputAudioRawFrame],
            )
            assert frame.sample_rate == 16000
            assert frame.audio is audio  # not round-tripped through soxr

        asyncio.run(run())

    def test_subclass_identity_survives(self) -> None:
        """TTSAudioRawFrame must stay a TTSAudioRawFrame — base_output keys off
        ``type(frame)`` when it chunks, and callers match on the subclass."""

        async def run() -> None:
            guard = _guard(16000)
            frame = TTSAudioRawFrame(_pcm(1200), sample_rate=24000, num_channels=1)
            await run_test(
                guard,
                frames_to_send=[frame],
                expected_down_frames=[TTSAudioRawFrame],
            )
            assert isinstance(frame, TTSAudioRawFrame)
            assert frame.sample_rate == 16000

        asyncio.run(run())

    def test_inert_before_the_transport_has_started(self) -> None:
        """``BaseOutputTransport.sample_rate`` is 0 until its StartFrame lands;
        the guard must pass frames through rather than resample to zero."""

        async def run() -> None:
            guard = _guard(0)
            frame = OutputAudioRawFrame(_pcm(480), sample_rate=24000, num_channels=1)
            await run_test(
                guard,
                frames_to_send=[frame],
                expected_down_frames=[OutputAudioRawFrame],
            )
            assert frame.sample_rate == 24000

        asyncio.run(run())

    def test_a_resample_failure_never_swallows_the_frame(self) -> None:
        """The guard must not become a new way to lose audio."""

        async def run() -> None:
            guard = _guard(16000)

            class _Boom:
                async def resample(self, *_a, **_k):
                    raise RuntimeError("soxr exploded")

            guard._resampler = _Boom()
            frame = OutputAudioRawFrame(_pcm(480), sample_rate=24000, num_channels=1)
            await run_test(
                guard,
                frames_to_send=[frame],
                expected_down_frames=[OutputAudioRawFrame],
            )
            # Passed through untouched — the transport then behaves exactly as
            # it would have without the guard, no worse.
            assert frame.sample_rate == 24000

        asyncio.run(run())


class TestTheIncidentCannotRecur:
    def test_tone_then_agent_audio_both_reach_the_transport_at_one_rate(self) -> None:
        """Replays the live sequence through the guard.

        24 kHz comfort tone first (what latched the resampler), then 48 kHz
        Ultravox audio. Both must emerge at the transport's 16 kHz, so the
        transport only ever sees equal rates and never builds a stream at all.
        """

        async def run() -> None:
            guard = _guard(16000)
            tone = OutputAudioRawFrame(_pcm(480), sample_rate=24000, num_channels=1)
            speech = TTSAudioRawFrame(_pcm(960), sample_rate=48000, num_channels=1)
            await run_test(
                guard,
                frames_to_send=[tone, speech],
                expected_down_frames=[OutputAudioRawFrame, TTSAudioRawFrame],
            )
            assert tone.sample_rate == 16000
            assert speech.sample_rate == 16000
            # Both frames now carry the transport's rate, so downstream
            # `resample(audio, 16000, 16000)` short-circuits and the transport
            # never builds — and therefore never latches — a stream at all.

        asyncio.run(run())
