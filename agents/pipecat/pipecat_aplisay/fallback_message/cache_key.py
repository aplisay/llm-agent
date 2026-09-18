"""Cache-key derivation for synthesised fallback messages.

Sibling of ``lib/fallback-message/cache-key.js``. The digest formula is a
cross-runtime contract — see ``lib/fallback-message/CONTRACT.md``. A change
here that is not mirrored on the JS side does not corrupt anything, it just
splits the cache so each runtime re-synthesises what the other already paid
for.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from typing import Any, Optional

#: Digest length in hex characters. 32 hex chars = 128 bits.
KEY_LENGTH = 32


@dataclass(frozen=True)
class ResolvedFallbackMessage:
    """A fallback message with its TTS settings resolved against the agent."""

    text: str
    vendor: Optional[str] = None
    voice: Optional[str] = None
    language: Optional[str] = None


def _clean(value: Any) -> Optional[str]:
    if isinstance(value, str) and value.strip():
        return value.strip()
    return None


def resolve_fallback_message(
    message: Any,
    agent_options: Optional[dict] = None,
    *,
    inherit_agent_tts: bool = True,
) -> Optional[ResolvedFallbackMessage]:
    """Resolve ``options.fallback.message`` against the agent's ``options.tts``.

    The message may name its own vendor/voice/language: the point of the
    feature is that the announcement can be spoken by a TTS known to work even
    when the agent's own stack is what just failed. Anything it does not state
    falls back to the agent's normal TTS settings, so the common case ("say
    this, in my usual voice") needs only ``text``.

    ``inherit_agent_tts`` is the exception, and it matters: a realtime
    speech-to-speech agent (Ultravox, OpenAI Realtime, Gemini Live) has no
    discrete TTS, and its ``options.tts.voice`` names a timbre of the *model*.
    The announcement is always spoken by a real TTS — it plays because the
    model could not be started, so the model cannot be what speaks it — and
    handing ``build_tts_service`` a vendor of ``ultravox`` does not degrade, it
    raises ``Unsupported TTS vendor``. So for those agents the vendor and voice
    are NOT inherited, leaving the worker's default TTS unless the message
    names one explicitly.

    ``language`` is inherited either way: it is a portable BCP-47 tag meaning
    the same thing to a model and to a TTS, and an announcement in the wrong
    language would be worse than one in an unfamiliar voice.

    Callers must agree with the LiveKit side on ``inherit_agent_tts``: it feeds
    the cache key, so deciding differently would split the shared cache.

    The option always takes an object: a bare string is NOT accepted as
    shorthand for ``{"text": ...}``, so there is one shape to document, one to
    validate, and one to read. Returns ``None`` for anything else, though the
    write-time validation in ``lib/database.js`` rejects a bad shape outright,
    so it is a save error rather than an announcement that never plays.
    """
    if not isinstance(message, dict):
        return None
    raw = message
    text = raw.get("text")
    text = text.strip() if isinstance(text, str) else ""
    if not text:
        return None
    tts = (agent_options or {}).get("tts") or {}
    inherited = tts if inherit_agent_tts else {}
    return ResolvedFallbackMessage(
        text=text,
        vendor=_clean(raw.get("vendor")) or _clean(inherited.get("vendor")),
        voice=_clean(raw.get("voice")) or _clean(inherited.get("voice")),
        # Always inherited — a language tag is portable across model and TTS.
        language=_clean(raw.get("language")) or _clean(tts.get("language")),
    )


def fallback_message_key(resolved: ResolvedFallbackMessage) -> str:
    """Derive the content-addressed cache key for a resolved message.

    Fields are hashed as a canonical JSON array rather than a concatenated
    string so a value containing the separator cannot collide with a different
    field split. ``separators`` is pinned because Python's default JSON encoder
    inserts a space after ``,`` where JavaScript's ``JSON.stringify`` does not
    — without it the two runtimes would derive different keys for identical
    input, which is exactly the split this contract exists to prevent.
    """
    if not resolved or not resolved.text:
        raise ValueError("fallback_message_key: resolved message must have text")
    canonical = json.dumps(
        [
            resolved.text,
            resolved.vendor or "",
            resolved.voice or "",
            resolved.language or "",
        ],
        separators=(",", ":"),
        ensure_ascii=False,
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:KEY_LENGTH]
