"""What the platform appends to a realtime model's context mid-call, shared by
the service subclasses (grok_service.py, openai_realtime_service.py). No
provider imports: voice_session loads this on every realtime call."""

from __future__ import annotations

from typing import Any, Optional

#: What the model is told when the caller presses keypad digits.
DTMF_MESSAGE = "The caller pressed the keypad digits: {digits}"


def text_of(content: Any) -> str:
    """The text of a message's content: a string, or its text parts joined."""
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = [
            part.get("text", "") for part in content
            if isinstance(part, dict) and part.get("type") in ("text", "input_text") and isinstance(part.get("text"), str)
        ]
        return "".join(parts).strip()
    return ""


def platform_message_text(message: Any) -> Optional[str]:
    """The text of an appended developer or system message, or None for any
    other message. User messages are never resent: the aggregator adds one per
    transcribed turn, and the server already holds that audio item."""
    # LLMSpecificMessage is a dataclass, so the dict check covers it.
    if not isinstance(message, dict):
        return None
    if message.get("role") not in ("developer", "system") or message.get("tool_call_id"):
        return None
    return text_of(message.get("content")) or None
