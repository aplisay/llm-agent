"""Unit tests for the usage-metering observer (billing capture).

Drives ``UsageMeteringObserver.on_push_frame`` with synthesised frames and
asserts the accumulated (technology, provider, detail, unit, quantity) meters —
no live worker, no network. Covers vendor normalisation (R3), STT chars+ms and
TTS ms (the dual-basis additions), dedup, and the flush payload shape. The real
VAD/SDK frame cadence is validated separately via the eval harness.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from pipecat.frames.frames import (
    MetricsFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.metrics.metrics import LLMTokenUsage, LLMUsageMetricsData, TTSUsageMetricsData
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService
from pipecat.services.stt_service import STTService

from pipecat_aplisay import api_client
from pipecat_aplisay.usage import UsageMeteringObserver, usage_vendors


class _FakeSTT(STTService):
    """A concrete STTService so a frame can be attributed to an STT source."""

    async def run_stt(self, audio: bytes):  # pragma: no cover - never driven
        if False:
            yield None


class _FakeLLM(LLMService):
    """A realtime-style LLM source (it transcribes internally)."""

    def create_context_aggregator(self, *args, **kwargs):  # pragma: no cover
        raise NotImplementedError


def _push(observer: UsageMeteringObserver, *frames, source=None) -> None:
    async def run():
        for fr in frames:
            await observer.on_push_frame(
                FramePushed(
                    source=source, destination=None, frame=fr,
                    direction=FrameDirection.DOWNSTREAM, timestamp=0,
                )
            )
    asyncio.run(run())


def _meter(observer, technology, unit):
    for m in observer._meters.values():
        if m["technology"] == technology and m["unit"] == unit:
            return m
    return None


# --- usage_vendors (R3 canonical resolution) ---------------------------------

def test_usage_vendors_resolves_configured_vendors():
    v = usage_vendors(
        {"options": {"stt": {"vendor": "deepgram"}, "tts": {"vendor": "elevenlabs"}}},
        "pipecat:openai/gpt-4o",
    )
    assert v["llm"] == {"vendor": "openai", "model": "gpt-4o"}
    assert v["stt"]["vendor"] == "deepgram"
    assert v["tts"]["vendor"] == "elevenlabs"


def test_usage_vendors_defaults_match_build():
    # No stt/tts options -> the build's defaults (deepgram / cartesia).
    v = usage_vendors({}, "pipecat:anthropic/claude-sonnet-4-6")
    assert v["llm"]["vendor"] == "anthropic"
    assert v["stt"]["vendor"] == "deepgram"
    assert v["tts"]["vendor"] == "cartesia"


# --- LLM + TTS from MetricsFrame, with canonical provider --------------------

def test_llm_metrics_use_canonical_provider_per_unit():
    obs = UsageMeteringObserver(services={"llm": {"vendor": "openai", "model": "gpt-4o"}})
    usage = LLMTokenUsage(
        prompt_tokens=100, completion_tokens=20, total_tokens=120,
        cache_read_input_tokens=5, cache_creation_input_tokens=0,
    )
    _push(obs, MetricsFrame(data=[LLMUsageMetricsData(processor="llm", model="gpt-4o", value=usage)]))
    assert _meter(obs, "llm", "input_tokens")["quantity"] == 100
    assert _meter(obs, "llm", "output_tokens")["quantity"] == 20
    assert _meter(obs, "llm", "cache_read_tokens")["quantity"] == 5
    # cache_write 0 -> no row
    assert _meter(obs, "llm", "cache_write_tokens") is None
    assert _meter(obs, "llm", "input_tokens")["provider"] == "openai"


def test_tts_provider_is_canonical_not_label():
    # The metric label is a bare model id ('sonic-3.5'); provider must come from
    # the configured vendor (cartesia), not be derived from the label.
    obs = UsageMeteringObserver(services={"tts": {"vendor": "cartesia", "model": None}})
    _push(obs, MetricsFrame(data=[TTSUsageMetricsData(processor="tts", model="sonic-3.5", value=42)]))
    chars = _meter(obs, "tts", "characters")
    assert chars["quantity"] == 42
    assert chars["provider"] == "cartesia"
    assert chars["detail"] == "sonic-3.5"


# --- TTS milliseconds from audio frames --------------------------------------

def test_tts_milliseconds_from_audio_frame_duration():
    obs = UsageMeteringObserver(services={"tts": {"vendor": "cartesia", "model": None}})
    # 2400 frames @ 24kHz = 100 ms; 4800 bytes @ 16-bit mono => num_frames 2400.
    _push(obs, TTSAudioRawFrame(audio=b"\x00" * 4800, sample_rate=24000, num_channels=1))
    ms = _meter(obs, "tts", "milliseconds")
    assert ms["quantity"] == 100
    assert ms["provider"] == "cartesia"


# --- STT characters + milliseconds (new) -------------------------------------

def test_stt_characters_from_every_stt_transcription_frame():
    # A TranscriptionFrame is final by definition (interims are
    # InterimTranscriptionFrame); the Deepgram service never sets `finalized`
    # in normal streaming, so gating on it counted nothing. Both count.
    obs = UsageMeteringObserver(services={"stt": {"vendor": "deepgram", "model": None}})
    _push(
        obs,
        TranscriptionFrame(user_id="u", text="hello", timestamp=""),
        TranscriptionFrame(user_id="u", text="there", timestamp="", finalized=True),
        source=_FakeSTT(),
    )
    chars = _meter(obs, "stt", "characters")
    assert chars["quantity"] == len("hello") + len("there")
    assert chars["provider"] == "deepgram"


def test_stt_characters_only_from_an_stt_service_source():
    # A realtime model's own transcripts (source = the LLM service) are bundled
    # into its charge; an unattributed frame is not STT usage either.
    obs = UsageMeteringObserver(services={"stt": {"vendor": "deepgram", "model": None}})
    _push(obs, TranscriptionFrame(user_id="u", text="from the model", timestamp=""), source=_FakeLLM())
    _push(obs, TranscriptionFrame(user_id="u", text="from nowhere", timestamp=""), source=None)
    assert _meter(obs, "stt", "characters") is None


def test_add_meter_accumulates_external_usage_for_flush():
    # The auxiliary STT runs in a side pipeline the observer never sees, so it
    # hands its meters in through add_meter and they flush with the rest.
    obs = UsageMeteringObserver(services={})
    obs.add_meter("stt-aux", "milliseconds", 1200, provider="google", detail=None)
    obs.add_meter("stt-aux", "milliseconds", 300, provider="google", detail=None)
    obs.add_meter("stt-aux", "characters", 11, provider="google", detail=None)
    obs.add_meter("stt-aux", "characters", 0, provider="google", detail=None)  # no-op
    assert _meter(obs, "stt-aux", "milliseconds")["quantity"] == 1500
    assert _meter(obs, "stt-aux", "milliseconds")["provider"] == "google"
    assert _meter(obs, "stt-aux", "characters")["quantity"] == 11


def test_stt_milliseconds_from_vad_window():
    obs = UsageMeteringObserver(services={"stt": {"vendor": "deepgram", "model": None}})
    _push(
        obs,
        VADUserStartedSpeakingFrame(start_secs=0.0, timestamp=1.0),
        VADUserStoppedSpeakingFrame(stop_secs=0.0, timestamp=2.5),
    )
    ms = _meter(obs, "stt", "milliseconds")
    assert ms["quantity"] == 1500
    assert ms["provider"] == "deepgram"


# --- dedup + flush payload ----------------------------------------------------

def test_same_frame_counted_once():
    obs = UsageMeteringObserver(services={"tts": {"vendor": "cartesia"}})
    frame = MetricsFrame(data=[TTSUsageMetricsData(processor="tts", model="sonic-3.5", value=10)])
    _push(obs, frame, frame)  # observers see each push hop; same id => once
    assert _meter(obs, "tts", "characters")["quantity"] == 10


def test_flush_posts_canonical_rows(monkeypatch):
    captured = {}

    async def fake_save_usage(records):
        captured["records"] = records

    monkeypatch.setattr(api_client, "save_usage", fake_save_usage)

    obs = UsageMeteringObserver(services={"tts": {"vendor": "elevenlabs", "model": None}})
    _push(obs, MetricsFrame(data=[TTSUsageMetricsData(processor="tts", model="eleven_turbo_v2", value=7)]))
    call = SimpleNamespace(id="call-1", organisationId="org-1", userId="user-1", agentId="agent-1")
    asyncio.run(obs.flush(call, finalised=True))

    rows = captured["records"]
    assert len(rows) == 1
    row = rows[0]
    assert row["technology"] == "tts" and row["unit"] == "characters"
    assert row["provider"] == "elevenlabs" and row["detail"] == "eleven_turbo_v2"
    assert row["quantity"] == 7 and row["mode"] == "set" and row["finalised"] is True
    assert row["callId"] == "call-1" and row["organisationId"] == "org-1"
