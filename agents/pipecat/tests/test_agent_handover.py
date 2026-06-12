"""Tests for the builtin ``transfer_agent`` / ``subagent`` platform functions.

Covers the worker-side wiring added for agent sets and text subagents:

- ``function_handler`` source restriction: the ``agent`` target of a
  ``transfer_agent`` / ``subagent`` builtin may never be LLM-generated.
- ``agent_tools.build_agent_tools`` dispatch of the two new builtins to their
  session callbacks, with static ``agent`` parameter resolution.
- The ``suppress_result_run`` marker on ``transfer_agent`` descriptors.
- ``CallSession._on_agent_transfer`` guards (Ultravox refusal, wrong agent
  type, missing target) and the success path scheduling a swap.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

import pytest

from pipecat_aplisay.agent_tools import build_agent_tools
from pipecat_aplisay.function_handler import function_handler

TARGET_UUID = "99999999-8888-7777-6666-555555555555"


def _builtin_fn(platform: str, *, agent_source: str = "static", name: Optional[str] = None) -> dict:
    return {
        "name": name or f"call_{platform}",
        "implementation": "builtin",
        "platform": platform,
        "description": f"test {platform}",
        "input_schema": {
            "type": "object",
            "properties": {
                "agent": {"type": "string", "source": agent_source, "from": TARGET_UUID},
                "question": {"type": "string", "description": "the question", "required": True},
            },
        },
    }


async def _noop_message(_message: dict) -> None:
    return None


class TestSourceRestriction:
    @pytest.mark.parametrize("platform", ["transfer_agent", "subagent"])
    def test_generated_agent_target_is_refused(self, platform: str) -> None:
        fn = _builtin_fn(platform, agent_source="generated")

        async def run() -> dict:
            return await function_handler(
                [{"name": fn["name"], "input": {"agent": "attacker-chosen", "question": "q"}}],
                [fn],
                [],
                _noop_message,
                {},
                {platform: lambda *_a, **_k: {"status": "OK"}},
                {},
            )

        result = asyncio.run(run())
        first = result["function_results"][0]
        assert first["error"] is not None
        assert "static" in first["error"]

    @pytest.mark.parametrize("platform", ["transfer_agent", "subagent"])
    def test_static_agent_target_is_allowed(self, platform: str) -> None:
        fn = _builtin_fn(platform)
        seen: dict = {}

        async def builtin(args: dict, _metadata: dict, _options: dict) -> dict:
            seen.update(args)
            return {"status": "OK"}

        async def run() -> dict:
            return await function_handler(
                [{"name": fn["name"], "input": {"question": "q"}}],
                [fn],
                [],
                _noop_message,
                {},
                {platform: builtin},
                {},
            )

        result = asyncio.run(run())
        assert result["function_results"][0]["error"] is None
        assert seen["agent"] == TARGET_UUID
        assert seen["question"] == "q"


class TestBuildAgentTools:
    def test_subagent_builtin_dispatches_to_callback(self) -> None:
        calls: list = []

        async def on_subagent(args: dict, metadata: dict) -> Any:
            calls.append((args, metadata))
            return {"answer": "42"}

        agent = {"functions": [_builtin_fn("subagent", name="ask_researcher")], "keys": []}
        tools = build_agent_tools(
            agent=agent,
            metadata={"caller": "x"},
            send_message=_noop_message,
            on_hangup=_noop_message,  # type: ignore[arg-type]
            on_transfer=_noop_message,  # type: ignore[arg-type]
            get_transfer_state=lambda: {"state": "none", "description": ""},
            on_subagent=on_subagent,
        )
        [descriptor] = tools
        # The LLM-visible schema only carries the generated parameter.
        assert list(descriptor["schema"]["properties"].keys()) == ["question"]
        assert not descriptor.get("suppress_result_run")

        result = asyncio.run(descriptor["execute"]({"question": "meaning?"}))
        assert result == {"answer": "42"}
        [(args, metadata)] = calls
        assert args["agent"] == TARGET_UUID
        assert args["question"] == "meaning?"
        assert metadata["caller"] == "x"

    def test_transfer_agent_builtin_dispatches_and_suppresses_result_run(self) -> None:
        received: list = []

        async def on_agent_transfer(args: dict) -> dict:
            received.append(args)
            return {"status": "OK", "detail": "handing over"}

        fn = {
            "name": "transfer_to_sales",
            "implementation": "builtin",
            "platform": "transfer_agent",
            "description": "hand over",
            "input_schema": {
                "type": "object",
                "properties": {
                    "agent": {"type": "string", "source": "static", "from": TARGET_UUID},
                    "includeHistory": {"type": "boolean", "source": "static", "from": True},
                    "summary": {"type": "string", "description": "handover summary"},
                },
            },
        }
        tools = build_agent_tools(
            agent={"functions": [fn], "keys": []},
            metadata={},
            send_message=_noop_message,
            on_hangup=_noop_message,  # type: ignore[arg-type]
            on_transfer=_noop_message,  # type: ignore[arg-type]
            get_transfer_state=lambda: {"state": "none", "description": ""},
            on_agent_transfer=on_agent_transfer,
        )
        [descriptor] = tools
        assert descriptor["suppress_result_run"] is True
        # Only the generated summary is LLM-visible.
        assert list(descriptor["schema"]["properties"].keys()) == ["summary"]

        result = asyncio.run(descriptor["execute"]({"summary": "caller wants pricing"}))
        assert result == {"status": "OK", "detail": "handing over"}
        [args] = received
        assert args["agent"] == TARGET_UUID
        assert args["includeHistory"] is True
        assert args["summary"] == "caller wants pricing"

    def test_builtins_unavailable_without_callbacks(self) -> None:
        tools = build_agent_tools(
            agent={"functions": [_builtin_fn("subagent")], "keys": []},
            metadata={},
            send_message=_noop_message,
            on_hangup=_noop_message,  # type: ignore[arg-type]
            on_transfer=_noop_message,  # type: ignore[arg-type]
            get_transfer_state=lambda: {"state": "none", "description": ""},
        )
        [descriptor] = tools
        # The shared function handler converts the missing-builtin failure
        # into an error result; the execute wrapper logs it and returns the
        # (null) result rather than raising.
        assert asyncio.run(descriptor["execute"]({"question": "q"})) is None


class TestOnAgentTransfer:
    """CallSession._on_agent_transfer guard rails, with stubbed collaborators."""

    def _session(self, model_name: str):
        from pipecat_aplisay import api_client
        from pipecat_aplisay.call_session import CallSession

        call = api_client.CallRecord(
            id="call-1",
            userId="user-1",
            organisationId="org-1",
            instanceId="inst-1",
            agentId="agent-1",
            persisted=False,
        )

        class _StubGatewaySession:
            transport = None

            async def shutdown(self) -> None:  # pragma: no cover
                return None

        session = CallSession(
            session_id="s1",
            agent={"id": "agent-1", "modelName": model_name, "prompt": "old"},
            instance={"streamLog": False},
            sip_gateway=None,  # type: ignore[arg-type]
            gateway_session=_StubGatewaySession(),  # type: ignore[arg-type]
            call=call,
        )
        session._active_model_name = model_name
        return session

    def test_refuses_on_ultravox_realtime(self, monkeypatch) -> None:
        session = self._session("pipecat:ultravox/ultravox-v0.7")
        result = asyncio.run(session._on_agent_transfer({"agent": TARGET_UUID}))
        assert result["status"] == "FAILED"
        assert "Ultravox" in result["reason"]

    def test_refuses_missing_target(self) -> None:
        session = self._session("pipecat:openai/gpt-4o")
        result = asyncio.run(session._on_agent_transfer({}))
        assert result["status"] == "FAILED"

    def test_refuses_text_agent_target(self, monkeypatch) -> None:
        from pipecat_aplisay import api_client

        async def fake_fetch(agent_id: str, expected_organisation_id=None) -> dict:
            assert agent_id == TARGET_UUID
            assert expected_organisation_id == "org-1"
            return {"id": agent_id, "type": "text", "prompt": "researcher"}

        monkeypatch.setattr(api_client, "get_internal_agent_by_id", fake_fetch)
        session = self._session("pipecat:openai/gpt-4o")
        result = asyncio.run(session._on_agent_transfer({"agent": TARGET_UUID}))
        assert result["status"] == "FAILED"

    def test_success_schedules_swap_and_builds_prompt(self, monkeypatch) -> None:
        from pipecat_aplisay import api_client
        from pipecat_aplisay import call_session as cs

        async def fake_fetch(agent_id: str, expected_organisation_id=None) -> dict:
            return {
                "id": agent_id,
                "type": "interactive-audio",
                "name": "Sales",
                "prompt": "You are the sales agent.",
                "functions": [],
            }

        monkeypatch.setattr(api_client, "get_internal_agent_by_id", fake_fetch)

        applied: list = []

        async def fake_apply(self, new_agent: dict, system_prompt: str) -> None:
            applied.append((new_agent, system_prompt))

        monkeypatch.setattr(cs.CallSession, "_apply_agent_transfer", fake_apply)

        session = self._session("pipecat:openai/gpt-4o")

        async def run() -> dict:
            result = await session._on_agent_transfer(
                {"agent": TARGET_UUID, "includeHistory": False, "summary": "wants pricing"}
            )
            # Let the detached swap task run to completion.
            if session._agent_swap_task is not None:
                await session._agent_swap_task
            return result

        result = asyncio.run(run())
        assert result["status"] == "OK"
        [(new_agent, prompt)] = applied
        assert new_agent["name"] == "Sales"
        assert prompt.startswith("You are the sales agent.")
        assert "Handover summary from the previous agent" in prompt
        assert "wants pricing" in prompt
        assert "disregard any prior context" in prompt
