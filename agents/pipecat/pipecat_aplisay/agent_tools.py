"""Built-in tool surface — section 5.1 of docs/livekit-agent-architecture.md.

Each Pipecat agent registers four built-in tools:

- ``metadata(keys)`` — provided by the hardwired layer in
  :mod:`pipecat_aplisay.function_handler`.
- ``hangup()`` — agent-initiated termination.
- ``transfer(...)`` — blind / consultative transfer; semantics in section 6.10.
- ``transfer_status()`` — query the in-progress transfer state machine.

The actual Pipecat-side LLM-tool registration (FunctionSchema + register_function)
happens in :mod:`pipecat_aplisay.voice_session`; this module wraps the agent's
declared functions in the source-resolution layer and routes platform built-ins
to the runtime.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable, Optional

from loguru import logger

from .function_handler import function_handler


# Property-level keys that are valid JSON Schema and that LLM providers
# accept on a function-parameter spec. Anything else on an Aplisay function
# definition is platform metadata (``in``, ``source``, ``from``, ``required``,
# ``redact``, custom routing hints) — useful server-side, but providers like
# Google reject them with a strict pydantic schema validation.
_LLM_VISIBLE_SCHEMA_KEYS = frozenset(
    {
        "type",
        "description",
        "enum",
        "format",
        "items",
        "properties",
        "required",  # only valid on object schemas; we drop it at the
                    # property level below because Aplisay uses
                    # `required: true` on individual params (which would
                    # be a boolean, not a list) — JSONSchema's `required`
                    # at the property level only makes sense for nested
                    # objects.
        "additionalProperties",
        "nullable",
        "default",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "pattern",
    }
)


def _strip_property(value: dict) -> dict:
    """Return a copy of an Aplisay-formatted parameter spec with only
    JSON-Schema-valid keys retained.

    Drops ``in``, ``source``, ``from``, ``redact``, and the boolean-style
    ``required`` flag (which Aplisay uses at the property level to indicate
    "this param must be supplied" — represented in real JSONSchema as
    membership of the parent object's ``required: [...]`` array).
    """
    if not isinstance(value, dict):
        return value
    out: dict = {}
    for k, v in value.items():
        if k not in _LLM_VISIBLE_SCHEMA_KEYS:
            continue
        # Drop the property-level boolean ``required`` — see note above.
        if k == "required" and isinstance(v, bool):
            continue
        out[k] = v
    return out


def _filter_llm_visible_schema(properties: dict) -> dict:
    """LLM sees only ``source: 'generated'`` properties — section 5.2.

    Each surviving property is then stripped of Aplisay-platform keys so
    strict providers (Google's pydantic-validated ``GenerateContentConfig``)
    don't reject the function declaration.
    """
    return {
        key: _strip_property(value)
        for key, value in properties.items()
        if (value or {}).get("source", "generated") == "generated"
    }


def build_agent_tools(
    *,
    agent: dict,
    metadata: dict,
    send_message: Callable[[dict], Awaitable[None]],
    on_hangup: Callable[[], Awaitable[None]],
    on_transfer: Callable[[dict], Awaitable[Any]],
    get_transfer_state: Callable[[], dict],
    on_agent_transfer: Optional[Callable[[dict], Awaitable[Any]]] = None,
    on_subagent: Optional[Callable[[dict, dict], Awaitable[Any]]] = None,
    on_send_dtmf: Optional[Callable[[dict], Awaitable[Any]]] = None,
    extra_builtins: Optional[dict[str, Callable[[dict, dict, dict], Awaitable[Any]]]] = None,
) -> list[dict]:
    """Return a list of tool descriptors ready to register with Pipecat's LLM.

    Each entry is ``{schema: {name, description, properties, required}, execute}``
    and the voice-session layer adapts them to whatever LLMService is in use
    (Pipecat exposes ``FunctionSchema`` / ``register_function`` per service).
    A descriptor may also carry ``suppress_result_run: True`` — set on
    ``transfer_agent`` builtins so the in-flight (pre-handover) agent does not
    generate a reply from the tool result; the handover machinery triggers the
    new agent's first turn instead.

    ``on_agent_transfer`` handles the builtin ``transfer_agent`` platform
    function (in-call handover to another agent definition); ``on_subagent``
    handles the builtin ``subagent`` platform function (invoke a headless
    ``text`` agent and return its result). Both are optional — when absent the
    corresponding builtin is unavailable (the server-side agent validation
    gates which handlers may carry these functions).

    ``extra_builtins`` is an optional map of additional platform-built-in
    function names to their handler coroutines. Used by the consultative-
    transfer flow to wire ``accept_transfer`` / ``reject_transfer`` onto
    the TransferAgent's bot session — see
    ``CallSession._build_consult_transfer_agent_tools``.
    """
    functions = agent.get("functions") or []
    keys = agent.get("keys") or []

    runtime_options = {
        "allowToolsCallsMetadataPaths": True,
        "allowRedactedFunctionResults": True,
    }

    builtins = {
        "hangup": _builtin_factory_hangup(on_hangup),
        "transfer": _builtin_factory_transfer(on_transfer),
        "transfer_status": _builtin_factory_transfer_status(get_transfer_state),
    }
    if on_agent_transfer is not None:
        builtins["transfer_agent"] = _builtin_factory_agent_transfer(on_agent_transfer)
    if on_subagent is not None:
        builtins["subagent"] = _builtin_factory_subagent(on_subagent)
    if on_send_dtmf is not None:
        builtins["send_dtmf"] = _builtin_factory_send_dtmf(on_send_dtmf)
    if extra_builtins:
        builtins.update(extra_builtins)

    descriptors: list[dict] = []
    for fn_def in functions:
        properties = (fn_def.get("input_schema") or {}).get("properties") or {}
        visible = _filter_llm_visible_schema(properties)
        required = [k for k, v in properties.items() if v.get("required")]
        schema = {
            "name": fn_def["name"],
            "description": fn_def.get("description", ""),
            "properties": visible,
            "required": required,
        }

        async def execute(args: dict, _fn_def=fn_def) -> Any:
            try:
                result = await function_handler(
                    [{**_fn_def, "input": args}],
                    functions,
                    keys,
                    send_message,
                    metadata,
                    builtins,
                    runtime_options,
                )
                first = result["function_results"][0]
                if first.get("error"):
                    logger.bind(name=_fn_def.get("name"), error=first["error"]).info(
                        "function execution returned error"
                    )
                return first.get("result")
            except Exception as e:  # noqa: BLE001
                logger.bind(error=str(e)).info("error executing function")
                raise RuntimeError(f"error executing function: {e}") from e

        descriptor: dict = {
            "schema": schema,
            "execute": execute,
            # Coarse classification surfaced in the InvocationLog tool logs
            # (see voice_session._runner / tool_log.py). MCP tools set their
            # own "mcp" kind in mcp_tools._make_descriptor. The `subagent`
            # builtin (delegation to a headless text agent) is split out from
            # the generic `builtin` so agent-to-agent calls read distinctly.
            "kind": "subagent"
            if fn_def.get("platform") == "subagent"
            else "builtin"
            if fn_def.get("implementation") == "builtin"
            else "function",
        }
        if (
            fn_def.get("implementation") == "builtin"
            and fn_def.get("platform") == "transfer_agent"
        ):
            # Don't let the outgoing agent respond to the handover result —
            # the swap machinery (CallSession._apply_agent_transfer) runs the
            # incoming agent's first turn once prompt/tools are replaced.
            descriptor["suppress_result_run"] = True
        if fn_def.get("implementation") == "builtin":
            # Platform builtins have side effects (transfers, handovers,
            # hangup, subagent invocations) that must not be killed by
            # Pipecat's cancel-on-interruption: an LLM often emits the tool
            # call while the caller's trailing speech is still end-pointing,
            # and the resulting interruption cancelled the call milliseconds
            # in — leaving e.g. a transfer_agent handover announced by the
            # model but never performed. The runner shields these executions
            # so they run to completion even if the LLM-side call is
            # cancelled (see voice_session._register_tools_on_llm).
            descriptor["protect_from_interruption"] = True
        descriptors.append(descriptor)

    return descriptors


def _builtin_factory_hangup(on_hangup: Callable[[], Awaitable[None]]):
    async def _impl(_args: dict, _metadata: dict, _options: dict) -> dict:
        await on_hangup()
        return {"ok": True}

    return _impl


def _builtin_factory_transfer(on_transfer: Callable[[dict], Awaitable[Any]]):
    async def _impl(args: dict, _metadata: dict, _options: dict) -> Any:
        return await on_transfer(args)

    return _impl


def _builtin_factory_transfer_status(get_state: Callable[[], dict]):
    async def _impl(_args: dict, _metadata: dict, _options: dict) -> dict:
        state = get_state()
        return {"state": state.get("state"), "description": state.get("description")}

    return _impl


def _builtin_factory_agent_transfer(on_agent_transfer: Callable[[dict], Awaitable[Any]]):
    async def _impl(args: dict, _metadata: dict, _options: dict) -> Any:
        return await on_agent_transfer(args)

    return _impl


def _builtin_factory_subagent(on_subagent: Callable[[dict, dict], Awaitable[Any]]):
    async def _impl(args: dict, metadata: dict, _options: dict) -> Any:
        return await on_subagent(args, metadata)

    return _impl


def _builtin_factory_send_dtmf(on_send_dtmf: Callable[[dict], Awaitable[Any]]):
    async def _impl(args: dict, _metadata: dict, _options: dict) -> Any:
        return await on_send_dtmf(args)

    return _impl
