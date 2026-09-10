"""GPT-Live: the two-layer session composed from two platform agents.

docs/gpt-live.md is the user-facing description. OpenAI's GPT-Live
(``gpt-live-1``) is a full-duplex voice model that hands reasoning and tool use
to a backend text model while it keeps talking. The platform maps the two
layers onto two agents:

- the **voice agent**, on ``pipecat:openai/gpt-live-1``: its prompt is the voice
  persona;
- the **delegate**, a ``text`` agent named by one builtin function with
  ``platform: "delegate"``: its prompt, model, functions, MCP servers and keys
  are the backend. Absent, the backend is synthesised from the voice agent
  itself on :data:`SYNTHETIC_BACKEND_MODEL_NAME`.

This module is the SDK-free part: model id checks, delegate resolution, mode
selection, prompt composition, tool merging and the option mappings. The
Pipecat service subclass and the pipeline wiring are in
:mod:`pipecat_aplisay.gpt_live_service` and :mod:`pipecat_aplisay.voice_session`;
the call-time orchestration (fetching the delegate, building both tool sets)
is in :mod:`pipecat_aplisay.call_session`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from loguru import logger

from .function_handler import _get_by_path

#: The voice the Live API applies when none is sent. Must match
#: OPENAI_LIVE_DEFAULT_VOICE in lib/voices/openai-live.js.
GPT_LIVE_DEFAULT_VOICE = "marin"

#: The model a synthesised backend runs on (decision 4 of the plan): the
#: cheaper of OpenAI's recommended pair. ``vendorSpecific.openai.live`` can
#: override the model through ``delegation.responses.model``.
SYNTHETIC_BACKEND_MODEL_NAME = "text:openai/gpt-5.6-luna"

#: The builtin platform name that declares the backend.
DELEGATE_PLATFORM = "delegate"

#: The Live API accepts at most this many startup ``input`` messages.
MAX_HISTORY_MESSAGES = 128

#: Opening instruction when the agent configures no greeting: the platform
#: contract is that the agent speaks first.
OPENING_INSTRUCTION = "Greet the caller and ask how you can help."

#: Delegation policy appended to the voice agent's prompt. The voice model
#: has no tools of its own; everything that needs a lookup or an action goes
#: to the backend, and the caller should hear that something is happening.
VOICE_DELEGATION_POLICY = """## Delegation
You have no tools of your own. A backend assistant handles every lookup,
booking, record change, transfer, hangup and any question that needs a tool
or careful reasoning. Delegate as soon as the caller asks for one of those;
include what the caller wants and every detail they gave. While the backend
works, keep the conversation going and tell the caller you are checking.
Relay the backend's answer in your own words when it arrives, and ignore a
result the conversation has already moved past. Answer simple conversational
questions yourself."""

#: Tool policy appended to the backend's prompt. It names the call-control
#: tools merged in from the voice agent so the backend knows they exist.
BACKEND_TOOL_POLICY = """## Working for a live voice call
You are the backend of a live phone conversation. The voice assistant talking
to the caller sends you the conversation; the caller cannot hear you. The
transcript may contain recognition errors, so use the most likely intent.
Use your tools to answer and to act; never claim an action completed without
a tool result confirming it. Reply in concise plain text for the voice
assistant to speak: no Markdown, no lists, no raw JSON."""

#: Mode names.
MODE_RESPONSES = "responses"
MODE_CLIENT = "client"


def is_gpt_live_model_id(model_id: Optional[str]) -> bool:
    """True for the OpenAI GPT-Live rows (``openai/gpt-live*``). Must match
    isPipecatGptLiveModelId in lib/models/pipecat.js."""
    return (model_id or "").strip().lower().startswith("openai/gpt-live")


def _function_list(agent: dict) -> list[dict]:
    functions = (agent or {}).get("functions") or []
    if isinstance(functions, dict):
        return [f for f in functions.values() if isinstance(f, dict)]
    return [f for f in functions if isinstance(f, dict)]


def find_delegate_function(agent: dict) -> Optional[dict]:
    """The agent's builtin ``delegate`` function, or ``None``."""
    for fn in _function_list(agent):
        if fn.get("implementation") == "builtin" and fn.get("platform") == DELEGATE_PLATFORM:
            return fn
    return None


