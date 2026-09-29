"""Portable ``options.tts.speed`` (:mod:`pipecat_aplisay.tts_speed`): the
multiplier, its per-vendor clamp, and where each builder puts it.

Mirrors agents/livekit/test/tts-speed.test.ts and tests/tts-speed.test.mjs.
"""

from __future__ import annotations

import asyncio

import pytest

from pipecat_aplisay import tts_speed
from pipecat_aplisay.tts_speed import (
    requested_tts_speed,
    tts_speed_for,
    ultravox_speed_extra,
    ultravox_speed_overrides,
)
from pipecat_aplisay.voice_session import (
    _openai_realtime_session_properties,
    _ultravox_one_shot_params,
    _xai_session_properties,
    build_tts_service,
)


def _agent(**tts) -> dict:
    return {"options": {"tts": tts}}


@pytest.fixture(autouse=True)
def keys(monkeypatch):
    for name in (
        "CARTESIA_API_KEY",
        "ELEVENLABS_API_KEY",
        "DEEPGRAM_API_KEY",
        "NEUPHONIC_API_KEY",
        "ULTRAVOX_API_KEY",
    ):
        monkeypatch.setenv(name, "test-key")


# --- the multiplier ------------------------------------------------------------------


@pytest.mark.parametrize("speed", [None, 1, 1.0, 0, -1, "1.2", True, float("nan")])
def test_nothing_to_send(speed):
    assert requested_tts_speed(_agent(speed=speed)) is None


def test_a_multiplier_is_kept():
    assert requested_tts_speed(_agent(speed=1.2)) == 1.2
    assert requested_tts_speed(_agent(speed=0.9)) == 0.9


def test_clamped_to_the_vendor_range():
    assert tts_speed_for(_agent(speed=1.5), "elevenlabs") == 1.2
    assert tts_speed_for(_agent(speed=0.5), "cartesia") == 0.6
    assert tts_speed_for(_agent(speed=1.1), "deepgram") == 1.1


def test_unknown_vendor_sends_nothing():
    assert tts_speed_for(_agent(speed=1.2), "google") is None


# --- pipeline TTS services -------------------------------------------------------------


def test_cartesia_generation_config():
    svc = build_tts_service(_agent(vendor="cartesia", speed=1.2))
    assert svc._settings.generation_config.speed == 1.2


def test_cartesia_without_speed_has_no_generation_config():
    svc = build_tts_service(_agent(vendor="cartesia"))
    assert not svc._settings.generation_config


def test_elevenlabs_speed():
    svc = build_tts_service(_agent(vendor="elevenlabs", voice="Rachel", speed=0.9))
    assert svc._settings.speed == 0.9


def test_deepgram_speed_keeps_the_voice():
    svc = build_tts_service(_agent(vendor="deepgram", voice="aura-2-thalia-en", speed=1.3))
    assert svc._settings.speed == 1.3
    assert svc._settings.voice == "aura-2-thalia-en"


def test_neuphonic_speed():
    svc = build_tts_service(_agent(vendor="neuphonic", speed=1.5))
    assert svc._settings.speed == 1.5


# --- realtime -------------------------------------------------------------------------


def test_openai_realtime_output_speed():
    props = _openai_realtime_session_properties(_agent(voice="alloy", speed=2), text_output=False)
    assert props.audio.output.speed == 1.5


def test_openai_realtime_without_speed():
    props = _openai_realtime_session_properties(_agent(voice="alloy"), text_output=False)
    assert props.audio.output.speed is None


def test_xai_output_speed():
    props = _xai_session_properties(_agent(speed=0.8))
    assert props.audio.output.speed == 0.8
    assert _xai_session_properties(_agent()).audio.output is None


@pytest.mark.parametrize(
    "provider,expected",
    [
        ("eleven_labs", {"elevenLabs": {"speed": 1.2}}),
        ("cartesia", {"cartesia": {"generationConfig": {"speed": 1.3}}}),
        ("lmnt", {"lmnt": {"speed": 1.3}}),
        ("google", {"google": {"speakingRate": 1.3}}),
        ("inworld", {"inworld": {"speakingRate": 1.3}}),
        ("respeecher", None),
        (None, None),
    ],
)
def test_ultravox_overrides_by_provider(provider, expected):
    assert ultravox_speed_overrides(provider, 1.3) == expected


def test_ultravox_extra_looks_up_the_voice(monkeypatch):
    async def provider(voice, api_key):
        assert voice == "Mark"
        return "eleven_labs"

    monkeypatch.setattr(tts_speed, "ultravox_voice_provider", provider)
    extra = asyncio.run(ultravox_speed_extra(_agent(voice="Mark", speed=1.1), "Mark"))
    assert extra == {"voiceOverrides": {"elevenLabs": {"speed": 1.1}}}


def test_ultravox_native_overrides_win(monkeypatch):
    async def provider(*_):
        raise AssertionError("no lookup when native overrides are given")

    monkeypatch.setattr(tts_speed, "ultravox_voice_provider", provider)
    native = {"cartesia": {"generationConfig": {"speed": 0.8}}}
    agent = {"options": {"tts": {"speed": 1.2}, "vendorSpecific": {"ultravox": {"voiceOverrides": native}}}}
    assert asyncio.run(ultravox_speed_extra(agent, "Mark")) == {"voiceOverrides": native}


def test_ultravox_failed_lookup_keeps_the_call(monkeypatch):
    async def provider(*_):
        raise RuntimeError("boom")

    monkeypatch.setattr(tts_speed, "ultravox_voice_provider", provider)
    assert asyncio.run(ultravox_speed_extra(_agent(speed=1.1), "Mark")) == {}


def test_ultravox_no_speed_no_lookup(monkeypatch):
    async def provider(*_):
        raise AssertionError("no lookup without a speed")

    monkeypatch.setattr(tts_speed, "ultravox_voice_provider", provider)
    assert asyncio.run(ultravox_speed_extra(_agent(), "Mark")) == {}


def test_ultravox_params_carry_the_overrides():
    overrides = {"voiceOverrides": {"elevenLabs": {"speed": 1.1}}}
    params = _ultravox_one_shot_params(
        _agent(voice="Mark"), "sys", "ultravox-v0.7", text_output=False, voice_overrides=overrides
    )
    assert params.extra["voiceOverrides"] == {"elevenLabs": {"speed": 1.1}}


def test_grok_fills_the_format_of_a_speed_only_output_block():
    from pipecat_aplisay import grok_service

    agent = _agent(speed=1.2)
    llm = grok_service.build_grok_service(
        api_key="xai-test",
        model="grok-voice-think-fast-2.0",
        system_prompt="You are Sam.",
        session_properties=_xai_session_properties(agent),
        agent=agent,
        on_session_ended=None,
    )
    llm._ensure_audio_config(16000, 24000)
    output = llm._settings.session_properties.audio.output
    assert output.speed == 1.2
    assert output.format.rate == 24000
