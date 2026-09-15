"""xAI Grok on the Pipecat worker: the SDK-free helpers.

docs/grok.md is the user-facing description. The Grok Voice Agent API
(``pipecat:xai/grok-voice-think-fast-2.0``) is wire-compatible with OpenAI's
Realtime API, and Pipecat's ``GrokRealtimeLLMService`` speaks it; the
platform's own pieces are the option mappings here, the service subclass in
:mod:`pipecat_aplisay.grok_service` and the wiring in ``voice_session`` and
``call_session``. The Grok text models also run as the LLM stage of a
pipeline row (``pipecat:xai/grok-4.3``); those need nothing from this module
beyond :func:`is_xai_model_id`.
"""

from __future__ import annotations

from typing import Any, Optional

from loguru import logger

from .gpt_live import deep_merge

#: The voice the session uses when the agent sets none. Must match
#: XAI_DEFAULT_VOICE in lib/voices/xai.js.
XAI_DEFAULT_VOICE = "eve"

#: xAI's transcription model for the caller's audio; always on (plan decision 10).
XAI_TRANSCRIPTION_MODEL = "grok-transcribe"

#: Session tool types that mean an xAI server-side tool. Not offered (plan
#: decision 14): rejected by the API server at save time and stripped here as
#: a second line. Must match XAI_SERVER_TOOL_TYPES in lib/grok-limits.js.
XAI_SERVER_TOOL_TYPES = frozenset({"mcp", "web_search", "x_search", "file_search"})

#: What the model is told when the caller presses keypad digits.
DTMF_MESSAGE = "The caller pressed the keypad digits: {digits}"


def is_xai_model_id(model_id: Optional[str]) -> bool:
    """True for every ``xai/`` row (voice and pipeline)."""
    return (model_id or "").strip().lower().startswith("xai/")


def is_xai_voice_model_id(model_id: Optional[str]) -> bool:
    """True for the Grok voice rows (``xai/grok-voice*``). Must match
    isXaiVoiceModelName in lib/grok-limits.js."""
    return (model_id or "").strip().lower().startswith("xai/grok-voice")


def xai_session_overrides(agent: dict) -> dict:
    """``options.vendorSpecific.xai.session``: deep-merged into every
    ``session.update`` after the portable mapping. ``{}`` when unset."""
    vendor = ((agent or {}).get("options") or {}).get("vendorSpecific") or {}
    if not isinstance(vendor, dict):
        return {}
    xai = vendor.get("xai") or {}
    session = xai.get("session") if isinstance(xai, dict) else None
    return dict(session) if isinstance(session, dict) else {}


def _is_server_tool(value: Any) -> bool:
    return isinstance(value, dict) and value.get("type") in XAI_SERVER_TOOL_TYPES


def strip_server_tools(session: dict) -> dict:
    """The overrides without a ``tools`` array and without any entry that is
    an xAI server-side tool. The API server rejects these at save time; this
    is the worker's own line so an older row can never enable one."""
    out: dict = {}
    for key, value in (session or {}).items():
        if key == "tools":
            logger.warning("vendorSpecific.xai.session.tools dropped: server-side tools are not offered")
            continue
        if _is_server_tool(value):
            logger.warning(f"vendorSpecific.xai.session.{key} dropped: server-side tools are not offered")
            continue
        if isinstance(value, list) and any(_is_server_tool(v) for v in value):
            kept = [v for v in value if not _is_server_tool(v)]
            logger.warning(f"vendorSpecific.xai.session.{key}: server-side tool entries dropped")
            out[key] = kept
            continue
        out[key] = value
    return out


def voice_effort(options: Optional[dict]) -> Optional[str]:
    """``options.effort`` on the voice row (plan decision 13): ``none`` and
    ``low`` send xAI's ``none``; ``medium``, ``high``, ``xhigh`` and ``max``
    send ``high``; unset or unknown leaves xAI's default (``high``)."""
    effort = (options or {}).get("effort")
    if not isinstance(effort, str):
        return None
    effort = effort.strip().lower()
    if effort in ("none", "low"):
        return "none"
    if effort in ("medium", "high", "xhigh", "max"):
        return "high"
    return None


def language_hint(agent: dict) -> Optional[str]:
    """The transcription language hint: the primary subtag of
    ``options.stt.language`` (then ``tts.language``), ``en-GB`` -> ``en``.
    None when the agent names no specific language."""
    from .voice_session import _agent_language_tag

    tag = _agent_language_tag(agent, prefer="stt")
    if not tag:
        return None
    primary = tag.split("-", 1)[0].strip().lower()
    return primary or None


def merged_session(base: dict, overrides: dict) -> dict:
    """``base`` (the platform's session payload) with the vendor overrides
    merged on top, an explicit override winning on a shared leaf."""
    return deep_merge(base or {}, overrides or {})
