"""ElevenLabs Agents on the Pipecat worker: the SDK-free helpers.

docs/elevenlabs-agents.md is the user-facing description. An ElevenLabs
agent is a hosted object: STT, LLM, TTS and turn-taking all run on the
ElevenLabs side, and a call is one conversation WebSocket against an agent
id. Creating an agent takes seconds, so the worker does not create one per
call. It keeps one ElevenLabs agent per *configuration hash* (the LLM, the
tools, the TTS model, the turn settings, everything that cannot change per
conversation) and sends the per-call values (the prompt, the greeting, the
voice, the language, the duration cap) as conversation overrides. See
:mod:`pipecat_aplisay.elevenlabs_agents_client` for the lookup and
:mod:`pipecat_aplisay.elevenlabs_agents_service` for the conversation.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from typing import Any, Optional

from loguru import logger

from .gpt_live import deep_merge, greeting_opening_instruction

#: The provider segment of the rows (``pipecat:elevenlabs/<llm>``).
ELEVENLABS_PROVIDER = "elevenlabs"

#: The voice a conversation uses when the agent sets none. Must match
#: ELEVENLABS_DEFAULT_VOICE in lib/elevenlabs-agents.js.
ELEVENLABS_DEFAULT_VOICE = "cjVigY5qzO86Huf0OWal"

#: Audio formats fixed on the agent. 16 kHz input is what the ASR wants; the
#: output is the highest rate the transports resample from without loss.
INPUT_AUDIO_FORMAT = "pcm_16000"
INPUT_SAMPLE_RATE = 16000
OUTPUT_AUDIO_FORMAT = "pcm_24000"
OUTPUT_SAMPLE_RATE = 24000

#: ElevenLabs caps a conversation at two hours (`max_duration_seconds`
#: must lie between 60 and 7200; checked 2026-10-22).
MIN_DURATION_SECONDS = 60
MAX_DURATION_SECONDS = 7200

#: The agent's own re-engagement after caller silence. The platform's
#: ``options.inactivity`` kick is the inactivity path, so this is pushed out
#: far enough never to fire first.
TURN_TIMEOUT_SECONDS = 300

#: How long a client tool may run before ElevenLabs gives up on its result
#: (the API maximum). The platform's own tool timeouts apply underneath.
TOOL_RESPONSE_TIMEOUT_SECONDS = 120

#: Server events the conversation subscribes to.
CLIENT_EVENTS = [
    "conversation_initiation_metadata",
    "audio",
    "interruption",
    "user_transcript",
    "agent_response",
    "agent_response_correction",
    "agent_response_complete",
    "client_tool_call",
    "agent_tool_response",
    "ping",
    "client_error",
]

#: Bump when the mapping below changes shape, so agents cached under the old
#: mapping are not reused.
CONFIG_VERSION = 1

#: Names ElevenLabs reserves for its system tools. A client tool with one of
#: these names is refused when the agent is saved (lib/elevenlabs-agents.js)
#: and dropped here as a second line.
RESERVED_TOOL_NAMES = frozenset({
    "end_call",
    "language_detection",
    "skip_turn",
    "transfer_to_agent",
    "transfer_to_number",
    "voicemail_detection",
    "play_keypad_touch_tone",
})

#: ``vendorSpecific.elevenlabs.conversation_config`` paths the platform owns.
#: They are refused at save time and stripped here. Dotted paths.
PROTECTED_CONFIG_PATHS = frozenset({
    "agent.prompt.prompt",
    "agent.prompt.llm",
    "agent.prompt.tools",
    "agent.prompt.tool_ids",
    "agent.prompt.tool_ids_strict",
    "agent.prompt.built_in_tools",
    "agent.prompt.mcp_server_ids",
    "agent.prompt.native_mcp_server_ids",
    "agent.prompt.knowledge_base",
    "agent.prompt.custom_llm",
    "agent.first_message",
    "tts.voice_id",
    "tts.agent_output_audio_format",
    "asr.user_input_audio_format",
    "conversation.client_events",
    "conversation.text_only",
    "conversation.max_duration_seconds",
})

#: ElevenLabs's own agents at `wss://api.elevenlabs.io`; the regional hosts
#: are reachable through ELEVENLABS_API_BASE.
DEFAULT_API_BASE = "https://api.elevenlabs.io"


def is_elevenlabs_agents_model_id(model_id: Optional[str]) -> bool:
    """True for every ``elevenlabs/`` row (all of them are ElevenLabs agents)."""
    return (model_id or "").strip().lower().startswith(f"{ELEVENLABS_PROVIDER}/")


def elevenlabs_llm(model_id: str) -> str:
    """The ElevenLabs LLM id named by the row: ``elevenlabs/gemini-2.5-flash``
    -> ``gemini-2.5-flash``. The roster only offers ids ElevenLabs accepts
    (lib/elevenlabs-agents.js)."""
    return (model_id or "").split("/", 1)[1].strip() if "/" in (model_id or "") else ""


def api_base() -> str:
    return (os.getenv("ELEVENLABS_API_BASE") or DEFAULT_API_BASE).rstrip("/")


def agent_name_prefix() -> str:
    """The first segment of every ElevenLabs agent name the worker creates, so
    one workspace can hold several deployments' agents side by side."""
    return (os.getenv("ELEVENLABS_AGENT_PREFIX") or "aplisay").strip() or "aplisay"


