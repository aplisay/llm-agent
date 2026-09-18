"""Tests for the fixed fallback message (``options.fallback.message``).

Two things are covered:

- The shared cache layer (``pipecat_aplisay.fallback_message``): resolution
  rules, key derivation, and the WAV codec. The JS side of this contract is
  pinned in ``tests/fallback-message-cross-language.test.mjs``.
- The routing that matters most: an agent concurrency rejection must reach the
  fixed-message path rather than refusing the call, and must do so *without*
  starting a call — a playout that reserved a slot would consume the capacity
  it exists to apologise for.
"""

from __future__ import annotations

import asyncio

import pytest

from pipecat_aplisay.fallback_message import (
    decode_wav,
    encode_wav,
    fallback_message_key,
    resolve_fallback_message,
)


# ---- Resolution ----------------------------------------------------------


def test_text_alone_is_the_minimal_form():
    assert resolve_fallback_message({"text": "we are busy"}, {}).text == "we are busy"


def test_bare_string_is_rejected_not_treated_as_shorthand():
    """One shape to document, validate, and read.

    The write-time validation in ``lib/database.js`` refuses a string outright,
    so this can only be reached by data that bypassed it.
    """
    assert resolve_fallback_message("we are busy", {}) is None


def test_text_is_trimmed_and_blank_resolves_to_none():
    assert resolve_fallback_message({"text": "  hi  "}, {}).text == "hi"
    assert resolve_fallback_message({"text": "   "}, {}) is None
    assert resolve_fallback_message({}, {}) is None
    assert resolve_fallback_message(None, {}) is None


def test_unstated_tts_settings_inherit_from_the_agent():
    resolved = resolve_fallback_message(
        {"text": "hi"},
        {"tts": {"vendor": "elevenlabs", "voice": "Dominus", "language": "en-GB"}},
    )
    assert (resolved.vendor, resolved.voice, resolved.language) == (
        "elevenlabs",
        "Dominus",
        "en-GB",
    )


def test_stated_tts_settings_win_so_a_healthy_vendor_can_be_named():
    resolved = resolve_fallback_message(
        {"text": "hi", "vendor": "deepgram/aura-2", "voice": "thalia"},
        {"tts": {"vendor": "elevenlabs", "voice": "Dominus", "language": "en-GB"}},
    )
    assert resolved.vendor == "deepgram/aura-2"
    assert resolved.voice == "thalia"
    # Unstated fields still inherit.
    assert resolved.language == "en-GB"


# ---- Realtime agents -----------------------------------------------------

_REALTIME_OPTS = {"tts": {"vendor": "ultravox", "voice": "Svetlana", "language": "en-GB"}}


def test_realtime_agent_does_not_inherit_the_model_voice():
    """A realtime model's ``options.tts`` names a timbre of the MODEL, not a TTS.

    Inheriting it would hand ``build_tts_service`` a vendor of ``ultravox``,
    which does not degrade — it raises ``Unsupported TTS vendor`` — so the
    announcement covering the model's failure would itself fail.
    """
    resolved = resolve_fallback_message({"text": "busy"}, _REALTIME_OPTS, inherit_agent_tts=False)
    assert resolved.vendor is None
    assert resolved.voice is None


def test_realtime_agent_still_inherits_language():
    resolved = resolve_fallback_message({"text": "busy"}, _REALTIME_OPTS, inherit_agent_tts=False)
    assert resolved.language == "en-GB"


def test_realtime_agent_keeps_an_explicit_tts_override():
    """The configuration that makes the feature usable for speech-to-speech."""
    resolved = resolve_fallback_message(
        {"text": "busy", "vendor": "elevenlabs", "voice": "Rachel"},
        _REALTIME_OPTS,
        inherit_agent_tts=False,
    )
    assert (resolved.vendor, resolved.voice, resolved.language) == (
        "elevenlabs",
        "Rachel",
        "en-GB",
    )


def test_realtime_and_pipeline_do_not_share_a_cache_entry():
    """Different audio, so they must key differently."""
    realtime = resolve_fallback_message({"text": "busy"}, _REALTIME_OPTS, inherit_agent_tts=False)
    pipeline = resolve_fallback_message({"text": "busy"}, _REALTIME_OPTS, inherit_agent_tts=True)
    assert fallback_message_key(realtime) != fallback_message_key(pipeline)


def test_fixed_message_for_derives_inheritance_from_the_model():
    """End-to-end: an Ultravox agent must not carry its model voice through."""
    from pipecat_aplisay.fixed_message import fixed_message_for

    realtime_agent = {
        "modelName": "pipecat:ultravox/ultravox-v0.7",
        "options": {**_REALTIME_OPTS, "fallback": {"message": {"text": "busy"}}},
    }
    resolved = fixed_message_for(realtime_agent)
    assert resolved.vendor is None and resolved.voice is None
    assert resolved.language == "en-GB"


# ---- Cache key -----------------------------------------------------------


