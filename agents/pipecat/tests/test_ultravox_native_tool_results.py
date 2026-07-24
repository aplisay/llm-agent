"""Native tool-result delivery on the Ultravox realtime path
(:mod:`pipecat_aplisay.voice_session` + :mod:`pipecat_aplisay.ultravox_compat`).

Evolved over two 2026-07-24 staging incidents:

1. Data tools registered SYNCHRONOUSLY were cancelled ~30ms in by the caller's
   trailing-speech interruption, and their results only shipped on the next
   context push — the call froze until the next tool call.
2. Registering ``cancel_on_interruption=False`` fixed the cancel but put the
   service on Pipecat's async-tool path, which unfreezes with a PLACEHOLDER and
   delivers the real result as user-side TEXT that Ultravox ignores — so the
   model looped re-calling the tool (booking_get_slots ×4).

The fix keeps ``cancel_on_interruption=False`` for its no-cancel property only,
SUPPRESSES the placeholder, and ships the true result as a native
``client_tool_result`` for the same invocation id. These tests lock:
  * registration mode per tool-type (data async, builtins/off-path sync),
  * the subclass suppresses the placeholder but still runs the tool,
  * deliver_native_tool_result sends a native result + is idempotent,
  * the _runner helper forwards to it only when the service supports it.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from pipecat_aplisay.voice_session import (
    _deliver_native_result,
    _is_ultravox_realtime,
    _register_tools_on_llm,
)

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


def _new_ultravox_service():
    """A real Ultravox service instance WITHOUT running __init__ (no socket/keys).

    register_function / deliver_native_tool_result / _handle_tool_invocation only
    touch a few attributes, seeded here, so the real (inherited + overridden)
    code paths run with no network.
    """
    from pipecat_aplisay.ultravox_compat import AplisayUltravoxRealtimeLLMService

    llm = object.__new__(AplisayUltravoxRealtimeLLMService)
    llm._functions = {}
    llm._completed_tool_calls = set()
    llm._started_placeholder_sent = set()
    return llm


# ── detection + registration mode ────────────────────────────────────────────


def test_detection_matches_ultravox_and_our_shim_only():
    assert _is_ultravox_realtime(_new_ultravox_service()) is True
    assert _is_ultravox_realtime(object.__new__(UltravoxRealtimeLLMService)) is True
    assert _is_ultravox_realtime(_FakeNonRealtimeLLM()) is False


def test_ultravox_registers_data_tools_uncancellable_builtins_sync():
    llm = _new_ultravox_service()
    schemas = _register_tools_on_llm(llm, _tools())

    # Data tools: cancel_on_interruption=False protects the tool turn from the
    # interruption-cancel (delivery is native, see below).
    assert llm._functions["calendar_get_slots"].cancel_on_interruption is False
    assert llm._functions["knowledge_search"].cancel_on_interruption is False
    # Side-effecting builtins stay synchronous (handover machinery + shield).
    assert llm._functions["hangup"].cancel_on_interruption is True
    assert {s.name for s in schemas.standard_tools} == {"calendar_get_slots", "knowledge_search", "hangup"}


def test_non_ultravox_path_keeps_every_tool_sync():
    llm = _FakeNonRealtimeLLM()
    _register_tools_on_llm(llm, _tools())
    assert llm.registered == {"calendar_get_slots": True, "knowledge_search": True, "hangup": True}


# ── placeholder suppression + native delivery ────────────────────────────────


def test_handle_tool_invocation_suppresses_placeholder_but_runs_the_tool():
    llm = _new_ultravox_service()
    sent: list[dict] = []
    ran: list = []

    async def _fake_send(payload):
        sent.append(payload)

    async def _fake_run_function_calls(calls):
        ran.append(calls)

    llm._send = _fake_send
    llm.run_function_calls = _fake_run_function_calls

    asyncio.run(llm._handle_tool_invocation("calendar_get_slots", "inv-1", {"from": "x"}))

    # No placeholder client_tool_result is shipped (the bug we removed)...
    assert sent == []
    # ...but the tool still runs (exactly one function call, right identity).
    assert len(ran) == 1 and len(ran[0]) == 1
    call = ran[0][0]
    assert call.function_name == "calendar_get_slots"
    assert call.tool_call_id == "inv-1"
    assert call.arguments == {"from": "x"}


def test_deliver_native_tool_result_sends_native_result_and_is_idempotent():
    llm = _new_ultravox_service()
    sent: list[dict] = []

    async def _fake_send(payload):
        sent.append(payload)

    llm._send = _fake_send

    result = {"slots": [{"id": "2026-07-25T09:00:00Z", "spoken": "Saturday 9am"}]}
    asyncio.run(llm.deliver_native_tool_result("inv-42", result))

    assert len(sent) == 1
    msg = sent[0]
    assert msg["type"] == "client_tool_result"  # NATIVE, not user text
    assert msg["invocationId"] == "inv-42"
    assert json.loads(msg["result"]) == result  # real payload, serialised
    assert "inv-42" in llm._completed_tool_calls  # dedupes the async-final path

    # A second delivery for the same invocation is a no-op (exactly one result).
    asyncio.run(llm.deliver_native_tool_result("inv-42", {"changed": True}))
    assert len(sent) == 1


def test_deliver_native_tool_result_passes_string_payloads_through():
    llm = _new_ultravox_service()
    sent: list[dict] = []

    async def _fake_send(payload):
        sent.append(payload)

    llm._send = _fake_send
    asyncio.run(llm.deliver_native_tool_result("inv-str", "already a string"))
    assert sent[0]["result"] == "already a string"


# ── the _runner delivery helper ──────────────────────────────────────────────


class _Params:
    def __init__(self, llm, tool_call_id="inv-1"):
        self.llm = llm
        self.tool_call_id = tool_call_id


def test_deliver_native_result_forwards_to_ultravox_service():
    llm = _new_ultravox_service()
    sent: list[dict] = []

    async def _fake_send(payload):
        sent.append(payload)

    llm._send = _fake_send
    asyncio.run(_deliver_native_result(_Params(llm, "inv-7"), {"ok": True}))
    assert len(sent) == 1 and sent[0]["invocationId"] == "inv-7"


def test_deliver_native_result_is_a_noop_for_non_ultravox_services():
    # A service without deliver_native_tool_result (pipeline text-LLM path) must
    # not error — native delivery simply doesn't apply there.
    class _Plain:
        pass

    # Should complete without raising and without needing any Ultravox state.
    asyncio.run(_deliver_native_result(_Params(_Plain(), "inv-9"), {"ok": True}))
