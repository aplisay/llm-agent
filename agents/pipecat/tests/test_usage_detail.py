"""``detail`` on ``stt``, ``stt-aux``, ``stt-output`` and ``tts`` usage rows names
the model that ran, so a rate card can price the row by an exact line.

The services are the real ones ``voice_session`` builds, with no network. A
value pinned here is a Pipecat default: when a Pipecat upgrade changes one, the
rows change with it and rate cards need a line for the new value.
"""

from __future__ import annotations

import asyncio

import pytest
from pipecat.frames.frames import InputAudioRawFrame, MetricsFrame, TranscriptionFrame, TTSAudioRawFrame
from pipecat.metrics.metrics import TTSUsageMetricsData
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection

from pipecat_aplisay.usage import UsageMeteringObserver, stt_detail, tts_detail, usage_vendors
from pipecat_aplisay.voice_session import (
    _aux_stt_tap_for,
    _output_stt_tap_for,
    build_stt_service,
    build_tts_service,
)

NEUPHONIC_VOICE = "8e9c4bc8-3979-48ab-8626-df53befc2090"
CARTESIA_VOICE = "71a7ad14-091c-4e8e-a314-022ece01c121"


@pytest.fixture
def api_keys(monkeypatch):
    for name in ("DEEPGRAM_API_KEY", "CARTESIA_API_KEY", "ELEVENLABS_API_KEY", "NEUPHONIC_API_KEY"):
        monkeypatch.setenv(name, "test-key")


def _agent(stt=None, tts=None) -> dict:
    options: dict = {}
    if stt is not None:
        options["stt"] = stt
    if tts is not None:
        options["tts"] = tts
    return {"options": options}


def _push(observer: UsageMeteringObserver, *frames, source=None, destination=None) -> None:
    async def run():
        for fr in frames:
            await observer.on_push_frame(
                FramePushed(
                    source=source, destination=destination, frame=fr,
                    direction=FrameDirection.DOWNSTREAM, timestamp=0,
                )
            )
    asyncio.run(run())


def _rows(observer: UsageMeteringObserver, technology: str) -> dict:
    return {
        m["unit"]: (m["provider"], m["detail"])
        for m in observer._meters.values()
        if m["technology"] == technology
    }


async def _on_transcript(_text):
    pass


# --- STT: the model the service was built with, spelt vendor/model -------------


@pytest.mark.parametrize(
    ("stt", "detail"),
    [
        (None, "deepgram/nova-3-general"),
        ({"vendor": "deepgram", "language": "en-GB"}, "deepgram/nova-3-general"),
        ({"vendor": "deepgram/nova-2"}, "deepgram/nova-2"),
        ({"vendor": "deepgram/nova-3:en"}, "deepgram/nova-3"),
    ],
)
def test_deepgram_stt_rows_name_the_model_built(api_keys, stt, detail):
    assert stt_detail("deepgram", build_stt_service(_agent(stt=stt))) == detail


@pytest.mark.parametrize(
    ("vendor", "detail"),
    [("google", "google/latest_long"), ("google/chirp_2", "google/chirp_2")],
)
def test_google_stt_rows_name_the_model_built(api_keys, google_credentials, default_event_loop, vendor, detail):
    assert stt_detail("google", build_stt_service(_agent(stt={"vendor": vendor}))) == detail


def test_a_scoped_stt_model_is_the_model_deepgram_is_asked_for(api_keys):
    # The engine used to drop the model and run the Pipecat default.
    kwargs = build_stt_service(_agent(stt={"vendor": "deepgram/nova-2:en"}))._build_connect_kwargs()
    assert kwargs["model"] == "nova-2"
    assert build_stt_service(_agent())._build_connect_kwargs()["model"] == "nova-3-general"


def test_a_scoped_stt_model_is_the_model_google_is_asked_for(api_keys, google_credentials, default_event_loop):
    assert build_stt_service(_agent(stt={"vendor": "google/chirp_2"})).settings.model == "chirp_2"


def test_deepgram_multilingual_is_marked_apart_from_one_language():
    from pipecat.services.deepgram.stt import DeepgramSTTService, DeepgramSTTSettings

    multi = DeepgramSTTService(api_key="test-key", settings=DeepgramSTTSettings(language="multi"))
    assert stt_detail("deepgram", multi) == "deepgram/nova-3-general-multilingual"
    assert stt_detail("deepgram", DeepgramSTTService(api_key="test-key")) == "deepgram/nova-3-general"


