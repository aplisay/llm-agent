"""Opt-in hangup after repeated unanswered inactivity prompts
(``options.inactivity.hangup``, :mod:`pipecat_aplisay.voice_session`).

Without the flag a leg nobody hangs up is only reclaimed by the session long-stop
(the model's ``maxDuration`` plus a few seconds), so whoever is still on the line
sits through minutes of silence first — most visibly an abandoned
consultative-transfer target, which has no other party left to hang up on it.

Two enforcement paths, mirroring the LiveKit worker: Ultravox-backed sessions get a
provider-side ``endBehavior`` on the last ``inactivityMessages`` entry; everything
else is counted by the generic kick and torn down by ``CallSession``. These tests
cover the option gate and the Ultravox mapping.
"""

from __future__ import annotations

from pipecat_aplisay.constants import DISCONNECT_REASONS
from pipecat_aplisay.voice_session import (
    INACTIVITY_PROMPT_COUNT,
    _inactivity_hangup_enabled,
    _ultravox_inactivity_extra,
)


def _agent(**inactivity) -> dict:
    return {"options": {"inactivity": inactivity}} if inactivity else {"options": {}}


def _configured(**extra) -> dict:
    return _agent(timeout="6s", message="Are you still there?", **extra)


# --- the option gate ---------------------------------------------------------


def test_hangup_defaults_off():
    assert _inactivity_hangup_enabled(_configured()) is False
    assert _inactivity_hangup_enabled(_configured(hangup=False)) is False


def test_hangup_on_when_explicitly_set():
    assert _inactivity_hangup_enabled(_configured(hangup=True)) is True


def test_hangup_requires_a_usable_inactivity_config():
    # No prompt to count means nothing to hang up after.
    assert _inactivity_hangup_enabled({"options": {}}) is False
    assert _inactivity_hangup_enabled(_agent(hangup=True)) is False
    assert _inactivity_hangup_enabled(_agent(hangup=True, timeout="6s")) is False, "message missing"
    assert (
        _inactivity_hangup_enabled(_agent(hangup=True, message="hi", timeout="0s")) is False
    ), "non-positive timeout"


def test_truthy_but_not_true_does_not_opt_in():
    # A hand-edited agent definition must not arm this by accident.
    assert _inactivity_hangup_enabled(_configured(hangup="yes")) is False
    assert _inactivity_hangup_enabled(_configured(hangup=1)) is False


def test_no_inactivity_block_at_all():
    assert _inactivity_hangup_enabled({}) is False
    assert _inactivity_hangup_enabled({"options": None}) is False


# --- Ultravox native mapping -------------------------------------------------


def test_without_hangup_no_end_behavior_anywhere():
    messages = _ultravox_inactivity_extra(_configured())["inactivityMessages"]
    assert len(messages) == INACTIVITY_PROMPT_COUNT
    for m in messages:
        assert m == {"duration": "6s", "message": "Are you still there?"}
        assert "endBehavior" not in m


def test_with_hangup_end_behavior_on_last_prompt_only():
    messages = _ultravox_inactivity_extra(_configured(hangup=True))["inactivityMessages"]
    assert len(messages) == INACTIVITY_PROMPT_COUNT
    for m in messages[:-1]:
        assert "endBehavior" not in m, "earlier prompts must not end the call"
    assert messages[-1] == {
        "duration": "6s",
        "message": "Are you still there?",
        # SOFT not STRICT, so the final prompt is still delivered rather than cut.
        "endBehavior": "END_BEHAVIOR_HANG_UP_SOFT",
    }


def test_entries_are_independent_objects():
    messages = _ultravox_inactivity_extra(_configured(hangup=True))["inactivityMessages"]
    messages[0]["message"] = "mutated"
    assert messages[1]["message"] == "Are you still there?"


def test_unset_inactivity_yields_no_extra():
    assert _ultravox_inactivity_extra({"options": {}}) == {}
    assert _ultravox_inactivity_extra(_agent(hangup=True)) == {}


# --- disconnect taxonomy -----------------------------------------------------


def test_distinct_disconnect_reason():
    # Must be distinguishable from a maxDuration long-stop in call records, and
    # identical to the LiveKit worker's string so reporting can span both stacks.
    assert DISCONNECT_REASONS["INACTIVITY_TIMEOUT"] == "Inactivity timeout"
    assert DISCONNECT_REASONS["INACTIVITY_TIMEOUT"] != DISCONNECT_REASONS["SESSION_TIMEOUT"]
