"""Expose an agent's top-level ``mcpServers`` to the LLM as callable tools.

Ultravox's ``/calls`` API has no native MCP support, so the pipecat worker acts
as the MCP client: for each remote server configured on the agent
(``agent["mcpServers"]``) we open an MCP session, discover its tools, and return
them as descriptors in the SAME ``{"schema": ..., "execute": ...}`` shape that
:func:`pipecat_aplisay.agent_tools.build_agent_tools` produces for ``functions``.

Because the descriptors share that shape, the caller can simply ``extend`` them
onto the ``tools`` list it already passes to ``build_voice_session``. From there
they flow through the existing tool plumbing for free:

* :func:`voice_session._build_tools_schema` turns each schema into a
  ``FunctionSchema`` and (on Ultravox) hands it to ``one_shot_selected_tools`` so
  the model actually *sees* the tool, and
* :func:`voice_session._register_tools_on_llm` registers the ``execute`` callback
  so an invocation is proxied back to the MCP server.

The connection lifecycle is owned by the caller: :func:`connect_mcp_servers`
returns ``(descriptors, closers)`` and the caller must ``await`` every closer at
teardown. The connect/close dance mirrors Pipecat's own ``MCPClient.start()`` /
``MCPClient.close()`` (``pipecat/services/mcp_service.py``).
"""

from __future__ import annotations

import asyncio
import base64
import re
from datetime import timedelta
from typing import Any, Awaitable, Callable
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from loguru import logger as _logger

# How long the worker waits for an MCP server to complete its handshake
# and list its tools. Servers are connected serially during call setup,
# with the caller already answered and holding a concurrency slot, so
# this is a call-quality budget rather than a connectivity one — a
# server that needs longer is one the call is better off without.
MCP_CONNECT_TIMEOUT = 10.0

# Per-tool-call read deadline. The mcp client's own default is 300 s;
# nothing conversational survives a five-minute pause, and a hung tool
# call otherwise pins the bot mid-turn.
MCP_TOOL_TIMEOUT = 30.0


def _namespace_tool_name(server_name: str, tool_name: str) -> str:
    """Prefix an MCP tool with its server name and sanitise to the platform's
    tool-name charset (``[A-Za-z0-9_]``, max 64).

    Namespacing avoids collisions between two servers exposing a ``search``
    tool, and between MCP tools and the agent's own ``functions``. The original
    (un-namespaced) tool name is what we send back to the server at call time —
    the namespaced form is purely the LLM-facing identifier.
    """
    raw = f"{server_name}_{tool_name}" if server_name else tool_name
    cleaned = re.sub(r"[^A-Za-z0-9_]", "_", raw)
    return cleaned[:64] or "mcp_tool"


def _result_text(results: Any) -> str:
    """Concatenate the text content of an ``mcp`` ``CallToolResult``.

    Mirrors the extraction in ``MCPClient._call_tool`` — MCP tool results are a
    list of content blocks; we keep the text ones.
    """
    response = ""
    content = getattr(results, "content", None)
    if content:
        for block in content:
            text = getattr(block, "text", None)
            if text:
                response += text
    return response


def _error_summary(e: BaseException) -> str:
    """Flatten an exception (or nested ``ExceptionGroup``) to its leaf messages.

    The MCP transport clients run inside anyio task groups, so a connect
    failure usually surfaces as ``ExceptionGroup("unhandled errors in a
    TaskGroup", ...)`` — whose ``str()`` hides the actual cause (e.g. the
    HTTP 404 that means the url is missing its ``/mcp`` path).
    """
    if isinstance(e, BaseExceptionGroup):
        leaves = [_error_summary(sub) for sub in e.exceptions]
        return "; ".join(dict.fromkeys(leaves))
    text = str(e).strip()
    kind = type(e).__name__
    return f"{kind}: {text}" if text else kind


def _make_descriptor(
    *,
    server_name: str,
    session: Any,
    tool: Any,
    log: Any,
) -> dict:
    """Build a ``{"schema", "execute"}`` descriptor for one MCP tool."""
    input_schema = getattr(tool, "inputSchema", None) or {}
    schema = {
        "name": _namespace_tool_name(server_name, tool.name),
        "description": getattr(tool, "description", "") or "",
        "properties": input_schema.get("properties", {}) or {},
        "required": input_schema.get("required", []) or [],
    }

    original_name = tool.name

    async def execute(args: dict, _session=session, _name=original_name) -> Any:
        log.bind(server=server_name, tool=_name, arguments=args).debug(
            "proxying MCP tool call"
        )
        try:
            results = await _session.call_tool(
                _name,
                arguments=args or {},
                read_timeout_seconds=timedelta(seconds=MCP_TOOL_TIMEOUT),
            )
        except Exception as e:  # noqa: BLE001
            detail = _error_summary(e)
            log.bind(server=server_name, tool=_name, error=detail).warning(
                f"MCP tool call {_name} failed: {detail}"
            )
            raise RuntimeError(f"MCP tool {_name} failed: {detail}") from e
        is_error = getattr(results, "isError", False)
        text = _result_text(results)
        if is_error:
            raise RuntimeError(text or f"MCP tool {_name} returned an error")
        return text

    # ``kind: "mcp"`` is surfaced in the InvocationLog tool logs so MCP
    # entrypoint calls are distinguishable from the agent's own functions
    # (see voice_session._runner / tool_log.py).
    return {"schema": schema, "execute": execute, "kind": "mcp"}


