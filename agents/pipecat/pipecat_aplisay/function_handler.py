"""Function-handler library — section 5.3 of docs/livekit-agent-architecture.md.

This is the Python port of ``lib/function-handler.js``. Behaviour must match:

- ``source`` enum (``generated`` / ``static`` / ``metadata``); LLM sees only
  ``generated`` properties on the wire.
- ``transfer.number`` source restriction enforced at the dispatcher.
- Sequential execution within a tool-call batch.
- Result writeback to ``metadata.toolsCalls[toolName]`` for chaining.
- ``redact: True`` swaps the LLM-visible result for ``"OK"`` while keeping the
  real result available to later tools via ``metadata.toolsCalls``.

Hardwired built-ins live here. Handler-specific built-ins (``hangup``,
``transfer``, ``transfer_status``) are passed in by the caller — see
``agent_tools.py``.
"""

from __future__ import annotations

import json
import re
from typing import Any, Awaitable, Callable, Optional

import httpx
from loguru import logger


def _get_by_path(obj: Any, path: str) -> Any:
    if not path:
        return obj
    cur = obj
    for part in path.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
        if cur is None:
            return None
    return cur


def _try_parse_json(value: Any) -> Any:
    if not isinstance(value, str):
        return None
    try:
        return json.loads(value)
    except Exception:  # noqa: BLE001
        return None


def _replace_parameters(template: str, inputs: dict) -> tuple[str, dict]:
    """Replace ``{key}`` placeholders in `template` with values from `inputs`.

    Returns the substituted string plus a dict of inputs that weren't consumed —
    those become the request body / query params for `rest` implementations.
    """
    result = template
    leftover: dict[str, Any] = {}
    for key, value in inputs.items():
        token = "{" + key + "}"
        if token in result:
            result = result.replace(token, str(value))
        else:
            leftover[key] = value
    return result, leftover


HARDWIRED_BUILTINS: dict[str, Callable[..., Any]] = {}


def _builtin_metadata(args: dict, metadata: dict, options: dict) -> dict:
    keys = args.get("keys")
    if isinstance(keys, str):
        keys = [k.strip() for k in keys.split(",")]
    if not isinstance(keys, list):
        keys = [keys]

    out: dict[str, Any] = {}
    allow_tools_calls = bool(options.get("allowToolsCallsMetadataPaths"))
    for key in keys:
        if not allow_tools_calls and (key == "toolsCalls" or key.startswith("toolsCalls.")):
            raise PermissionError("Access to metadata.toolsCalls is not allowed for this handler")
        value = _get_by_path(metadata, key)
        out[key] = "unknown" if value is None else value
    logger.bind(keys=keys, result=out).debug("metadata builtin result")
    return out


HARDWIRED_BUILTINS["metadata"] = _builtin_metadata


def _resolve_inputs(
    fn: dict, llm_args: dict, metadata: dict, options: dict
) -> dict:
    """Resolve a function's parameters by source. Mirrors the JS dispatcher."""
    properties = (fn.get("input_schema") or {}).get("properties") or {}
    resolved: dict[str, Any] = {}
    allow_tools_calls = bool(options.get("allowToolsCallsMetadataPaths"))

    for key, entry in properties.items():
        source = entry.get("source")
        if source == "static":
            resolved[key] = entry.get("from")
        elif source == "metadata":
            from_path = entry.get("from") or ""
            if not allow_tools_calls and (from_path == "toolsCalls" or from_path.startswith("toolsCalls.")):
                raise PermissionError(
                    "Access to metadata.toolsCalls is not allowed for this handler"
                )
            value = _get_by_path(metadata, from_path)
            if value is None and "default" in entry:
                value = entry["default"]
            resolved[key] = value
        else:  # generated (default)
            resolved[key] = llm_args.get(key, entry.get("default"))

    # transfer.number security boundary — section 5.2.
    if fn.get("name") == "transfer" or fn.get("platform") == "transfer":
        number_entry = properties.get("number") or {}
        if number_entry.get("source") not in ("static", "metadata"):
            raise PermissionError(
                "transfer.number must be 'static' or 'metadata' (never 'generated')"
            )

    # transfer_agent / subagent targets follow the same anti-abuse rule as
    # transfer.number: the target agent may never be LLM-generated.
    if fn.get("platform") in ("transfer_agent", "subagent"):
        agent_entry = properties.get("agent") or {}
        if agent_entry.get("source") not in ("static", "metadata"):
            raise PermissionError(
                f"{fn.get('platform')}.agent must be 'static' or 'metadata' (never 'generated')"
            )

    return resolved


def _write_result_to_metadata(
    metadata: dict, tool_name: str, parameter: dict, result: Any, error: Optional[str]
) -> None:
    metadata.setdefault("toolsCalls", {}).setdefault(tool_name, {})
    bucket = metadata["toolsCalls"][tool_name]
    bucket["parameter"] = parameter
    if error:
        bucket["error"] = error
    parsed = _try_parse_json(result)
    bucket["result"] = parsed if parsed is not None else result