def resolve_delegate_target(fn_def: dict, metadata: dict) -> Optional[str]:
    """The agent id a ``delegate`` function names: a ``static`` value, or a
    ``metadata`` dot-path resolved against the call metadata. ``None`` when
    the parameter is missing, generated, or resolves to nothing."""
    param = ((fn_def.get("input_schema") or {}).get("properties") or {}).get("agent") or {}
    source = param.get("source")
    if source == "static":
        value = param.get("from")
    elif source == "metadata":
        value = _get_by_path(metadata or {}, str(param.get("from") or ""))
    else:
        return None
    value = str(value).strip() if value is not None else ""
    return value or None


def bare_model_id(model_name: str) -> str:
    """``text:openai/gpt-5.6-terra`` -> ``openai/gpt-5.6-terra``."""
    name = (model_name or "").strip()
    return name.split(":", 1)[1] if ":" in name else name


def delegation_mode(model_name: str) -> str:
    """Responses delegation for an OpenAI text model, client delegation for
    every other text model (decision 3 of the plan)."""
    return MODE_RESPONSES if bare_model_id(model_name).lower().startswith("openai/") else MODE_CLIENT


def synthetic_backend(agent: dict, model_name: str = SYNTHETIC_BACKEND_MODEL_NAME) -> dict:
    """The backend synthesised from the voice agent itself (decision 4): its
    prompt, functions, MCP servers and keys on the default backend model. The
    id is derived so logs can tell it from a declared delegate."""
    return {
        "id": f"synthetic:{(agent or {}).get('id') or 'agent'}",
        "name": (agent or {}).get("name"),
        "type": "text",
        "modelName": model_name,
        "prompt": (agent or {}).get("prompt") or "",
        "promptMetadata": (agent or {}).get("promptMetadata"),
        "functions": [],
        "mcpServers": [],
        "keys": [],
        "options": dict((agent or {}).get("options") or {}),
        "organisationId": (agent or {}).get("organisationId"),
    }


@dataclass
class DelegateSpec:
    """The resolved backend of one GPT-Live session."""

    agent: dict
    synthetic: bool
    mode: str

    @property
    def model_name(self) -> str:
        return self.agent.get("modelName") or SYNTHETIC_BACKEND_MODEL_NAME

    @property
    def backend_model_id(self) -> str:
        """``openai/gpt-5.6-terra``: the id usage rows carry as ``detail``."""
        return bare_model_id(self.model_name)

    @property
    def backend_vendor(self) -> Optional[str]:
        model_id = self.backend_model_id
        return model_id.split("/", 1)[0] if "/" in model_id else None

    @property
    def backend_model(self) -> str:
        """``gpt-5.6-terra``: the Responses API model name."""
        model_id = self.backend_model_id
        return model_id.split("/", 1)[1] if "/" in model_id else model_id

    @property
    def usage_backend(self) -> dict[str, Optional[str]]:
        """``{vendor, model}`` for :func:`pipecat_aplisay.usage.usage_vendors`."""
        return {"vendor": self.backend_vendor, "model": self.backend_model_id}


FetchAgent = Callable[[str, Optional[str]], Awaitable[dict]]


