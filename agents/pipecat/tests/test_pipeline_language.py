"""``options.stt.language`` / ``options.tts.language`` → the pipeline's STT and
TTS services (:mod:`pipecat_aplisay.voice_session`).

Before this wiring the pipeline path ignored both fields entirely: every agent
got Deepgram's ``en`` and Cartesia's ``en`` regardless of what the agent
definition declared, so a French agent was transcribed and voiced as English.

The assertions deliberately reach for the value each service will actually put
on the wire (``_build_connect_kwargs`` for Deepgram, ``_get_language_codes`` for
Google, the resolved ``_settings.language`` for the TTS pair) rather than the
value we passed in — the vendor mapping in between is the part most likely to
silently drop a tag. Cartesia and ElevenLabs both reduce regional tags to base
codes, which is their APIs' documented shape, not a bug.
"""

from __future__ import annotations

import json

import pytest
from pipecat.transcriptions.language import Language

from pipecat_aplisay.voice_session import (
    _agent_language_tag,
    _canonical_bcp47,
    _language_enum,
    _language_setting,
    build_stt_service,
    build_tts_service,
)


def _agent(stt=None, tts=None) -> dict:
    options: dict = {}
    if stt is not None:
        options["stt"] = stt
    if tts is not None:
        options["tts"] = tts
    return {"options": options}


@pytest.fixture
def api_keys(monkeypatch):
    for name in ("DEEPGRAM_API_KEY", "CARTESIA_API_KEY", "ELEVENLABS_API_KEY"):
        monkeypatch.setenv(name, "test-key")


