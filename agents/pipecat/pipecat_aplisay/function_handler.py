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

from .current_datetime import current_datetime_string, is_datetime_metadata_key


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


class RestCallError(RuntimeError):
    """A ``rest`` function's HTTP response was >= 400.

    Carries the response body so the dispatcher can hand it to the model as the
    tool result (JS-handler parity: ``lib/function-handler.js`` returns
    ``e.response.data`` as ``result`` alongside ``error``) — a bare error string
    with a ``None`` result leaves the model unable to read the server's message.
    """

    def __init__(self, message: str, body: Any):
        super().__init__(message)
        self.body = body


def _resolve_rest_auth(
    fn_def: dict, keys: list[dict]
) -> tuple[dict[str, str], list[tuple[str, str]]]:
    """Resolve a rest function's ``key`` reference into auth material.

    Returns ``(headers, query_pairs)``. Mirrors the canonical JS handler
    (``lib/function-handler.js``: ``basic`` / ``bearer`` / ``header``) plus the
    ``query`` type ``mcp_tools._resolve_key_auth`` already supports. An unknown
    key name or ``in`` type logs a warning and yields no auth — the request goes
    out keyless and the server's 401 comes back as the tool result, matching the
    JS handler's behaviour.
    """
    name = fn_def.get("key")
    if not name:
        return {}, []
    key = next((k for k in (keys or []) if k.get("name") == name), None)
    if key is None:
        logger.bind(function=fn_def.get("name"), key=name).warning(
            f"rest function '{fn_def.get('name')}' references unknown API key '{name}'; sending no auth"
        )
        return {}, []
    where = (key.get("in") or "").lower()
    value = key.get("value")
    if where == "basic":
        return {"Authorization": f"Basic {value}"}, []
    if where == "bearer":
        return {"Authorization": f"Bearer {value}"}, []
    if where == "header":
        header_name = key.get("header") or key.get("name")
        return {str(header_name): str(value)}, []
    if where == "query":
        return {}, [(key.get("name") or name, str(value or ""))]
    logger.bind(function=fn_def.get("name"), key=name, **{"in": where}).warning(
        f"rest function '{fn_def.get('name')}' API key '{name}' has unsupported 'in' type; sending no auth"
    )
    return {}, []


def _builtin_metadata(args: dict, metadata: dict, options: dict) -> dict:
    keys = args.get("keys")
    if isinstance(keys, str):
        keys = [k.strip() for k in keys.split(",")]
    if not isinstance(keys, list):
        keys = [keys]

    out: dict[str, Any] = {}
    allow_tools_calls = bool(options.get("allowToolsCallsMetadataPaths"))
    for key in keys:
        if not allow_tools_calls and (isinstance(key, str) and (key == "toolsCalls" or key.startswith("toolsCalls."))):
            raise PermissionError("Access to metadata.toolsCalls is not allowed for this handler")
        value = _get_by_path(metadata, key)
        # `aplisay.dateTime` is the live current date/time, computed here rather
        # than seeded — models have no clock, so this is their ground truth for
        # date reasoning (see current_datetime.py). A real seeded value wins.
        if value is None and is_datetime_metadata_key(key):
            out[key] = current_datetime_string()
            continue
        out[key] = "unknown" if value is None else value
    logger.bind(keys=keys, result=out).debug("metadata builtin result")
    return out


HARDWIRED_BUILTINS["metadata"] = _builtin_metadata


def _resolve_inputs(
    fn: dict, llm_args: dict, metadata: dict, options: dict
) -> dict:
    """Resolve a function's parameters by source. Mirrors the JS dispatcher.

    A parameter that resolves to ``None`` is OMITTED, never sent as ``null``:
    in the JS handler an absent argument resolves to ``undefined``, which
    ``JSON.stringify`` drops from the request body — but Python's ``None``
    survives serialisation as a REAL ``null`` the server must interpret. Beta
    2026-07-27: every no-preference booking_get_slots went out as
    ``{"from": null, "days": null}``; the server's ``Number(null) === 0``
    coerced that to a one-day scan, so afternoon callers were told no slots
    existed anywhere. (For metadata sources the JS handler throws when the
    path is missing; omitting is deliberately softer — absent optional
    metadata degrades to \"parameter not sent\" instead of failing the call.)
    """
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
            if value is not None:
                resolved[key] = value
        else:  # generated (default)
            value = llm_args.get(key, entry.get("default"))
            if value is not None:
                resolved[key] = value

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
    keys: list[dict],
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
                # Callout telemetry before the request (JS-handler parity) so
                # the call's Data feed shows WHERE the tool went and with what
                # auth shape — the 2026-07-25 beta 401s were invisible without it.
                try:
                    await message_handler(
                        {
                            "rest_callout": {
                                "url": fn_def.get("url"),
                                "method": (fn_def.get("method") or "POST").upper(),
                                "key": fn_def.get("key") or None,
                            }
                        }
                    )
                except Exception as e:  # noqa: BLE001
                    logger.warning(f"rest_callout telemetry emit failed: {e}")
                result = await _execute_rest(fn_def, inputs, keys)
            else:
                raise RuntimeError(f"unknown implementation {impl}")
        except RestCallError as e:
            # Surface the server's response body to the model as the tool
            # result — a 401/422 body usually says exactly what to fix.
            error = str(e)
            result = e.body
            logger.bind(name=name, error=error).warning("function execution failed")
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


async def _execute_rest(fn_def: dict, inputs: dict, keys: list[dict]) -> Any:
    """REST implementation. Supports template substitution into URL/headers/body.

    Auth: a ``key`` name on the function is resolved against the agent's
    ``keys`` into an Authorization (or custom) header — the same contract the
    canonical JS handler implements. This was MISSING from the port until
    2026-07-25: every keyed rest function (booking_get_slots / booking_book /
    notify_email_team) went out with no credentials and 401'd at the tool
    plane regardless of the key being armed on the agent.
    """
    method = (fn_def.get("method") or "POST").upper()
    raw_url = fn_def.get("url") or ""
    url, leftover = _replace_parameters(raw_url, inputs)

    auth_headers, auth_params = _resolve_rest_auth(fn_def, keys)

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
    # Key-derived auth wins for its own header name; explicit template headers
    # for OTHER names survive (the JS handler sends only the auth header, so
    # there is no conflicting precedent to preserve).
    headers.update(auth_headers)

    body: Any = None
    params: Optional[list[tuple[str, str]]] = None
    if method in ("POST", "PUT", "PATCH"):
        body = leftover or None
        if auth_params:
            params = list(auth_params)
    else:
        # Unconsumed inputs become the query string on read-style methods —
        # the JS handler's URLSearchParams(left) branch.
        params = [(k, str(v)) for k, v in (leftover or {}).items() if v is not None]
        params.extend(auth_params)

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.request(method, url, headers=headers, params=params or None, json=body)
    is_json = resp.headers.get("content-type", "").startswith("application/json")
    if resp.status_code >= 400:
        parsed = _try_parse_json(resp.text) if is_json else None
        raise RestCallError(
            f"REST function {fn_def.get('name')} failed: {resp.status_code}",
            parsed if parsed is not None else resp.text,
        )
    if is_json:
        return resp.json()
    return resp.text
