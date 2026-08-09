"""Tests for the tool-call / tool-result InvocationLog instrumentation
(:mod:`pipecat_aplisay.tool_log`).

These drive the *real* loguru capture sink at the production ``INFO`` level to
prove that:
  * every tool call + result is captured (not dropped as sub-INFO),
  * each carries the ``event`` marker that distinguishes it from other log
    output, plus the shared ``tool``/``kind``/``arguments``/``result`` fields,
  * an errored result keeps WARNING severity while still being captured,
  * a call/result emitted outside a ``contextualize(callId=...)`` scope is NOT
    captured (documents the capture dependency),
  * large values are truncated so one tool result can't dominate the log.
"""

from __future__ import annotations

import pytest
from loguru import logger

from pipecat_aplisay import invocation_log, tool_log


@pytest.fixture(autouse=True)
def _clear_buffer():
    with invocation_log._LOCK:
        invocation_log._BUFFER.clear()
    yield
    with invocation_log._LOCK:
        invocation_log._BUFFER.clear()


@pytest.fixture()
def capture():
    """Install the real capture sink at INFO (as in production) for the duration
    of the test, then remove it. Yields the shared buffer."""
    sink_id = logger.add(
        invocation_log._capture_sink,
        level="INFO",
        enqueue=False,
        backtrace=False,
        diagnose=False,
    )
    try:
        yield invocation_log._BUFFER
    finally:
        logger.remove(sink_id)


def _extra(entry: dict) -> dict:
    return entry.get("extra") or {}


def test_tool_call_and_result_captured_at_info(capture):
    with logger.contextualize(callId="call-A"):
        tool_log.log_tool_call(
            tool="get_weather", kind="function", arguments={"q": "London"}
        )
        tool_log.log_tool_result(
            tool="get_weather", kind="function", ok=True, duration_ms=12, result="sunny"
        )

    assert len(capture) == 2
    call, result = capture

    # tool_call: INFO (pino 30), event marker + shared fields, structured args.
    assert call["level"] == 30
    assert call["callId"] == "call-A"
    assert _extra(call)["event"] == "tool_call"
    assert _extra(call)["tool"] == "get_weather"
    assert _extra(call)["kind"] == "function"
    assert _extra(call)["arguments"] == {"q": "London"}

    # tool_result: INFO, ok + result + durationMs.
    assert result["level"] == 30
    assert _extra(result)["event"] == "tool_result"
    assert _extra(result)["ok"] is True
    assert _extra(result)["result"] == "sunny"
    assert _extra(result)["durationMs"] == 12


def test_errored_result_is_warning_but_still_captured(capture):
    with logger.contextualize(callId="call-A"):
        tool_log.log_tool_result(
            tool="do_thing", kind="function", ok=False, duration_ms=3, error="boom"
        )

    assert len(capture) == 1
    (entry,) = capture
    assert entry["level"] == 40  # pino WARNING — captured (>= INFO) but notable
    assert entry["levelName"] == "WARNING"
    assert _extra(entry)["event"] == "tool_result"
    assert _extra(entry)["ok"] is False
    assert _extra(entry)["error"] == "boom"


def test_cancelled_result_is_info(capture):
    with logger.contextualize(callId="call-A"):
        tool_log.log_tool_result(
            tool="transfer_agent",
            kind="builtin",
            ok=False,
            duration_ms=1,
            cancelled=True,
            error="cancelled by interruption",
        )

    (entry,) = capture
    # Cancellation of a protected builtin is an expected lifecycle event, so it
    # stays at INFO even though ok is False.
    assert entry["level"] == 30
    assert _extra(entry)["cancelled"] is True
    assert _extra(entry)["kind"] == "builtin"


def test_mcp_kind_passthrough(capture):
    with logger.contextualize(callId="call-A"):
        tool_log.log_tool_call(
            tool="weatherserver_lookup", kind="mcp", arguments={"city": "Paris"}
        )
    (entry,) = capture
    assert _extra(entry)["kind"] == "mcp"
    assert _extra(entry)["event"] == "tool_call"


def test_subagent_kind_passthrough(capture):
    # A `subagent` builtin (delegation to a headless text agent) is logged with
    # its own kind, split out from the generic `builtin`, so consumers can
    # surface agent-to-agent calls as their own category.
    with logger.contextualize(callId="call-A"):
        tool_log.log_tool_call(
            tool="insurance-checker",
            kind="subagent",
            arguments={"question": "is this covered?"},
        )
        tool_log.log_tool_result(
            tool="insurance-checker",
            kind="subagent",
            ok=True,
            duration_ms=1200,
            result="Covered — no copay",
        )
    call, result = capture
    assert _extra(call)["kind"] == "subagent"
    assert _extra(call)["event"] == "tool_call"
    assert _extra(result)["kind"] == "subagent"
    assert _extra(result)["event"] == "tool_result"


def test_not_captured_without_call_context(capture):
    # No logger.contextualize(callId=...) scope -> the sink drops it.
    tool_log.log_tool_call(tool="orphan", kind="function", arguments={})
    tool_log.log_tool_result(tool="orphan", kind="function", ok=True, duration_ms=0)
    assert capture == []


def test_large_value_is_truncated():
    small = {"a": 1}
    assert tool_log._truncate_for_log(small) is small  # returned structured

    big = "x" * (tool_log._MAX_LOG_VALUE_CHARS + 500)
    out = tool_log._truncate_for_log(big)
    assert isinstance(out, str)
    assert out.startswith("x" * 100)
    assert "[truncated 500 chars]" in out
    assert len(out) < len(big)
