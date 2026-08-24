"""Tests for the worker's Ultravox ``vadSettings`` mapping.

Ultravox's stock ``minimumInterruptionDuration`` is 0.09s, which lets any
~90ms sound — a breath, a backchannel "mm-hm", handset rustle — cancel agent
speech mid-turn; the cancelled turn is finalised truncated and nothing
re-offers the lost answer (2026-08-24: a gas-safety answer finalised as
"If you ever smell"). What is pinned here: every Ultravox call body carries a
platform default of 0.48s unless the agent supplies an explicit
``vendorSpecific.ultravox.vadSettings``, an explicit override replaces the
default WHOLESALE (documented contract — never merged), and malformed
vendorSpecific shapes fall back to the default rather than raising.
"""

from __future__ import annotations

from pipecat_aplisay.voice_session import (
    ULTRAVOX_DEFAULT_VAD_SETTINGS,
    _ultravox_vad_extra,
)


def test_default_applied_when_agent_has_no_vendor_settings():
    assert _ultravox_vad_extra({}) == {
        "vadSettings": {"minimumInterruptionDuration": "0.48s"}
    }
    assert _ultravox_vad_extra({"options": {}}) == {
        "vadSettings": {"minimumInterruptionDuration": "0.48s"}
    }


def test_default_is_a_fresh_dict_per_call():
    a = _ultravox_vad_extra({})["vadSettings"]
    a["minimumInterruptionDuration"] = "9s"
    assert _ultravox_vad_extra({})["vadSettings"]["minimumInterruptionDuration"] == "0.48s"
    assert ULTRAVOX_DEFAULT_VAD_SETTINGS["minimumInterruptionDuration"] == "0.48s"


def test_explicit_vendor_settings_replace_the_default_wholesale():
    agent = {
        "options": {
            "vendorSpecific": {"ultravox": {"vadSettings": {"turnEndpointDelay": "0.5s"}}}
        }
    }
    out = _ultravox_vad_extra(agent)["vadSettings"]
    assert out == {"turnEndpointDelay": "0.5s"}
    assert "minimumInterruptionDuration" not in out


def test_malformed_vendor_shapes_fall_back_to_the_default():
    for bad in (
        {"options": {"vendorSpecific": None}},
        {"options": {"vendorSpecific": "nope"}},
        {"options": {"vendorSpecific": {"ultravox": None}}},
        {"options": {"vendorSpecific": {"ultravox": {"vadSettings": "0.2s"}}}},
        {"options": {"vendorSpecific": {"ultravox": {"vadSettings": {}}}}},
    ):
        assert _ultravox_vad_extra(bad)["vadSettings"] == ULTRAVOX_DEFAULT_VAD_SETTINGS