async def resolve_delegate(
    agent: dict,
    metadata: dict,
    organisation_id: Optional[str],
    *,
    fetch_agent: FetchAgent,
) -> DelegateSpec:
    """Resolve the session's backend (plan section 5.3, step 1 and 2).

    A declared delegate is fetched with ``fetch_agent(agent_id,
    organisation_id)`` (the internal agent-db API, keys included, same
    organisation guard as ``transfer_agent``). A missing, foreign, wrongly
    typed or unfetchable target falls back to the synthetic backend with a
    warning rather than failing the call (risk 13 of the plan).
    """
    fn_def = find_delegate_function(agent)
    if fn_def is None:
        return DelegateSpec(agent=synthetic_backend(agent), synthetic=True, mode=MODE_RESPONSES)

    target = resolve_delegate_target(fn_def, metadata)
    if not target:
        logger.bind(function=fn_def.get("name")).warning(
            "delegate function names no agent (missing or unresolved metadata target); "
            "using the synthetic backend"
        )
        return DelegateSpec(agent=synthetic_backend(agent), synthetic=True, mode=MODE_RESPONSES)

    try:
        delegate = await fetch_agent(target, organisation_id)
    except Exception as e:  # noqa: BLE001
        logger.bind(function=fn_def.get("name"), target=target, error=str(e)).warning(
            "could not load the delegate agent; using the synthetic backend"
        )
        return DelegateSpec(agent=synthetic_backend(agent), synthetic=True, mode=MODE_RESPONSES)

    if not isinstance(delegate, dict) or (delegate.get("type") or "interactive-audio") != "text":
        logger.bind(function=fn_def.get("name"), target=target).warning(
            "delegate agent is not a text agent; using the synthetic backend"
        )
        return DelegateSpec(agent=synthetic_backend(agent), synthetic=True, mode=MODE_RESPONSES)

    return DelegateSpec(agent=delegate, synthetic=False, mode=delegation_mode(delegate.get("modelName") or ""))


def language_line(agent: dict) -> Optional[str]:
    """The voice-layer sentence for ``options.tts.language`` (or
    ``options.stt.language``): GPT-Live has no session language field."""
    from .voice_session import _agent_language_tag

    tag = _agent_language_tag(agent)
    return f"Speak {tag} unless the caller asks you to switch language." if tag else None


def compose_voice_instructions(voice_prompt: str, *, language: Optional[str] = None) -> str:
    """The voice model's instructions: the persona prompt, the language line
    and the platform delegation policy (decision 5)."""
    parts = [(voice_prompt or "").strip() or "You are a helpful voice assistant."]
    if language:
        parts.append(language)
    parts.append(VOICE_DELEGATION_POLICY)
    return "\n\n".join(parts)


def compose_backend_instructions(backend_prompt: str, *, tool_names: list[str]) -> str:
    """The backend's instructions: its prompt plus the platform tool policy
    naming the merged tools."""
    parts = [(backend_prompt or "").strip() or "You are a helpful assistant.", BACKEND_TOOL_POLICY]
    if tool_names:
        parts.append("Tools available to you: " + ", ".join(sorted(tool_names)) + ".")
    return "\n\n".join(parts)


def merge_tools(voice_tools: list[dict], delegate_tools: list[dict], *, log: Any = logger) -> list[dict]:
    """The backend tool set: the union of the delegate's descriptors and the
    voice agent's (decision 6). On a name clash the delegate's wins and the
    clash is logged; each descriptor keeps its own ``execute`` (and so its
    own agent's keys)."""
    by_name: dict[str, dict] = {}
    for entry in delegate_tools or []:
        by_name[entry["schema"]["name"]] = entry
    clashes: list[str] = []
    for entry in voice_tools or []:
        name = entry["schema"]["name"]
        if name in by_name:
            clashes.append(name)
            continue
        by_name[name] = entry
    if clashes:
        log.bind(tools=clashes).warning(
            "delegate and voice agent both declare these tools; the delegate's definitions win: "
            + ", ".join(clashes)
        )
    return list(by_name.values())


def backend_settings(delegate_agent: dict) -> dict[str, Any]:
    """``options.effort`` -> reasoning effort, ``options.maxTokens`` -> output
    cap. ``temperature`` is ignored: the Live API rejects it for a delegated
    model."""
    options = (delegate_agent or {}).get("options") or {}
    out: dict[str, Any] = {}
    effort = options.get("effort")
    if isinstance(effort, str) and effort.strip():
        out["effort"] = effort.strip().lower()
    max_tokens = options.get("maxTokens")
    if isinstance(max_tokens, int) and not isinstance(max_tokens, bool) and max_tokens > 0:
        out["max_tokens"] = max_tokens
    return out


def live_overrides(agent: dict) -> dict:
    """``options.vendorSpecific.openai.live``: merged into ``session.start``
    after the portable mapping (decision 11). ``{}`` when unset."""
    vendor = ((agent or {}).get("options") or {}).get("vendorSpecific") or {}
    if not isinstance(vendor, dict):
        return {}
    openai = vendor.get("openai") or {}
    live = openai.get("live") if isinstance(openai, dict) else None
    return dict(live) if isinstance(live, dict) else {}


