"""``promptMetadata`` — call metadata stated to the model IN ITS SYSTEM PROMPT
instead of left for it to fetch with a ``get_metadata`` tool call.

Python twin of ``lib/prompt-metadata.js`` — keep the rendering identical so an
agent definition produces the same prompt on every worker.

    promptMetadata: [
      {"description": "The current date/time is", "from": "aplisay.dateTime"},
      {"description": "The caller is calling from", "from": "aplisay.callerId"},
    ]

Why, when ``get_metadata`` already exposes the same values: a tool round-trip
only happens if the model REMEMBERS to make it, and on realtime providers it
freezes the conversation while it runs. Facts the agent reasons with from its
first utterance — today's date above all — belong in the prompt. Beta
2026-07-27: a booking agent kept computing "next Monday" as a 2025 date and
sending it as a slot-search start, because nothing in its context said what day
it was.

Rules (identical to the JS module):
  * ``from`` is a dot-path into the same call metadata that ``source:
    "metadata"`` function parameters read.
  * ``aplisay.dateTime`` is computed live here, exactly as the ``metadata``
    builtin does — a seeded value still wins.
  * An entry whose value is missing/None/blank is OMITTED, never rendered as
    "None": an absent optional fact must not become a statement the model then
    treats as true.
  * Mappings/sequences render as compact JSON; values are length-capped.
  * An empty/absent declaration leaves the prompt completely untouched.
"""

from __future__ import annotations

import json
from typing import Any, Optional, Sequence

from .current_datetime import current_datetime_string, is_datetime_metadata_key
from .function_handler import _get_by_path

PROMPT_METADATA_HEADING = "Call context (current facts about this call):"

MAX_PROMPT_METADATA_ENTRIES = 20
MAX_DESCRIPTION_CHARS = 200
MAX_VALUE_CHARS = 500


def _render_value(value: Any) -> Optional[str]:
    """One resolved value as prompt text, or None when it carries nothing."""
    if value is None:
        return None
    if isinstance(value, bool):
        # Match JS: booleans render lower-case, not Python's True/False.
        text = "true" if value else "false"
    elif isinstance(value, str):
        text = value
    elif isinstance(value, (int, float)):
        text = str(value)
    else:
        try:
            text = json.dumps(value, default=str, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            return None
    text = text.strip()
    if not text:
        return None
    return f"{text[:MAX_VALUE_CHARS]}…" if len(text) > MAX_VALUE_CHARS else text


def resolve_prompt_metadata_lines(
    prompt_metadata: Optional[Sequence[dict]], metadata: Optional[dict]
) -> list[str]:
    """Resolve a ``promptMetadata`` declaration into rendered prompt lines."""
    if not isinstance(prompt_metadata, (list, tuple)) or not prompt_metadata:
        return []

    lines: list[str] = []
    for entry in list(prompt_metadata)[:MAX_PROMPT_METADATA_ENTRIES]:
        if not isinstance(entry, dict):
            continue
        raw_from = entry.get("from")
        from_path = raw_from.strip() if isinstance(raw_from, str) else ""
        if not from_path:
            continue

        value = _get_by_path(metadata or {}, from_path)
        # Live clock, same rule as the `metadata` builtin: a seeded value wins.
        if value is None and is_datetime_metadata_key(from_path):
            value = current_datetime_string()

        rendered = _render_value(value)
        if rendered is None:
            continue

        raw_description = entry.get("description")
        description = (
            raw_description.strip()[:MAX_DESCRIPTION_CHARS] if isinstance(raw_description, str) else ""
        )
        lines.append(f"{description} {rendered}" if description else rendered)
    return lines


def prompt_with_metadata(
    prompt: Optional[str], prompt_metadata: Optional[Sequence[dict]], metadata: Optional[dict]
) -> str:
    """``prompt`` with its resolved ``promptMetadata`` appended.

    Returns ``prompt`` unchanged when nothing resolves, so an agent without the
    feature is byte-identical to before.
    """
    lines = resolve_prompt_metadata_lines(prompt_metadata, metadata)
    base = prompt if isinstance(prompt, str) else ""
    if not lines:
        return base
    block = PROMPT_METADATA_HEADING + "\n" + "\n".join(lines)
    return f"{base.rstrip()}\n\n{block}" if base.strip() else block
