"""Registration mode of tools on the Ultravox realtime path
(:func:`pipecat_aplisay.voice_session._register_tools_on_llm`).

Regression guard for the 2026-07-24 staging incident: a booking agent's
``calendar_*`` REST calls stalled 18-36s or were skipped because they were
registered SYNCHRONOUSLY against Ultravox, whose freeze-until-tool-result model
plus the assistant aggregator's ``not user_speaking`` push guard left each
result unshipped until the *next* tool call. The fix registers data-returning
tools (REST / MCP / stub) asynchronously (``cancel_on_interruption=False``) on
the Ultravox realtime path so Pipecat won't cancel them on interruption and
ships an immediate placeholder that unfreezes the conversation — while
side-effecting builtins (``protect_from_interruption``) and every tool off the
Ultravox path stay synchronous.

These are pure registration assertions: ``_register_tools_on_llm`` only builds
schemas and calls ``llm.register_function`` — the ``_runner`` closures are never
executed — so no network, socket or loguru scope is needed.
"""

from __future__ import annotations

import asyncio

import pytest

from pipecat_aplisay.voice_session import _is_ultravox_realtime, _register_tools_on_llm

# Skip cleanly if the Ultravox extra isn't installed in this environment.
ultravox_llm = pytest.importorskip("pipecat.services.ultravox.llm")
UltravoxRealtimeLLMService = ultravox_llm.UltravoxRealtimeLLMService


async def _noop_execute(_args):
    return {"ok": True}


def _tools() -> list[dict]:
    """A data REST tool, an MCP tool, and a shielded side-effecting builtin."""
    return [
        {
            "schema": {"name": "calendar_get_slots", "description": "d", "properties": {}, "required": []},
            "execute": _noop_execute,
            "kind": "function",
        },
        {
            "schema": {"name": "knowledge_search", "description": "d", "properties": {}, "required": []},
            "execute": _noop_execute,
            "kind": "mcp",
        },
        {
            "schema": {"name": "hangup", "description": "d", "properties": {}, "required": []},
            "execute": _noop_execute,
            "kind": "builtin",
            "protect_from_interruption": True,
        },
    ]


class _FakeNonRealtimeLLM:
    """Records registration mode; deliberately NOT an Ultravox service."""

    def __init__(self):
        self.registered: dict[str, bool] = {}

    def register_function(self, name, handler, *, cancel_on_interruption=True, timeout_secs=None):
        self.registered[name] = cancel_on_interruption


def _new_ultravox_service() -> UltravoxRealtimeLLMService:
    """A real Ultravox service instance WITHOUT running __init__ (no socket/keys).

    ``register_function`` only touches ``self._functions``, so seeding that dict
    is enough to exercise the real (inherited) registration path and read back
    the stored ``cancel_on_interruption`` per tool.
    """
    llm = object.__new__(UltravoxRealtimeLLMService)
    llm._functions = {}
    return llm


def test_detection_matches_ultravox_and_our_shim_only():
    from pipecat_aplisay.ultravox_compat import AplisayUltravoxRealtimeLLMService

    assert _is_ultravox_realtime(_new_ultravox_service()) is True
    assert _is_ultravox_realtime(object.__new__(AplisayUltravoxRealtimeLLMService)) is True
    assert _is_ultravox_realtime(_FakeNonRealtimeLLM()) is False


def test_ultravox_registers_data_tools_async_builtins_sync():
    llm = _new_ultravox_service()
    schemas = _register_tools_on_llm(llm, _tools())

    # Data-returning tools run async so interruptions don't cancel them and
    # their results reach Ultravox promptly.
    assert llm._functions["calendar_get_slots"].cancel_on_interruption is False
    assert llm._functions["knowledge_search"].cancel_on_interruption is False
    # Side-effecting builtins stay synchronous (handover machinery + shield).
    assert llm._functions["hangup"].cancel_on_interruption is True
    # Tool surface is unchanged — every tool still registered + schema'd.
    assert {s.name for s in schemas.standard_tools} == {
        "calendar_get_slots",
        "knowledge_search",
        "hangup",
    }


def test_non_ultravox_path_keeps_every_tool_sync():
    llm = _FakeNonRealtimeLLM()
    _register_tools_on_llm(llm, _tools())

    # Off the Ultravox path (pipeline STT->LLM->TTS) the freeze doesn't apply
    # and the text-LLM aggregator's deferred push is correct — leave sync.
    assert llm.registered == {
        "calendar_get_slots": True,
        "knowledge_search": True,
        "hangup": True,
    }


def test_async_tool_ships_immediate_placeholder_to_unfreeze_the_call():
    """The core UX fix: because a data tool is async, Ultravox's
    ``_handle_tool_invocation`` ships a placeholder ``client_tool_result`` the
    instant the tool is invoked, so the frozen call is released immediately
    instead of waiting for the real result (or the next tool call) to arrive.

    ``run_function_calls`` (which needs a full pipeline/task manager) is stubbed
    to a no-op so this isolates the placeholder path — the behaviour that
    depends directly on the async registration mode via ``_function_is_async``.
    """
    llm = _new_ultravox_service()
    llm._started_placeholder_sent = set()
    sent: list[dict] = []

    async def _fake_send(payload):
        sent.append(payload)

    async def _noop_run_function_calls(_calls):
        return None

    llm._send = _fake_send
    llm.run_function_calls = _noop_run_function_calls

    # Register the tool async, exactly as the worker does on Ultravox.
    _register_tools_on_llm(
        llm,
        [
            {
                "schema": {"name": "calendar_get_slots", "description": "d", "properties": {}, "required": []},
                "execute": _noop_execute,
                "kind": "function",
            }
        ],
    )
    assert llm._function_is_async("calendar_get_slots") is True

    invocation_id = "tool-call-1"
    asyncio.run(llm._handle_tool_invocation("calendar_get_slots", invocation_id, {}))

    placeholders = [
        m for m in sent if m.get("type") == "client_tool_result" and m.get("invocationId") == invocation_id
    ]
    assert placeholders, "async tool must unfreeze the call with an immediate placeholder result"


def test_sync_tool_sends_no_placeholder_leaving_the_call_frozen():
    """Counterpart: a SYNC tool (the old behaviour / off-Ultravox builtins) does
    NOT ship a placeholder, so Ultravox stays frozen until the real result — the
    exact condition the fix removes for data tools. Locks the contrast so a
    regression that flips data tools back to sync is caught here too.
    """
    llm = _new_ultravox_service()
    llm._started_placeholder_sent = set()
    sent: list[dict] = []

    async def _fake_send(payload):
        sent.append(payload)

    async def _noop_run_function_calls(_calls):
        return None

    llm._send = _fake_send
    llm.run_function_calls = _noop_run_function_calls

    # A shielded builtin stays synchronous even on Ultravox.
    _register_tools_on_llm(
        llm,
        [
            {
                "schema": {"name": "hangup", "description": "d", "properties": {}, "required": []},
                "execute": _noop_execute,
                "kind": "builtin",
                "protect_from_interruption": True,
            }
        ],
    )
    assert llm._function_is_async("hangup") is False

    asyncio.run(llm._handle_tool_invocation("hangup", "tool-call-2", {}))
    assert not sent, "sync tool must not ship a placeholder result"