def vendor_config(agent: dict) -> dict:
    """``options.vendorSpecific.elevenlabs.conversation_config``: deep-merged
    into the agent configuration after the platform's mapping, minus the
    platform-owned paths. ``{}`` when unset."""
    vendor = ((agent or {}).get("options") or {}).get("vendorSpecific") or {}
    if not isinstance(vendor, dict):
        return {}
    block = vendor.get(ELEVENLABS_PROVIDER) or {}
    config = block.get("conversation_config") if isinstance(block, dict) else None
    if not isinstance(config, dict):
        return {}
    return strip_protected_paths(config)


def strip_protected_paths(config: dict, _prefix: str = "") -> dict:
    """``config`` without the paths in :data:`PROTECTED_CONFIG_PATHS`."""
    out: dict = {}
    for key, value in (config or {}).items():
        path = f"{_prefix}{key}"
        if path in PROTECTED_CONFIG_PATHS:
            logger.warning(f"vendorSpecific.elevenlabs.conversation_config.{path} dropped: the platform sets it")
            continue
        if isinstance(value, dict):
            out[key] = strip_protected_paths(value, f"{path}.")
        else:
            out[key] = value
    return out


# ---- tools -------------------------------------------------------------------

_SCHEMA_KEYS = ("type", "description", "enum", "items", "properties", "required")


def _clean_property(prop: Any) -> dict:
    """A JSON-schema property reduced to the keys ElevenLabs reads. A missing
    type is a string; nested objects and arrays are cleaned recursively."""
    if not isinstance(prop, dict):
        return {"type": "string", "description": ""}
    out: dict = {}
    for key in _SCHEMA_KEYS:
        if key not in prop:
            continue
        value = prop[key]
        if key == "items":
            out[key] = _clean_property(value)
        elif key == "properties":
            out[key] = {k: _clean_property(v) for k, v in (value or {}).items()} if isinstance(value, dict) else {}
        elif key == "required":
            if isinstance(value, list):
                out[key] = [v for v in value if isinstance(v, str)]
        elif key == "enum":
            if isinstance(value, list) and value:
                out[key] = list(value)
        else:
            out[key] = value
    out.setdefault("type", "object" if "properties" in out else "array" if "items" in out else "string")
    out.setdefault("description", "")
    return out