@pytest.fixture
def google_credentials(monkeypatch):
    """A real (throwaway) RSA key — google-auth parses the PEM at construction,
    so a placeholder string cannot get GoogleSTTService built."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    monkeypatch.setenv(
        "GOOGLE_APPLICATION_CREDENTIALS_JSON",
        json.dumps(
            {
                "type": "service_account",
                "project_id": "test",
                "private_key_id": "kid",
                "private_key": pem,
                "client_email": "test@test.iam.gserviceaccount.com",
                "client_id": "1",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        ),
    )


# --- block precedence --------------------------------------------------------


def test_each_side_prefers_its_own_block():
    agent = _agent(stt={"language": "fr-FR"}, tts={"language": "de-DE"})
    assert _agent_language_tag(agent, prefer="stt") == "fr-FR"
    assert _agent_language_tag(agent, prefer="tts") == "de-DE"


def test_one_declaration_configures_both_sides():
    # Declaring the language once is the common case; it must not leave the
    # other half of the pipeline on the vendor default.
    assert _agent_language_tag(_agent(tts={"language": "de-DE"}), prefer="stt") == "de-DE"
    assert _agent_language_tag(_agent(stt={"language": "fr-FR"}), prefer="tts") == "fr-FR"


# --- tag → Language resolution ----------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("en-GB", "en-GB"),
        ("en-gb", "en-GB"),
        ("EN-GB", "en-GB"),
        ("zh-hans-cn", "zh-Hans-CN"),
        ("fr", "fr"),
    ],
)
def test_canonical_bcp47(raw, expected):
    assert _canonical_bcp47(raw) == expected


def test_language_enum_resolves_sloppy_casing():
    assert _language_enum("en-gb") is Language.EN_GB


def test_language_enum_falls_back_to_the_primary_subtag():
    # An unknown region should still get the language right rather than nothing.
    assert _language_enum("en-ZZ") is Language.EN


def test_language_enum_gives_up_on_nonsense():
    assert _language_enum("klingon") is None


def test_unresolvable_tag_is_passed_through_as_a_string():
    # Better to hand the provider a tag Pipecat's enum lacks than to drop it.
    assert _language_setting(_agent(tts={"language": "klingon"}), "tts") == "klingon"


def test_no_language_declared_resolves_to_none():
    assert _language_setting(_agent(), "stt") is None
    assert _language_setting(_agent(tts={"voice": "Mark"}), "tts") is None


# --- Deepgram STT ------------------------------------------------------------


def test_deepgram_stt_sends_the_regional_tag(api_keys):
    # nova-3 accepts en-GB alongside bare `en`, so the region is not truncated.
    stt = build_stt_service(_agent(stt={"language": "en-GB"}))
    assert stt._build_connect_kwargs()["language"] == "en-GB"


def test_deepgram_stt_takes_the_tts_language_as_fallback(api_keys):
    stt = build_stt_service(_agent(tts={"language": "fr-FR"}))
    assert stt._build_connect_kwargs()["language"] == "fr-FR"


def test_deepgram_stt_keeps_its_default_when_unset(api_keys):
    # The field must be OMITTED, not passed as None — None would clear
    # Deepgram's own Language.EN default rather than leave it alone.
    stt = build_stt_service(_agent())
    assert stt._build_connect_kwargs()["language"] == "en"


def test_deepgram_stt_ignores_the_non_specific_sentinels(api_keys):
    stt = build_stt_service(_agent(stt={"language": "any"}))
    assert stt._build_connect_kwargs()["language"] == "en"


# --- Google STT --------------------------------------------------------------


def test_google_stt_uses_the_declared_recognition_language(api_keys, google_credentials):
    stt = build_stt_service(_agent(stt={"vendor": "google", "language": "en-GB"}))
    assert stt._get_language_codes() == ["en-GB"]


def test_google_stt_maps_through_its_own_code_table(api_keys, google_credentials):
    # Google wants cmn-Hans-CN, not zh-CN — the vendor map has to be applied.
    stt = build_stt_service(_agent(stt={"vendor": "google", "language": "zh-CN"}))
    assert stt._get_language_codes() == ["cmn-Hans-CN"]


def test_google_stt_keeps_its_default_when_unset(api_keys, google_credentials):
    stt = build_stt_service(_agent(stt={"vendor": "google"}))
    assert stt._get_language_codes() == ["en-US"]


def test_google_stt_falls_back_to_default_for_an_unresolvable_tag(
    api_keys, google_credentials
):
    # Google can only be configured with a Language enum, so a raw string that
    # doesn't resolve has to leave the default in place rather than crash.
    stt = build_stt_service(_agent(stt={"vendor": "google", "language": "klingon"}))
    assert stt._get_language_codes() == ["en-US"]


# --- TTS ---------------------------------------------------------------------


def test_cartesia_gets_the_language_as_a_base_code(api_keys):
    tts = build_tts_service(_agent(tts={"vendor": "cartesia", "language": "de-DE"}))
    assert tts._settings.language == "de"


def test_cartesia_takes_the_stt_language_as_fallback(api_keys):
    tts = build_tts_service(_agent(stt={"language": "fr-FR"}))
    assert tts._settings.language == "fr"


def test_cartesia_keeps_its_default_when_unset(api_keys):
    tts = build_tts_service(_agent())
    assert tts._settings.language == "en"


def test_cartesia_voice_still_wins_alongside_a_language(api_keys):
    tts = build_tts_service(
        _agent(tts={"vendor": "cartesia", "voice": "some-voice-id", "language": "de-DE"})
    )
    assert tts._settings.voice == "some-voice-id"
    assert tts._settings.language == "de"


def test_elevenlabs_gets_the_language(api_keys):
    tts = build_tts_service(_agent(tts={"vendor": "elevenlabs", "language": "fr-FR"}))
    assert tts._settings.language == "fr"


def test_elevenlabs_default_model_is_one_that_honours_a_language_code(api_keys):
    # ElevenLabs silently drops language_code on non-multilingual models, so the
    # wiring is only meaningful while the default model stays multilingual.
    from pipecat.services.elevenlabs.tts import ELEVENLABS_MULTILINGUAL_MODELS

    tts = build_tts_service(_agent(tts={"vendor": "elevenlabs", "language": "fr-FR"}))
    assert tts._settings.model in ELEVENLABS_MULTILINGUAL_MODELS


def test_elevenlabs_voice_still_wins_alongside_a_language(api_keys):
    tts = build_tts_service(
        _agent(tts={"vendor": "elevenlabs", "voice": "Bella", "language": "fr-FR"})
    )
    assert tts._settings.voice == "Bella"
    assert tts._settings.language == "fr"


def test_deepgram_tts_language_rides_on_the_voice_id(api_keys):
    # Deepgram TTS has no language parameter on the wire — the Aura voice IS the
    # model and encodes the language. Assert the voice survives; the language
    # field is deliberately left alone.
    tts = build_tts_service(_agent(tts={"vendor": "deepgram", "voice": "aura-2-thalia-en"}))
    assert tts._settings.voice == "aura-2-thalia-en"


def test_unsupported_tts_vendor_still_raises(api_keys):
    with pytest.raises(RuntimeError, match="Unsupported TTS vendor"):
        build_tts_service(_agent(tts={"vendor": "nope"}))