def test_primary_stt_rows_carry_one_detail_for_both_units(api_keys):
    stt = build_stt_service(_agent())
    obs = UsageMeteringObserver(services=usage_vendors({}, "pipecat:openai/gpt-4o-mini"))
    audio = InputAudioRawFrame(audio=b"\x00" * 320, sample_rate=8000, num_channels=1)
    _push(obs, audio, destination=stt)
    _push(obs, TranscriptionFrame(user_id="u", text="hello", timestamp=""), source=stt)
    assert _rows(obs, "stt") == {
        "milliseconds": ("deepgram", "deepgram/nova-3-general"),
        "characters": ("deepgram", "deepgram/nova-3-general"),
    }


def test_an_stt_model_option_that_nothing_runs_is_not_written(api_keys):
    # ``options.stt.model`` is not in the API and no service is built from it.
    agent = _agent(stt={"model": "not-what-runs"})
    stt = build_stt_service(agent)
    obs = UsageMeteringObserver(services=usage_vendors(agent, "pipecat:openai/gpt-4o-mini"))
    _push(obs, TranscriptionFrame(user_id="u", text="hello", timestamp=""), source=stt)
    assert _rows(obs, "stt") == {"characters": ("deepgram", "deepgram/nova-3-general")}


# --- side engines ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("aux", "detail"),
    [({}, "deepgram/nova-3-general"), ({"vendor": "deepgram/nova-2"}, "deepgram/nova-2")],
)
def test_aux_stt_usage_names_the_model_the_engine_was_built_with(api_keys, aux, detail):
    seen = []
    tap = _aux_stt_tap_for(
        _agent(stt={"aux": aux}), _on_transcript, lambda unit, qty, vendor: seen.append((unit, qty, dict(vendor)))
    )
    # The tap builds its engine on the first audio frame, before any usage report.
    service = tap._stt_factory()
    tap._on_usage("milliseconds", 20)
    tap._on_usage("characters", 5)
    assert seen == [
        ("milliseconds", 20, {"vendor": "deepgram", "model": detail}),
        ("characters", 5, {"vendor": "deepgram", "model": detail}),
    ]
    assert f"deepgram/{service.settings.model}" == detail


def test_output_stt_usage_names_the_google_default_model(api_keys, google_credentials, default_event_loop):
    seen = []
    tap = _output_stt_tap_for(
        _agent(tts={"output": {"vendor": "google"}}),
        _on_transcript,
        lambda unit, qty, vendor: seen.append(dict(vendor)),
    )
    tap._stt_factory()
    tap._on_usage("milliseconds", 20)
    assert seen == [{"vendor": "google", "model": "google/latest_long"}]


# --- TTS: one value on both rows, never empty ---------------------------------------


@pytest.mark.parametrize(
    ("tts", "provider", "detail"),
    [
        (None, "cartesia", "sonic-3.6"),
        ({"vendor": "cartesia", "voice": CARTESIA_VOICE}, "cartesia", "sonic-3.6"),
        ({"vendor": "elevenlabs"}, "elevenlabs", "eleven_flash_v2_5"),
        ({"vendor": "elevenlabs", "voice": "Rachel"}, "elevenlabs", "eleven_flash_v2_5"),
        # On Deepgram the voice is the model.
        ({"vendor": "deepgram"}, "deepgram", "aura-asteria-en"),
        ({"vendor": "deepgram", "voice": "aura-2-thalia-en"}, "deepgram", "aura-2-thalia-en"),
        # Neuphonic names no model. With no voice it picks one itself.
        ({"vendor": "neuphonic", "voice": NEUPHONIC_VOICE}, "neuphonic", NEUPHONIC_VOICE),
        ({"vendor": "neuphonic"}, "neuphonic", "neuphonic"),
    ],
)
def test_both_tts_rows_carry_what_the_service_was_built_with(api_keys, tts, provider, detail):
    agent = _agent(tts=tts)
    service = build_tts_service(agent)
    assert tts_detail(provider, service) == detail

    obs = UsageMeteringObserver(services=usage_vendors(agent, "pipecat:openai/gpt-4o-mini"))
    # The characters metric carries the service's own model label, empty when it has none.
    metric = TTSUsageMetricsData(processor="tts", model=service.settings.model or "", value=42)
    _push(obs, MetricsFrame(data=[metric]), source=service)
    _push(obs, TTSAudioRawFrame(audio=b"\x00" * 4800, sample_rate=24000, num_channels=1), source=service)
    assert _rows(obs, "tts") == {"characters": (provider, detail), "milliseconds": (provider, detail)}