def test_key_is_stable_and_well_formed():
    a = resolve_fallback_message({"text": "hi"}, {})
    b = resolve_fallback_message({"text": "hi"}, {})
    key = fallback_message_key(a)
    assert key == fallback_message_key(b)
    assert len(key) == 32
    assert all(c in "0123456789abcdef" for c in key)


@pytest.mark.parametrize("field", ["text", "vendor", "voice", "language"])
def test_key_changes_when_any_hashed_input_changes(field):
    """This *is* the invalidation: an edit misses the cache and re-synthesises."""
    base = resolve_fallback_message(
        {"text": "hi", "vendor": "v", "voice": "x", "language": "en"}, {}
    )
    changed = resolve_fallback_message(
        {**{"text": "hi", "vendor": "v", "voice": "x", "language": "en"}, field: "different"}, {}
    )
    assert fallback_message_key(base) != fallback_message_key(changed)


def test_separator_in_a_value_cannot_collide_with_a_field_split():
    a = resolve_fallback_message({"text": "t", "voice": "a|b"}, {})
    b = resolve_fallback_message({"text": "t", "voice": "a", "language": "b"}, {})
    assert fallback_message_key(a) != fallback_message_key(b)


def test_key_requires_text():
    with pytest.raises(ValueError):
        fallback_message_key(resolve_fallback_message({"text": "x"}, {}).__class__(text=""))


# ---- WAV codec -----------------------------------------------------------


def _pcm() -> bytes:
    return (12345).to_bytes(2, "little", signed=True) + bytes(636) + (
        -12345
    ).to_bytes(2, "little", signed=True)


def test_wav_round_trips_samples_and_rate():
    decoded = decode_wav(encode_wav(_pcm(), 24000))
    assert decoded.sample_rate == 24000
    assert decoded.pcm == _pcm()


def test_wav_reads_a_chunk_ahead_of_data_as_some_vendors_emit():
    wav = encode_wav(_pcm(), 16000)
    # Odd-length LIST chunk plus its pad byte, spliced before `data`.
    chunk = b"LIST" + (5).to_bytes(4, "little") + bytes(5) + bytes(1)
    spliced = wav[:36] + chunk + wav[36:]
    assert decode_wav(spliced).pcm == _pcm()


def test_wav_truncation_yields_bytes_present_not_a_phantom_length():
    wav = encode_wav(_pcm(), 16000)
    assert len(decode_wav(wav[:-100]).pcm) == len(_pcm()) - 100


def test_wav_rejects_payloads_it_cannot_honestly_decode():
    with pytest.raises(ValueError):
        decode_wav(bytes(64))
    with pytest.raises(ValueError):
        decode_wav(bytes(4))


# ---- Concurrency routing -------------------------------------------------


class _Recorder:
    """Stands in for the fixed-message playout so the test observes routing."""

    def __init__(self) -> None:
        self.played: list = []

    async def __call__(self, transport, agent) -> bool:
        self.played.append(agent)
        return True


def test_concurrency_rejection_plays_the_message_without_starting_a_call(monkeypatch):
    """The premise of the feature: refusing on capacity must still announce.

    The call is deliberately never started, so no concurrency slot is reserved
    while the announcement plays — otherwise "we are busy" would itself consume
    the capacity it is apologising for.
    """
    from pipecat_aplisay import call_session as cs

    recorder = _Recorder()
    monkeypatch.setattr("pipecat_aplisay.fixed_message.run_fixed_message", recorder)

    session = cs.CallSession.__new__(cs.CallSession)
    session.fixed_message_only = True
    session.agent = {
        "id": "a1",
        "modelName": "m",
        "options": {"fallback": {"message": {"text": "busy"}}},
    }
    session.gateway_session = type("GW", (), {"transport": object()})()

    asyncio.run(cs.CallSession.run(session, system_prompt="unused"))

    assert recorder.played == [session.agent], "the announcement should have played"


def test_concurrency_rejection_without_a_message_still_refuses(monkeypatch):
    """No message configured means unchanged behaviour: the caller gets busy."""
    from pipecat_aplisay import api_client, call_session as cs

    async def _busy(_call):
        raise api_client.AgentConcurrencyLimitExceededBusyError(scope="organisation")

    async def _create_call(_body):
        return type("Call", (), {"id": "c1"})()

    class _Gateway:
        async def setup_inbound(self, *_a, **_k):
            return type("GW", (), {"transport": object()})()

    monkeypatch.setattr(api_client, "start_call", _busy)
    monkeypatch.setattr(api_client, "create_call", _create_call)

    ctx = cs.InboundCallContext(session_id="s1", called_id="+441", caller_id="+442")
    agent = {"id": "a1", "userId": "u", "organisationId": "o", "modelName": "m", "options": {}}

    with pytest.raises(api_client.AgentConcurrencyLimitExceededBusyError):
        asyncio.run(
            cs.setup_inbound_call(_Gateway(), ctx, instance={"id": "i1"}, agent=agent)
        )