def client_tool(schema: dict) -> Optional[dict]:
    """One platform tool schema (``{name, description, properties, required}``)
    as an ElevenLabs client tool, or None for a reserved name. Every tool
    expects a response: the worker always answers, with the result or the
    error, so the conversation never waits on the timeout."""
    name = (schema or {}).get("name") or ""
    if name in RESERVED_TOOL_NAMES:
        logger.warning(f"tool {name!r} dropped: ElevenLabs reserves the name for a system tool")
        return None
    tool: dict = {
        "type": "client",
        "name": name,
        "description": schema.get("description") or "",
        "expects_response": True,
        "response_timeout_secs": TOOL_RESPONSE_TIMEOUT_SECONDS,
    }
    properties = schema.get("properties") or {}
    if isinstance(properties, dict) and properties:
        tool["parameters"] = {
            "type": "object",
            "description": "",
            "properties": {k: _clean_property(v) for k, v in properties.items()},
            "required": [r for r in (schema.get("required") or []) if r in properties],
        }
    return tool


def client_tools(schemas: list[dict]) -> list[dict]:
    return [tool for tool in (client_tool(s) for s in schemas or []) if tool is not None]


# ---- the hosted agent --------------------------------------------------------


def _number(value: Any) -> Optional[float]:
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def agent_config(agent: dict, *, llm: str, tool_schemas: list[dict]) -> dict:
    """The create-agent body for ``agent`` on the row naming ``llm``, before
    the name. Everything in it is fixed for the conversation's life; the
    per-call values are in :func:`conversation_overrides`. The vendor block
    is merged last, so an explicit value there wins on a shared leaf."""
    options = (agent or {}).get("options") or {}
    prompt: dict = {
        # Set per conversation; a placeholder keeps the agent valid on its own.
        "prompt": "Configured per conversation.",
        "llm": llm,
        "tools": client_tools(tool_schemas),
        # The platform's prompt is the whole persona.
        "ignore_default_personality": True,
    }
    temperature = _number(options.get("temperature"))
    if temperature is not None:
        prompt["temperature"] = temperature
    max_tokens = options.get("maxTokens")
    if isinstance(max_tokens, int) and not isinstance(max_tokens, bool) and max_tokens > 0:
        prompt["max_tokens"] = max_tokens
    conversation_config: dict = {
        "agent": {"prompt": prompt, "first_message": "", "language": "en"},
        "tts": {
            "voice_id": ELEVENLABS_DEFAULT_VOICE,
            "agent_output_audio_format": OUTPUT_AUDIO_FORMAT,
        },
        "asr": {"user_input_audio_format": INPUT_AUDIO_FORMAT},
        "turn": {"turn_timeout": TURN_TIMEOUT_SECONDS},
        "conversation": {
            "max_duration_seconds": MAX_DURATION_SECONDS,
            "client_events": list(CLIENT_EVENTS),
        },
    }
    conversation_config = deep_merge(conversation_config, vendor_config(agent))
    return {
        "_v": CONFIG_VERSION,
        "conversation_config": conversation_config,
        "platform_settings": {
            "overrides": {
                "conversation_config_override": {
                    "agent": {
                        "first_message": True,
                        "language": True,
                        "prompt": {"prompt": True},
                    },
                    "tts": {"voice_id": True, "speed": True, "stability": True, "similarity_boost": True},
                    "conversation": {"max_duration_seconds": True},
                }
            },
            # Transcripts and recordings are the platform's; ElevenLabs keeps
            # no audio and little else.
            "privacy": {"record_voice": False, "retention_days": 1},
            # A conversation needs a signed URL from the platform's key.
            "auth": {"enable_auth": True},
        },
    }


def config_hash(config: dict) -> str:
    """A stable digest of the configuration, the key the worker finds the
    hosted agent by."""
    canonical = json.dumps(config, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:20]


def agent_name(digest: str) -> str:
    return f"{agent_name_prefix()}:{digest}"


def create_body(config: dict, *, name: str) -> dict:
    """The POST body: the config without the version marker, plus the name
    and the tags the prune script looks for."""
    body = {k: v for k, v in config.items() if not k.startswith("_")}
    body["name"] = name
    body["tags"] = ["aplisay", agent_name_prefix()]
    return body


# ---- per conversation --------------------------------------------------------


def clamp_duration(seconds: Optional[int]) -> int:
    """The ElevenLabs duration cap for a call whose own cap is ``seconds``:
    a minute more than ours so the worker's stop comes first, within the
    API's range."""
    if not isinstance(seconds, (int, float)) or seconds <= 0:
        return MAX_DURATION_SECONDS
    return int(min(MAX_DURATION_SECONDS, max(MIN_DURATION_SECONDS, seconds + 60)))