def deep_merge(base: dict, override: dict) -> dict:
    """Recursive dict merge, ``override`` winning on a shared leaf."""
    out = dict(base or {})
    for key, value in (override or {}).items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = deep_merge(out[key], value)
        else:
            out[key] = value
    return out


def history_from_messages(messages: list, *, limit: int = MAX_HISTORY_MESSAGES) -> list[dict]:
    """The startup history for a handover: the user and assistant text turns
    of a context, most recent ``limit`` kept (the Live API drops the oldest
    beyond 128 messages or 8,192 tokens)."""
    out: list[dict] = []
    for msg in messages or []:
        role = msg.get("role") if isinstance(msg, dict) else getattr(msg, "role", None)
        content = msg.get("content") if isinstance(msg, dict) else getattr(msg, "content", None)
        if role not in ("user", "assistant"):
            continue
        if isinstance(content, list):
            content = "".join(
                part.get("text", "") for part in content if isinstance(part, dict) and isinstance(part.get("text"), str)
            )
        if not isinstance(content, str) or not content.strip():
            continue
        out.append({"role": role, "content": content.strip()})
    return out[-limit:]


def dtmf_typed_input(digits: str) -> str:
    """What the backend is told when the caller presses keypad digits."""
    return f"The caller pressed these keypad digits: {digits}"


def dtmf_thinking(digits: str) -> str:
    """What the voice model is told when the caller presses keypad digits."""
    return f"The caller pressed the keypad digits {digits}. The backend has been told."


def greeting_opening_instruction(agent: dict) -> str:
    """The opening instruction for the greeting contract on GPT-Live: the
    greeting text (best-effort wording), the greeting instructions, or the
    platform default so the agent speaks first."""
    greeting = ((agent or {}).get("options") or {}).get("greeting") or {}
    text = greeting.get("text") if isinstance(greeting.get("text"), str) else ""
    instructions = greeting.get("instructions") if isinstance(greeting.get("instructions"), str) else ""
    text = (text or "").strip()
    instructions = (instructions or "").strip()
    # The wording the P0 spike measured as verbatim in four of four runs
    # (audible about 850 ms after the commentary append).
    if text:
        return f"Immediately say the following exactly and in full, then listen: {text}"
    if instructions:
        return (
            "Immediately open the conversation. For your opening line only, follow these "
            f"instructions, then listen: {instructions}"
        )
    return OPENING_INSTRUCTION


def inactivity_commentary(message: str) -> str:
    """The inactivity prompt as spoken context (paraphrased by the model)."""
    return f"The caller has gone quiet. Say this to them now, then wait: {message}"


@dataclass
class GptLiveSession:
    """Everything the session factory needs to build a GPT-Live pipeline,
    resolved by the call session before the pipeline is built."""

    delegate: DelegateSpec
    voice_instructions: str
    backend_instructions: str
    tools: list[dict] = field(default_factory=list)
    settings: dict[str, Any] = field(default_factory=dict)
    overrides: dict[str, Any] = field(default_factory=dict)
    #: Client-mode backend: renders the request and returns the text to speak.
    client_delegate: Optional[Callable[[list[dict], bool], Awaitable[str]]] = None
    #: Called with the provider's close reason when the session ends on its side.
    on_session_ended: Optional[Callable[[str], Awaitable[None]]] = None
    #: Called with the digit string when the caller presses keypad digits.
    on_dtmf: Optional[Callable[[str], Awaitable[None]]] = None
    #: A greeting is configured: the caller stays inaudible until it completes.
    deaf_during_greeting: bool = False


def has_greeting(agent: dict) -> bool:
    """``options.greeting.text`` or ``options.greeting.instructions`` is set."""
    greeting = ((agent or {}).get("options") or {}).get("greeting") or {}
    text = greeting.get("text") if isinstance(greeting.get("text"), str) else ""
    instructions = greeting.get("instructions") if isinstance(greeting.get("instructions"), str) else ""
    return bool((text or "").strip()) or bool((instructions or "").strip())