def test_a_tts_model_option_that_nothing_runs_is_not_written(api_keys):
    agent = _agent(tts={"vendor": "cartesia", "model": "not-what-runs", "voice": CARTESIA_VOICE})
    service = build_tts_service(agent)
    obs = UsageMeteringObserver(services=usage_vendors(agent, "pipecat:openai/gpt-4o-mini"))
    _push(obs, TTSAudioRawFrame(audio=b"\x00" * 4800, sample_rate=24000, num_channels=1), source=service)
    assert _rows(obs, "tts") == {"milliseconds": ("cartesia", "sonic-3.6")}


def test_external_tts_on_a_realtime_model_names_the_tts_model(api_keys):
    agent = _agent(tts={"vendor": "elevenlabs", "voice": "Rachel"})
    service = build_tts_service(agent)
    obs = UsageMeteringObserver(services=usage_vendors(agent, "pipecat:ultravox/ultravox-v0.7"))
    _push(obs, TTSAudioRawFrame(audio=b"\x00" * 4800, sample_rate=24000, num_channels=1), source=service)
    assert _rows(obs, "tts") == {"milliseconds": ("elevenlabs", "eleven_flash_v2_5")}


@pytest.mark.parametrize(
    ("model_name", "vendor"),
    [
        ("pipecat:ultravox/ultravox-v0.7", "ultravox"),
        ("pipecat:openai/gpt-realtime", "openai"),
        ("pipecat:xai/grok-voice-think-fast-2.0", "xai"),
    ],
)
def test_a_realtime_models_own_speech_keeps_the_configured_voice(model_name, vendor):
    # Its audio comes from the LLM service, not a TTS service: these rows are unchanged.
    obs = UsageMeteringObserver(services=usage_vendors(_agent(tts={"voice": "Mark"}), model_name))
    _push(obs, TTSAudioRawFrame(audio=b"\x00" * 4800, sample_rate=24000, num_channels=1), source=object())
    _push(obs, MetricsFrame(data=[TTSUsageMetricsData(processor="llm", model="", value=7)]), source=object())
    assert _rows(obs, "tts") == {"milliseconds": (vendor, "Mark"), "characters": (vendor, "Mark")}


def test_a_running_pipeline_meters_both_tts_rows_under_the_services_model():
    # The meter reads the model from the frame's source, so this checks that a
    # real pipeline reports the TTS service as the source of its audio and metrics.
    from pipecat.frames.frames import TTSSpeakFrame
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.task import PipelineParams
    from pipecat.services.settings import TTSSettings
    from pipecat.services.tts_service import TTSService
    from pipecat.tests.utils import run_test

    class _ModelTTS(TTSService):
        def __init__(self):
            super().__init__(
                sample_rate=24000,
                settings=TTSSettings(model="model-that-ran", voice="some-voice", language=None),
            )

        def can_generate_metrics(self) -> bool:
            return True

        async def run_tts(self, text: str, context_id: str):
            await self.start_tts_usage_metrics(text)
            yield TTSAudioRawFrame(audio=b"\x00" * 4800, sample_rate=24000, num_channels=1, context_id=context_id)

    agent = _agent(tts={"vendor": "cartesia", "voice": "some-voice"})
    obs = UsageMeteringObserver(services=usage_vendors(agent, "pipecat:openai/gpt-4o-mini"))
    asyncio.run(
        run_test(
            Pipeline([_ModelTTS()]),
            frames_to_send=[TTSSpeakFrame("hello there")],
            observers=[obs],
            pipeline_params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        )
    )
    assert {m["unit"]: (m["detail"], m["quantity"]) for m in obs._meters.values() if m["technology"] == "tts"} == {
        "characters": ("model-that-ran", len("hello there")),
        "milliseconds": ("model-that-ran", 100),
    }