async def function_handler(
    function_calls: list[dict],
    functions: list[dict],
    keys: list[str],
    message_handler: Callable[[dict], Awaitable[None]],
    metadata: dict,
    specific_builtins: dict[str, Callable[..., Any]],
    options: Optional[dict] = None,
) -> dict:
    """Execute a batch of tool calls sequentially. Returns ``function_results``.

    Telemetry emissions match the canonical JS handler in
    ``lib/function-handler.js`` and the ``transaction_logs.type`` Postgres
    enum (``function_calls`` / ``function_results`` — both plural):

    - Just before each call executes: ``{function_calls: [{name, arguments}]}``
    - After the whole batch completes: ``{function_results: [{name, input, result}]}``

    Singular ``function_call`` was the previous emission and is not in the
    enum — the server rejects it with a 500.
    """
    options = options or {}
    builtins = {**HARDWIRED_BUILTINS, **specific_builtins}
    function_results: list[dict] = []
    # Mirror inputs per call so the batched function_results emission below
    # carries the same {name, input, result} shape as the JS handler.
    inputs_by_name: dict[str, dict] = {}

    for fn_call in function_calls:
        name = fn_call["name"]
        fn_def = next((f for f in functions if f.get("name") == name), None)
        if not fn_def:
            function_results.append({"name": name, "result": None, "error": f"unknown function {name}"})
            continue

        try:
            inputs = _resolve_inputs(fn_def, fn_call.get("input") or {}, metadata, options)
        except Exception as e:  # noqa: BLE001
            function_results.append({"name": name, "result": None, "error": str(e)})
            _write_result_to_metadata(metadata, name, {}, None, str(e))
            continue
        inputs_by_name[name] = inputs

        # Pre-execution telemetry. One-element array per call mirrors the JS
        # handler's behaviour (it emits a `function_calls: [{...}]` message
        # right before each invocation).
        try:
            await message_handler(
                {"function_calls": [{"name": name, "arguments": inputs}]}
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"function_calls telemetry emit failed: {e}")

        impl = fn_def.get("implementation", "rest")
        result: Any = None
        error: Optional[str] = None

        try:
            if impl == "stub":
                result = {"ok": True, "stub": True}
            elif impl == "builtin":
                platform = fn_def.get("platform") or name
                fn = builtins.get(platform)
                if not fn:
                    raise RuntimeError(f"no builtin implementation for {platform}")
                result = await _maybe_await(fn(inputs, metadata, options))
            elif impl == "rest":
                result = await _execute_rest(fn_def, inputs, keys)
            else:
                raise RuntimeError(f"unknown implementation {impl}")
        except Exception as e:  # noqa: BLE001
            error = str(e)
            logger.bind(name=name, error=error).warning("function execution failed")

        # Write to metadata BEFORE redaction so chaining sees the real value.
        _write_result_to_metadata(metadata, name, inputs, result, error)

        # Redact LLM-visible result if requested.
        visible_result = result
        if options.get("allowRedactedFunctionResults") and fn_def.get("redact"):
            visible_result = "OK"

        function_results.append(
            {"name": name, "result": visible_result, "error": error}
        )

    # Batched post-execution telemetry — one row per turn, regardless of how
    # many tool calls were in the batch.
    try:
        await message_handler(
            {
                "function_results": [
                    {
                        "name": fr["name"],
                        "input": inputs_by_name.get(fr["name"]),
                        "result": fr.get("result"),
                        # Include error only when present so successful rows
                        # match the JS handler's shape exactly.
                        **({"error": fr["error"]} if fr.get("error") else {}),
                    }
                    for fr in function_results
                ]
            }
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(f"function_results telemetry emit failed: {e}")

    return {"function_results": function_results}


async def _maybe_await(value: Any) -> Any:
    if hasattr(value, "__await__"):
        return await value
    return value


async def _execute_rest(fn_def: dict, inputs: dict, keys: list[str]) -> Any:
    """REST implementation. Supports template substitution into URL/headers/body."""
    method = (fn_def.get("method") or "POST").upper()
    raw_url = fn_def.get("url") or ""
    url, leftover = _replace_parameters(raw_url, inputs)

    headers_template = fn_def.get("headers") or {}
    headers: dict[str, str] = {}
    for key, value in headers_template.items():
        if isinstance(value, dict) and value.get("source"):
            # Header sources are resolved separately — reuse _resolve_inputs's
            # primitives by inlining the few cases we support here.
            if value["source"] == "static":
                headers[key] = str(value.get("from", ""))
            else:
                # `metadata` and `generated` for headers are uncommon; defer.
                headers[key] = ""
        else:
            substituted, _ = _replace_parameters(str(value), inputs)
            headers[key] = substituted

    body: Any = None
    if method in ("POST", "PUT", "PATCH"):
        body = leftover or None

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.request(method, url, headers=headers, json=body)
    if resp.status_code >= 400:
        raise RuntimeError(f"REST function {fn_def.get('name')} failed: {resp.status_code} {resp.text}")
    if resp.headers.get("content-type", "").startswith("application/json"):
        return resp.json()
    return resp.text
