"""Portable ``options.tts.language`` → native Ultravox ``languageHint``
(:mod:`pipecat_aplisay.voice_session`).

Ultravox is speech-to-speech with no separate STT/TTS stage, so there is no
pipeline service to carry the agent's declared language — the provider-native
``languageHint`` on the ``/calls`` body is the only route it has. These tests
cover the tag resolution (precedence, sentinels, region subtag) and the
``extra``-dict mapping that reaches the request body.

Mirrors agents/livekit/test/voice-session-factory.test.ts and
tests/ultravox-native-options.test.mjs, which cover the same option on the
other two stacks.
"""

from __future__ import annotations

from pipecat_aplisay.voice_session import (
    _agent_language_tag,
    _ultravox_language_extra,
)


def _agent(tts=None, stt=None) -> dict:
    options: dict = {}
    if tts is not None:
        options["tts"] = tts
    if stt is not None:
        options["stt"] = stt
    return {"options": options}


# --- tag resolution ----------------------------------------------------------


def test_tts_language_keeps_the_region_subtag():
    # en-GB must not be flattened to en: the region is what picks the accent.
    assert _agent_language_tag(_agent(tts={"voice": "Mark", "language": "en-GB"})) == "en-GB"


def test_falls_back_to_stt_language():
    assert _agent_language_tag(_agent(stt={"language": "fr-FR"})) == "fr-FR"


def test_tts_language_wins_over_stt_language():
    assert _agent_language_tag(_agent(tts={"language": "de-DE"}, stt={"language": "fr-FR"})) == "de-DE"


def test_blank_tts_language_falls_through_to_stt():
    assert _agent_language_tag(_agent(tts={"language": "   "}, stt={"language": "fr-FR"})) == "fr-FR"


def test_unset_language_is_none():
    assert _agent_language_tag({"options": {}}) is None
    assert _agent_language_tag(_agent(tts={"voice": "Mark"})) is None


def test_non_specific_sentinels_are_not_languages():
    for language in ("any", "multi", "auto", "*", "ALL", "global"):
        assert _agent_language_tag(_agent(tts={"language": language})) is None, language


def test_non_string_language_is_ignored():
    # Hand-edited agent definitions should not crash the worker on call setup.
    assert _agent_language_tag(_agent(tts={"language": 42})) is None
    assert _agent_language_tag(_agent(tts={"language": None}, stt={"language": "en-GB"})) == "en-GB"


# --- the /calls body mapping -------------------------------------------------


def test_language_extra_carries_the_hint():
    assert _ultravox_language_extra(_agent(tts={"language": "en-GB"})) == {"languageHint": "en-GB"}


def test_language_extra_is_empty_when_unset():
    # Empty dict, not languageHint=None: the field must be absent from the
    # request body so Ultravox auto-detects rather than being handed a null.
    assert _ultravox_language_extra({"options": {}}) == {}
    assert _ultravox_language_extra(_agent(tts={"language": "any"})) == {}
