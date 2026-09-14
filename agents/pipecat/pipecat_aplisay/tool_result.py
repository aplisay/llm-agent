"""Bounding what one tool result may cost the conversation.

Shared by the two places a tool result reaches a model: MCP proxying
(:mod:`pipecat_aplisay.mcp_tools`) and the agent's own REST/builtin functions
(:mod:`pipecat_aplisay.function_handler`). Both call out to third parties that
can return whatever they like, at whatever size.

WHY A CAP EXISTS AT ALL (2026-09-14)
------------------------------------
A model's input budget is finite, and on some backends it is spent for the
whole session rather than the turn. OpenAI's responses delegation allows 32768
UTF-8 bytes of tool input per session; past that it refuses items, and because
it still counts the function call as unanswered it then refuses to continue the
response — which strands the delegation rather than failing it, leaving a live
call silent (see docs/gpt-live.md and ``gpt_live_service``'s recovery).

One beta call fetched four whole documents in a single turn: eleven tool
results totalling 104502 bytes against that 32768-byte budget.

Truncation is always announced in the returned text. Silence is the dangerous
option: a model cannot tell a short answer from a cut one, and will answer
confidently from half a document. The marker names the byte counts and asks for
a smaller or more specific part, which is something the model can act on.
"""

from __future__ import annotations

import json
from typing import Any

#: Largest tool result handed to the model, in UTF-8 bytes.
#:
#: Far more than a spoken answer needs, while leaving a document recognisable
#: to a model that wanted one fact from it. Callers whose model has a tighter
#: budget pass their own.
MAX_RESULT_BYTES = 8000

#: The cap for tools behind a responses delegation, whose 32768-byte budget is
#: consumed for the whole session. A voice call makes tool calls in double
#: figures, so a result has to cost a fraction of the budget rather than a
#: quarter of it; at this size the budget lasts a dozen-plus calls.
MAX_RESULT_BYTES_DELEGATED = 2500


def _marker(tool: str, dropped: int, total: int) -> str:
    return (
        f"\n\n[{tool}: truncated here. {dropped} of {total} bytes were not returned, "
        "because the full result is too large for this conversation. Ask for a smaller or more "
        "specific part of it if you need more, and do not repeat this call unchanged.]"
    )


def clip_result(text: str, max_bytes: int, *, tool: str) -> tuple[str, int]:
    """Bound one textual tool result, returning ``(text, bytes_dropped)``.

    Cuts on a line boundary when one falls in the last quarter, so a result is
    not left ending mid-word, but never sacrifices more than that to find one.
    A cap of zero or less disables capping.
    """
    if max_bytes <= 0:
        return text, 0
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text, 0
    # Decode back with errors="ignore" so a cut inside a multi-byte character
    # drops that character rather than producing invalid UTF-8.
    kept = encoded[:max_bytes].decode("utf-8", errors="ignore")
    boundary = kept.rfind("\n")
    if boundary > max_bytes * 0.75:
        kept = kept[:boundary]
    dropped = len(encoded) - len(kept.encode("utf-8"))
    return kept.rstrip() + _marker(tool, dropped, len(encoded)), dropped


def clip_any_result(result: Any, max_bytes: int, *, tool: str) -> tuple[Any, int]:
    """Bound a tool result of any shape, returning ``(result, bytes_dropped)``.

    A REST function returns parsed JSON as often as text, and half a ``dict``
    is not a ``dict`` — there is no way to cut structured data and leave it
    structured. So an oversized structured result is rendered to JSON and
    clipped as text: the model reads the result as JSON either way (the live
    services ``json.dumps`` whatever comes back), so what it loses is the
    guarantee of well-formedness, which the marker immediately explains.

    Values that fit are returned untouched, with their type intact — which is
    every ordinary result, so the common path changes nothing.
    """
    if max_bytes <= 0 or result is None:
        return result, 0
    if isinstance(result, str):
        return clip_result(result, max_bytes, tool=tool)
    try:
        rendered = json.dumps(result, ensure_ascii=False, default=str)
    except Exception:  # noqa: BLE001
        rendered = str(result)
    if len(rendered.encode("utf-8")) <= max_bytes:
        return result, 0
    return clip_result(rendered, max_bytes, tool=tool)