def _resolve_key_auth(
    key_name: str,
    keys: list[dict],
    url: str,
    *,
    log: Any,
    server_name: str,
) -> tuple[dict[str, str], str]:
    """Resolve an agent ``keys`` entry referenced by an MCP server into auth.

    Mirrors the native model's ``getAuth`` mapping (``lib/models/ultravox.js``)
    so MCP servers authenticate the same way REST functions do, but with the
    secret living in the (API-redacted) ``keys`` array instead of inline
    ``headers``. Returns ``(headers, url)`` — ``query`` auth appends to the URL;
    every other type contributes a header.

    An unknown key name or unsupported ``in`` type is logged and yields no auth
    (``({}, url)``) rather than failing the connection.
    """
    key = next((k for k in (keys or []) if k.get("name") == key_name), None)
    if key is None:
        log.bind(server=server_name, key=key_name).warning(
            f"MCP server '{server_name}' references unknown API key '{key_name}'; sending no auth"
        )
        return {}, url

    where = (key.get("in") or "").lower()
    value = key.get("value")

    if where == "bearer":
        return {"Authorization": f"Bearer {value or ''}"}, url
    if where == "basic":
        token = value
        if not token and (key.get("username") or key.get("password")):
            raw = f"{key.get('username', '')}:{key.get('password', '')}".encode()
            token = base64.b64encode(raw).decode()
        return {"Authorization": f"Basic {token or ''}"}, url
    if where == "header":
        header_name = key.get("header") or key.get("name")
        if not header_name:
            log.bind(server=server_name, key=key_name).warning(
                f"MCP server '{server_name}' 'header' key '{key_name}' has no header name; sending no auth"
            )
            return {}, url
        return {header_name: value or ""}, url
    if where == "query":
        parts = urlsplit(url)
        query = parse_qsl(parts.query, keep_blank_values=True)
        query.append((key.get("name") or key_name, value or ""))
        return {}, urlunsplit(parts._replace(query=urlencode(query)))

    log.bind(server=server_name, key=key_name, **{"in": where}).warning(
        f"MCP server '{server_name}' API key '{key_name}' has 'in' type "
        f"'{where}' unsupported for MCP auth; sending no auth"
    )
    return {}, url


