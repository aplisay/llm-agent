"""Neuphonic TTS on the Pipecat worker (docs/neuphonic.md): the service build_tts_service makes, what it
puts on the websocket URL, and the realtime, usage and fallback paths that reuse it."""

from __future__ import annotations

import asyncio
from urllib.parse import parse_qs, urlsplit

import pytest
from pipecat.transcriptions.language import Language

from pipecat_aplisay.fallback_message import ResolvedFallbackMessage
from pipecat_aplisay.fixed_message import _build_message_tts
from pipecat_aplisay.neuphonic_tts import AplisayNeuphonicTTSService
from pipecat_aplisay.realtime_tts import external_tts_enabled, text_output_enabled
from pipecat_aplisay.usage import usage_vendors
from pipecat_aplisay.voice_session import NEUPHONIC_SAMPLE_RATE, build_tts_service

VOICE = "fc854436-2dac-4d21-aa69-ae17b54e98eb"


def _agent(stt=None, tts=None) -> dict:
    options: dict = {}
    if stt is not None:
        options["stt"] = stt
    if tts is not None:
        options["tts"] = tts
    return {"options": options}


@pytest.fixture
def neuphonic_key(monkeypatch):
    monkeypatch.setenv("NEUPHONIC_API_KEY", "test-key")


def _socket_url(tts) -> tuple[str, dict, dict]:
    """The URL, query and headers the service opens its websocket with, without a network."""
    seen: dict = {}

    async def fake_connect(url, **kwargs):
        seen["url"] = url
        seen["headers"] = kwargs.get("additional_headers") or {}
        raise ConnectionError("not connecting in tests")

    tts._websocket_connect = fake_connect

    async def push_error(**_kwargs):
        return None

    tts.push_error = push_error
    asyncio.run(tts._connect_websocket())
    parts = urlsplit(seen["url"])
    return parts.path, {k: v[0] for k, v in parse_qs(parts.query).items()}, seen["headers"]


def test_builds_the_service_with_voice_language_and_a_16k_rate(neuphonic_key):
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE, "language": "de-DE"}))
    assert isinstance(tts, AplisayNeuphonicTTSService)
    assert tts._settings.voice == VOICE
    assert tts._settings.language == "de"
    assert NEUPHONIC_SAMPLE_RATE == 16000
    assert tts._sampling_rate == 16000


def test_the_socket_asks_for_the_rate_the_frames_are_tagged_with(neuphonic_key):
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE, "language": "en-GB"}))
    path, query, headers = _socket_url(tts)
    assert path == "/speak/en"
    assert query["lang_code"] == "en"
    assert query["sampling_rate"] == "16000"
    assert query["encoding"] == "pcm_linear"
    assert query["voice_id"] == VOICE
    assert headers == {"x-api-key": "test-key"}


def test_hindi_goes_out_lowercase(neuphonic_key):
    # Pipecat 1.10 maps Language.HI to "HI"; Neuphonic accepts it but does not speak Hindi.
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE, "language": "hi-IN"}))
    assert tts._settings.language == "hi"
    path, query, _ = _socket_url(tts)
    assert (path, query["lang_code"]) == ("/speak/hi", "hi")
    assert tts.language_to_service_language(Language.HI) == "hi"


@pytest.mark.parametrize(
    ("tag", "code"),
    [("pt-BR", "pt"), ("zh-CN", "zh"), ("es-VE", "es"), ("ar-EG", "ar"), ("en-IE", "en"), ("mt-MT", "mt")],
)
def test_regional_tags_become_base_codes(neuphonic_key, tag, code):
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE, "language": tag}))
    assert tts._settings.language == code


def test_language_falls_back_to_the_stt_language_then_english(neuphonic_key):
    assert build_tts_service(_agent(stt={"language": "fr-FR"}, tts={"vendor": "neuphonic"}))._settings.language == "fr"
    assert build_tts_service(_agent(tts={"vendor": "neuphonic"}))._settings.language == "en"


def test_no_voice_leaves_the_choice_to_neuphonic(neuphonic_key):
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "language": "es-ES"}))
    assert tts._settings.voice is None
    _, query, _ = _socket_url(tts)
    assert "voice_id" not in query


def test_vendor_scoping_and_case_are_ignored(neuphonic_key):
    tts = build_tts_service(_agent(tts={"vendor": "Neuphonic/any-model", "voice": VOICE}))
    assert isinstance(tts, AplisayNeuphonicTTSService)


def test_a_missing_key_names_the_variable(monkeypatch):
    monkeypatch.delenv("NEUPHONIC_API_KEY", raising=False)
    with pytest.raises(KeyError, match="NEUPHONIC_API_KEY"):
        build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE}))


def test_transcript_tts_uses_the_same_service(neuphonic_key):
    tts = build_tts_service(_agent(tts={"vendor": "neuphonic", "voice": VOICE}), transcript_tts=True)
    assert type(tts) is AplisayNeuphonicTTSService


def test_an_external_tts_on_the_text_output_rows():
    agent = _agent(tts={"vendor": "neuphonic", "voice": VOICE})
    for model_id in ("ultravox/ultravox-v0.7", "openai/gpt-realtime"):
        assert text_output_enabled(agent, model_id)
        assert external_tts_enabled(agent, model_id)
    assert not external_tts_enabled(agent, "google/gemini-2.0-flash-exp")
    assert not external_tts_enabled(agent, "xai/grok-voice-think-fast-2.0")


def test_usage_is_billed_to_neuphonic():
    agent = _agent(tts={"vendor": "neuphonic", "voice": VOICE})
    assert usage_vendors(agent, "pipecat:openai/gpt-4o-mini")["tts"]["vendor"] == "neuphonic"
    assert usage_vendors(agent, "pipecat:ultravox/ultravox-v0.7")["tts"]["vendor"] == "neuphonic"


def test_the_fallback_message_can_be_spoken_by_neuphonic(neuphonic_key):
    resolved = ResolvedFallbackMessage(text="Sorry, we cannot take your call.", vendor="neuphonic", voice=VOICE, language="en-GB")
    tts = _build_message_tts(_agent(), resolved)
    assert isinstance(tts, AplisayNeuphonicTTSService)
    assert (tts._settings.voice, tts._settings.language) == (VOICE, "en")
