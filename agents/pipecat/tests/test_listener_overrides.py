"""Tests for listener-level transfer overrides (``apply_instance_transfer_overrides``).

The listener (instance) row may carry ``bridgedTransferToAgent``,
``bridgedTransferTranscribe`` and ``dtmfTimeout``; each one, when set,
wholesale-replaces the same-named ``agent.options`` value for every session
running under that listener (docs/transfer-back-plan.md).
"""

from __future__ import annotations

from pipecat_aplisay.call_session import apply_instance_transfer_overrides


AGENT_A = "11111111-2222-3333-4444-555555555555"
AGENT_B = "66666666-7777-8888-9999-000000000000"


def make_agent(**options):
    return {
        "id": AGENT_A,
        "modelName": "pipecat:openai/gpt-4o",
        "prompt": "hello",
        "options": options,
    }


class TestApplyInstanceTransferOverrides:
    def test_no_overrides_returns_same_object(self):
        agent = make_agent(bridgedTransferToAgent={"1": AGENT_B})
        assert apply_instance_transfer_overrides(agent, {}) is agent
        assert apply_instance_transfer_overrides(agent, {"streamLog": True}) is agent

    def test_non_dict_inputs_pass_through(self):
        agent = make_agent()
        assert apply_instance_transfer_overrides(agent, None) is agent
        assert apply_instance_transfer_overrides(None, {"dtmfTimeout": 900}) is None

    def test_wholesale_replace_of_map(self):
        agent = make_agent(bridgedTransferToAgent={"1": AGENT_B, "2": AGENT_B})
        instance = {"bridgedTransferToAgent": {"*7": {"agent": AGENT_B}}}
        merged = apply_instance_transfer_overrides(agent, instance)
        # Replaced wholesale, not per-key merged
        assert merged["options"]["bridgedTransferToAgent"] == {"*7": {"agent": AGENT_B}}
        # Original untouched
        assert agent["options"]["bridgedTransferToAgent"] == {"1": AGENT_B, "2": AGENT_B}

    def test_overrides_land_when_agent_has_no_options(self):
        agent = {"id": AGENT_A, "modelName": "pipecat:openai/gpt-4o", "prompt": "x"}
        instance = {
            "bridgedTransferTranscribe": True,
            "dtmfTimeout": 900,
        }
        merged = apply_instance_transfer_overrides(agent, instance)
        assert merged["options"]["bridgedTransferTranscribe"] is True
        assert merged["options"]["dtmfTimeout"] == 900
        assert "options" not in agent

    def test_unset_instance_keys_leave_agent_values(self):
        agent = make_agent(
            bridgedTransferToAgent={"1": AGENT_B},
            bridgedTransferTranscribe=True,
            dtmfTimeout=2000,
        )
        instance = {"dtmfTimeout": 700}
        merged = apply_instance_transfer_overrides(agent, instance)
        assert merged["options"]["bridgedTransferToAgent"] == {"1": AGENT_B}
        assert merged["options"]["bridgedTransferTranscribe"] is True
        assert merged["options"]["dtmfTimeout"] == 700

    def test_idempotent(self):
        agent = make_agent(bridgedTransferToAgent={"1": AGENT_B})
        instance = {"bridgedTransferToAgent": {"9": AGENT_B}, "dtmfTimeout": 900}
        once = apply_instance_transfer_overrides(agent, instance)
        twice = apply_instance_transfer_overrides(once, instance)
        # Second application detects nothing to change and returns the same object
        assert twice is once

    def test_other_options_preserved(self):
        agent = make_agent(transferTone=True, tts={"voice": "abc"})
        instance = {"bridgedTransferTranscribe": {"provider": "deepgram"}}
        merged = apply_instance_transfer_overrides(agent, instance)
        assert merged["options"]["transferTone"] is True
        assert merged["options"]["tts"] == {"voice": "abc"}
        assert merged["options"]["bridgedTransferTranscribe"] == {"provider": "deepgram"}