def language_code(agent: dict) -> Optional[str]:
    """The primary subtag of ``options.tts.language`` (then ``stt.language``):
    ``en-GB`` -> ``en``. None when the agent names no specific language."""
    from .voice_session import _agent_language_tag

    tag = _agent_language_tag(agent, prefer="tts")
    if not tag:
        return None
    primary = tag.split("-", 1)[0].strip().lower()
    return primary or None


def conversation_overrides(
    agent: dict,
    *,
    system_prompt: str,
    first_message: str,
    max_duration_secs: Optional[int],
) -> dict:
    """``conversation_config_override`` for one conversation."""
    from .tts_speed import tts_speed_for

    options = (agent or {}).get("options") or {}
    voice = (options.get("tts") or {}).get("voice") or ELEVENLABS_DEFAULT_VOICE
    agent_block: dict = {"prompt": {"prompt": system_prompt or ""}, "first_message": first_message or ""}
    language = language_code(agent)
    if language:
        agent_block["language"] = language
    tts: dict = {"voice_id": voice}
    speed = tts_speed_for(agent, ELEVENLABS_PROVIDER)
    if speed is not None:
        tts["speed"] = speed
    return {
        "agent": agent_block,
        "tts": tts,
        "conversation": {"max_duration_seconds": clamp_duration(max_duration_secs)},
    }


def initiation_message(overrides: dict) -> dict:
    return {
        "type": "conversation_initiation_client_data",
        "conversation_config_override": overrides,
        "source_info": {"source": "python_sdk", "version": "aplisay-pipecat"},
    }


# ---- what the worker says to the agent -----------------------------------


def greeting_text(agent: dict) -> str:
    greeting = ((agent or {}).get("options") or {}).get("greeting") or {}
    text = greeting.get("text") if isinstance(greeting.get("text"), str) else ""
    return (text or "").strip()


def greeting_instructions(agent: dict) -> str:
    greeting = ((agent or {}).get("options") or {}).get("greeting") or {}
    text = greeting.get("instructions") if isinstance(greeting.get("instructions"), str) else ""
    return (text or "").strip()


def opening_plan(agent: dict, platform_opening: Optional[str]) -> tuple[str, Optional[str]]:
    """How the agent speaks first: ``(first_message, opening_message)``.

    ``first_message`` is spoken verbatim by ElevenLabs the moment the
    conversation starts; ``opening_message`` is a user-side message the worker
    sends instead, telling the agent what to open with. A new call with
    ``greeting.text`` uses the first; everything else (instructions, no
    greeting, a handover or takeover opening) uses the second, because the
    protocol has no other way to make the agent speak first.
    """
    if platform_opening:
        return "", instruction_message(platform_opening)
    text = greeting_text(agent)
    if text:
        return text, None
    return "", instruction_message(greeting_opening_instruction(agent))


def instruction_message(instruction: str) -> str:
    """A platform instruction as the user-side message the agent acts on."""
    return f"(Instruction from the system, not the caller: {instruction.strip()})"


def inactivity_message(message: str) -> str:
    return instruction_message(f"The caller has gone quiet. Say exactly this to them now, then wait: {message.strip()}")


#: ElevenLabs's expressive models emit audio tags such as ``[warm]`` in the
#: agent text; they are direction, not speech.
_AUDIO_TAG = re.compile(r"\[[a-z][a-z ,'-]{0,40}\]\s*")


def strip_audio_tags(text: str) -> str:
    return _AUDIO_TAG.sub("", text or "").strip()


def max_duration_seconds(agent: dict) -> Optional[int]:
    """``options.maxDuration`` in seconds (a number, or ``"1800s"``), or None.
    The same reading as the call session's own stop timer."""
    value = ((agent or {}).get("options") or {}).get("maxDuration")
    if not value:
        return None
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v.endswith("s"):
            v = v[:-1]
        try:
            return int(float(v))
        except ValueError:
            return None
    return None
