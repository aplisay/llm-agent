"""Structured, INFO-level logging of every LLM tool / MCP call and its result
into the per-call InvocationLog ("debug log").

The ``event`` field is the stable marker that distinguishes these entries from
all other InvocationLog output:

* ``event="tool_call"``   — a tool/MCP call is being invoked (INFO)
* ``event="tool_result"`` — the call returned (INFO on success / cancellation,
  WARNING on error — all are >= the default ``LOGLEVEL=INFO`` capture sink, so
  failures stay visible while keeping their severity)

The field shape is kept deliberately identical to the livekit worker's
``agents/livekit/lib/tool-log.ts`` so tool activity reads and correlates the
same across the ``pipecat-agent`` and ``livekit-agent`` subsystems:
``tool`` (name), ``kind`` (function|builtin|mcp), ``arguments``, ``ok``,
``result``, ``error``, ``durationMs``.

Records are only captured into the InvocationLog when emitted inside the
``logger.contextualize(callId=...)`` scope — the capture sink
(:mod:`pipecat_aplisay.invocation_log`) keys on ``callId``. Tool execution runs
inside that scope via ``CallSession._run_prepared_once``, so these emit through
to the debug log; the same dependency governs every other in-call log line.
"""

from __future__ import annotations

import json
from typing import Any

from loguru import logger as _logger

# Cap any single logged value so one large tool result (e.g. a big REST or MCP
# payload) cannot dominate the size-bounded InvocationLog and crowd out the rest
# of the call's log. Matches the livekit helper's cap.
_MAX_LOG_VALUE_CHARS = 8000


def _truncate_for_log(value: Any) -> Any:
    """Return ``value`` unchanged when it serialises small (so loguru records it
    structured), otherwise a truncated string with an explicit marker."""
    if value is None:
        return value
    if isinstance(value, str):
        s = value
    else:
        try:
            s = json.dumps(value, default=str)
        except Exception:  # noqa: BLE001
            s = str(value)
    if len(s) <= _MAX_LOG_VALUE_CHARS:
        return value
    return f"{s[:_MAX_LOG_VALUE_CHARS]}…[truncated {len(s) - _MAX_LOG_VALUE_CHARS} chars]"


def log_tool_call(*, tool: str, kind: str, arguments: Any) -> None:
    """Log a tool/MCP invocation at INFO with ``event="tool_call"``."""
    _logger.bind(
        event="tool_call",
        tool=tool,
        kind=kind,
        arguments=_truncate_for_log(arguments),
    ).info(f"tool call: {tool}")


def log_tool_result(
    *,
    tool: str,
    kind: str,
    ok: bool,
    duration_ms: int,
    result: Any = None,
    error: Any = None,
    cancelled: bool = False,
) -> None:
    """Log a tool/MCP result with ``event="tool_result"``.

    INFO on success or cancellation (an interrupted protected builtin keeps
    running in the background — an expected lifecycle event, not a failure);
    WARNING on a genuine error. All levels are captured at ``LOGLEVEL=INFO``.
    """
    fields: dict[str, Any] = {
        "event": "tool_result",
        "tool": tool,
        "kind": kind,
        "ok": ok,
        "durationMs": duration_ms,
    }
    if result is not None:
        fields["result"] = _truncate_for_log(result)
    if error is not None:
        fields["error"] = error if isinstance(error, str) else str(error)
    if cancelled:
        fields["cancelled"] = True
    bound = _logger.bind(**fields)
    if ok:
        bound.info(f"tool result: {tool}")
    elif cancelled:
        bound.info(f"tool cancelled: {tool}")
    else:
        bound.warning(f"tool error: {tool}")
