"""Use the output transport's rate, not StartFrame's default, so tone audio cannot latch the resampler incorrectly.
See PR #235."""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

from pipecat.pipeline.task import PipelineParams
from pipecat.tests.utils import run_test

from pipecat_aplisay.confidence_tone import ConfidenceToneInjector, ToneConfig


def _injector(output_transport=None) -> ConfidenceToneInjector:
    return ConfidenceToneInjector(
        ToneConfig(grace_ms=1200),
        get_transfer_state=lambda: SimpleNamespace(state="none"),
        output_transport=output_transport,
    )


class TestOutRate:
    def test_prefers_output_transport_over_start_frame(self) -> None:
        """The exact incident shape: transport pinned to 16k, StartFrame 24k."""
        inj = _injector(output_transport=SimpleNamespace(sample_rate=16000))
        # Simulate the StartFrame having taught the (misleading) 24k fallback.
        inj._dst_rate = 24000
        assert inj._out_rate() == 16000

    def test_falls_back_to_learned_rate_before_transport_starts(self) -> None:
        # ``BaseOutputTransport.sample_rate`` is 0 until its StartFrame lands.
        inj = _injector(output_transport=SimpleNamespace(sample_rate=0))
        inj._dst_rate = 48000
        assert inj._out_rate() == 48000

    def test_unknown_rate_is_none_not_a_guess(self) -> None:
        # Nothing authoritative yet: the generator must stay silent rather than
        # emit at a guessed rate and poison the transport's resampler.
        assert _injector()._out_rate() is None

    def test_bind_output_supplies_the_transport_late(self) -> None:
        inj = _injector()
        assert inj._out_rate() is None
        inj.bind_output(SimpleNamespace(sample_rate=16000))
        assert inj._out_rate() == 16000

    def test_non_transport_object_does_not_raise(self) -> None:
        # Defensive: anything without a usable ``sample_rate`` is ignored.
        inj = _injector(output_transport=object())
        inj._dst_rate = 16000
        assert inj._out_rate() == 16000


class TestGeneratorEmitsAtTransportRate:
    def test_tone_chunk_uses_transport_rate(self) -> None:
        """A 20 ms chunk at 16 kHz is 320 samples → 640 bytes of s16le."""
        inj = _injector(output_transport=SimpleNamespace(sample_rate=16000))
        inj.arm_handover()
        inj._last_voice = time.monotonic() - 5.0
        assert inj._should_play() is True

        rate = inj._out_rate()
        assert rate == 16000
        chunk = inj._make_chunk(rate, int(rate * 0.02))
        assert len(chunk) == 640


def test_start_frame_alone_does_not_set_the_emit_rate() -> None:
    """Use stock PipelineParams to exercise the mismatch between StartFrame and the pinned SIP transport. See PR #235."""

    async def run() -> None:
        assert PipelineParams().audio_out_sample_rate == 24000, (
            "this regression is about pipecat's default leaking into StartFrame"
        )
        inj = _injector(output_transport=SimpleNamespace(sample_rate=16000))
        await run_test(
            inj,
            frames_to_send=[],
            expected_down_frames=[],
            pipeline_params=PipelineParams(),
        )
        # StartFrame's 24 kHz is recorded only as the last-resort fallback...
        assert inj._dst_rate == 24000
        # ...the pinned transport rate still wins, which is what keeps the
        # output transport's resampler from latching at the wrong ratio.
        assert inj._out_rate() == 16000

    asyncio.run(run())
