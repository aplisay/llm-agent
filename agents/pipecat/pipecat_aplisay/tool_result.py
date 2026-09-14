"""Cap third-party results against the model's input budget, which may cover the whole session. See PR #322.
Mark truncation so the model can request a smaller result; see docs/gpt-live.md."""

from __future__ import annotations

import json
from typing import Any

#: Limit model-visible text in UTF-8 bytes; callers with tighter budgets override this cap. See PR #322.
MAX_RESULT_BYTES = 8000

#: Delegation budgets cover the whole session, so leave room for later tool calls. See PR #322.
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
    """Return (result, bytes_dropped); oversized structured values become marked JSON text because they cannot be sliced.
    Keep the type intact for values within the cap; see PR #322."""
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
