"""Descriptor `kind` classification in :func:`pipecat_aplisay.agent_tools.build_agent_tools`.

The InvocationLog tool logs read `kind` off the descriptor built here (via
``voice_session._runner`` / ``tool_log.py``). This locks the classification that
feeds it — in particular that the ``subagent`` builtin is split out from the
generic ``builtin`` so agent-to-agent delegation reads as its own category
(the polite.ai calls drawer renders it as an AGENT row). Parallel to the livekit
worker's ``agents/livekit/lib/agent-tools.ts`` ternary.
"""

from __future__ import annotations

from pipecat_aplisay.agent_tools import build_agent_tools


async def _noop(*_args, **_kwargs):  # generic async stub for the wiring callables
    return None


def _kinds_for(functions: list[dict]) -> dict[str, str]:
    descriptors = build_agent_tools(
        agent={"functions": functions, "keys": []},
        metadata={},
        send_message=_noop,
        on_hangup=_noop,
        on_transfer=_noop,
        get_transfer_state=lambda: {},
        on_agent_transfer=_noop,
        on_subagent=_noop,
    )
    return {d["schema"]["name"]: d["kind"] for d in descriptors}


def test_subagent_platform_classified_as_subagent_kind():
    kinds = _kinds_for(
        [
            {
                "name": "insurance-checker",
                "description": "delegate to a text agent",
                "implementation": "builtin",
                "platform": "subagent",
                "input_schema": {"properties": {}},
            },
            {
                "name": "transfer_agent",
                "description": "hand the call to another agent",
                "implementation": "builtin",
                "platform": "transfer_agent",
                "input_schema": {"properties": {}},
            },
            {
                "name": "check_availability",
                "description": "a plain user function",
                "implementation": "rest",
                "input_schema": {"properties": {}},
            },
        ]
    )
    # The subagent builtin is its own kind...
    assert kinds["insurance-checker"] == "subagent"
    # ...while other builtins (e.g. transfer_agent, represented as call legs, not
    # a data row) stay `builtin`, and a non-builtin stays `function`. This also
    # guards the ternary precedence: the platform check must come BEFORE the
    # implementation check, or a subagent would fall through to `builtin`.
    assert kinds["transfer_agent"] == "builtin"
    assert kinds["check_availability"] == "function"
