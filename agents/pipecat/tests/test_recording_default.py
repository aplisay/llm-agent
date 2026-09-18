"""The engine records only when asked. Absence means no recording.

This is a deliberate boundary, not an oversight. "Every call is recorded unless
the customer turns it off" is a statement a CLIENT APPLICATION makes about its
own users and its own consent flow — polite-ai makes exactly that promise and
materialises it at its API boundary before calling us. llm-agent serves other
consumers, so a default-on engine would record on behalf of operators whose
callers never agreed to it. Recording people is not a sensible default for a
general-purpose engine to assume.

The practical consequence for callers: you cannot express "off" by deleting the
option and you cannot express "on" by saying nothing. Say what you mean.
"""

from __future__ import annotations

from pipecat_aplisay.call_session import _resolve_recording_options


def _agent(recording=None) -> dict:
    options = {} if recording is None else {"recording": recording}
    return {"id": "a1", "options": options}


class TestEngineIsOptIn:
    def test_absent_option_does_not_record(self) -> None:
        assert _resolve_recording_options(_agent(), {}).enabled is False

    def test_empty_options_do_not_record(self) -> None:
        assert _resolve_recording_options({"id": "a1"}, {}).enabled is False

    def test_explicit_true_records(self) -> None:
        assert _resolve_recording_options(_agent({"enabled": True}), {}).enabled is True

    def test_explicit_false_does_not_record(self) -> None:
        assert _resolve_recording_options(_agent({"enabled": False}), {}).enabled is False

    def test_option_present_without_enabled_does_not_record(self) -> None:
        # A stored encryption key is not consent to record — `enabled` is the
        # only gate, and it has to be set.
        opts = _resolve_recording_options(_agent({"key": "abc"}), {})
        assert opts.enabled is False
        assert opts.key == "abc"


class TestInstanceOverride:
    def test_instance_false_beats_agent_true(self) -> None:
        agent = _agent({"enabled": True})
        assert _resolve_recording_options(agent, {"recording": {"enabled": False}}).enabled is False

    def test_instance_true_beats_agent_absent(self) -> None:
        # How a client application arms recording per-listener without touching
        # the agent — polite-ai's deploy path relies on this.
        assert _resolve_recording_options(_agent(), {"recording": {"enabled": True}}).enabled is True

    def test_instance_true_beats_agent_false(self) -> None:
        agent = _agent({"enabled": False})
        assert _resolve_recording_options(agent, {"recording": {"enabled": True}}).enabled is True

    def test_instance_without_recording_falls_through_to_agent(self) -> None:
        agent = _agent({"enabled": True})
        assert _resolve_recording_options(agent, {"recording": None}).enabled is True

    def test_instance_recording_without_enabled_falls_through_to_agent(self) -> None:
        agent = _agent({"enabled": True})
        instance = {"recording": {"key": "listener-key"}}
        opts = _resolve_recording_options(agent, instance)
        assert opts.enabled is True  # agent's opt-in still stands
        assert opts.key == "listener-key"  # but the listener's key is used


class TestKeyHandling:
    def test_blank_key_is_treated_as_absent(self) -> None:
        assert _resolve_recording_options(_agent({"enabled": True, "key": "   "}), {}).key is None

    def test_instance_key_overrides_agent_key(self) -> None:
        agent = _agent({"enabled": True, "key": "agent-key"})
        instance = {"recording": {"key": "listener-key"}}
        assert _resolve_recording_options(agent, instance).key == "listener-key"