async def _connect_one(
    server: dict, keys: list[dict], log: Any
) -> tuple[list[dict], Callable[[], Awaitable[None]]] | None:
    """Open a session to one MCP server and return its descriptors + a closer.

    Returns ``None`` (and logs a warning) if the server is misconfigured or
    unreachable, so one bad server never takes the whole call down.

    The MCP transport clients (``streamablehttp_client`` / ``sse_client``) and
    ``ClientSession`` are anyio context managers that spawn a task group — its
    cancel scope **must** be entered and exited in the same task. Connect runs
    during ``prepare_run`` and the closer fires in ``run_prepared``'s finally,
    which can be different tasks; closing across tasks raises anyio's
    "exit cancel scope in a different task" error. So we hold the whole
    ``async with`` open inside one dedicated task for the connection's lifetime
    and signal it to unwind via ``close_event`` — open and close then happen in
    the same task. The live ``session`` is safe to call from other tasks (that's
    the normal MCP usage); only the scope enter/exit is task-bound.
    """
    name = server.get("name") or ""
    url = server.get("url")
    if not url:
        log.bind(server=name).warning(
            f"MCP server '{name or '<unnamed>'}' has no url; skipping"
        )
        return None
    transport = (server.get("transport") or "streamable_http").lower()

    # Auth: a referenced ``key`` (secret stays in the API-redacted ``keys``
    # array) is resolved into headers / a query param; any explicit ``headers``
    # on the server take precedence over a key-derived header.
    explicit_headers = dict(server.get("headers") or {})
    auth_headers: dict[str, str] = {}
    if server.get("key"):
        auth_headers, url = _resolve_key_auth(
            server["key"], keys, url, log=log, server_name=name
        )
    merged_headers = {**auth_headers, **explicit_headers}
    headers = merged_headers or None

    loop = asyncio.get_running_loop()
    ready: asyncio.Future = loop.create_future()
    close_event = asyncio.Event()

    async def _run() -> None:
        try:
            from mcp import ClientSession

            if transport == "sse":
                from mcp.client.sse import sse_client

                client_cm = sse_client(url, headers=headers)
            else:  # streamable_http (default)
                from mcp.client.streamable_http import streamablehttp_client

                client_cm = streamablehttp_client(url, headers=headers)

            async with client_cm as streams:
                read_stream, write_stream = streams[0], streams[1]
                async with ClientSession(read_stream, write_stream) as session:
                    await session.initialize()
                    listed = await session.list_tools()
                    descriptors = [
                        _make_descriptor(
                            server_name=name, session=session, tool=tool, log=log
                        )
                        for tool in listed.tools
                    ]
                    if not ready.done():
                        ready.set_result(descriptors)
                    # Hold the transport + session open in THIS task until the
                    # caller's closer signals teardown.
                    await close_event.wait()
        except Exception as e:  # noqa: BLE001
            if not ready.done():
                ready.set_exception(e)
            else:
                # Failed after a successful start (e.g. the server dropped the
                # stream mid-call). Nothing to fail back to the caller; just log.
                detail = _error_summary(e)
                log.bind(server=name, url=url, error=detail).debug(
                    f"MCP server '{name}' ({url}) connection ended with error: {detail}"
                )

    task = asyncio.create_task(_run(), name=f"mcp-{name or url}")
    try:
        # P2: a worker-side deadline. Without it the only limits are the
        # mcp client's own (30 s connect, 300 s read), and servers are
        # connected serially — so one configured server that accepts the
        # POST and then never answers stalls call setup for minutes with
        # the caller answered, silent, and holding a concurrency slot
        # (on the WebRTC path it hangs /webrtc/offer outright). A server
        # that cannot complete a handshake in MCP_CONNECT_TIMEOUT is not
        # going to be useful on this call.
        descriptors = await asyncio.wait_for(ready, timeout=MCP_CONNECT_TIMEOUT)
    except BaseException as e:
        # BaseException, not Exception: a CancelledError here (call torn
        # down mid-connect, or worker shutdown) otherwise left ``_run``
        # parked on ``close_event.wait()`` holding its httpx client and
        # MCP session open for the life of the process.
        close_event.set()
        await asyncio.gather(task, return_exceptions=True)
        if isinstance(e, asyncio.CancelledError):
            raise
        detail = (
            f"timed out after {MCP_CONNECT_TIMEOUT:g}s"
            if isinstance(e, asyncio.TimeoutError)
            else _error_summary(e)
        )
        log.bind(server=name, url=url, error=detail).warning(
            f"failed to connect MCP server '{name}' at {url}: {detail}; "
            "skipping — its tools will be unavailable for this call"
        )
        return None

    async def closer() -> None:
        close_event.set()
        await asyncio.gather(task, return_exceptions=True)

    tool_names = [d["schema"]["name"] for d in descriptors]
    log.bind(server=name, url=url, tools=tool_names).info(
        f"connected MCP server '{name}' at {url}: "
        f"{len(tool_names)} tools ({', '.join(tool_names) or 'none'})"
    )
    return descriptors, closer


async def connect_mcp_servers(
    agent: dict, *, log: Any = _logger
) -> tuple[list[dict], list[Callable[[], Awaitable[None]]]]:
    """Connect to every server in ``agent["mcpServers"]``.

    Returns ``(descriptors, closers)``:

    * ``descriptors`` — flat list of ``{"schema", "execute"}`` tool descriptors,
      ready to ``extend`` onto the session's ``tools`` list.
    * ``closers`` — async callables; the caller must ``await`` each at teardown
      to release the MCP connections.
    """
    servers = agent.get("mcpServers") or []
    keys = agent.get("keys") or []
    descriptors: list[dict] = []
    closers: list[Callable[[], Awaitable[None]]] = []
    for server in servers:
        result = await _connect_one(server, keys, log)
        if result is None:
            continue
        server_descriptors, closer = result
        descriptors.extend(server_descriptors)
        closers.append(closer)
    return descriptors, closers


async def close_mcp_servers(
    closers: list[Callable[[], Awaitable[None]]], *, log: Any = _logger
) -> None:
    """Await every closer, swallowing individual failures so teardown of one
    server never blocks the others."""
    for closer in closers or []:
        try:
            await closer()
        except Exception as e:  # noqa: BLE001
            log.bind(error=str(e)).debug("error closing MCP server connection")
