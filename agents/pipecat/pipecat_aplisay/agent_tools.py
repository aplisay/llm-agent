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

from typing import Any, Awaitable, Callable

from loguru import logger

from .function_handler import function_handler


def _filter_llm_visible_schema(properties: dict) -> dict:
    """LLM sees only ``source: 'generated'`` properties — section 5.2."""
    return {
        key: {k: v for k, v in value.items() if k != "required"}
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
) -> list[dict]:
    """Return a list of tool descriptors ready to register with Pipecat's LLM.

    Each entry is ``{schema: {name, description, properties, required}, execute}``
    and the voice-session layer adapts them to whatever LLMService is in use
    (Pipecat exposes ``FunctionSchema`` / ``register_function`` per service).
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
                    logger.info(
                        {"name": _fn_def.get("name"), "error": first["error"]},
                        "function execution returned error",
                    )
                return first.get("result")
            except Exception as e:  # noqa: BLE001
                logger.info({"error": str(e)}, "error executing function")
                raise RuntimeError(f"error executing function: {e}") from e

        descriptors.append({"schema": schema, "execute": execute})

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
