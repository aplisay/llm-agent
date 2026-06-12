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
import re
from typing import Any, Awaitable, Callable

from loguru import logger as _logger


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
            results = await _session.call_tool(_name, arguments=args or {})
        except Exception as e:  # noqa: BLE001
            log.bind(server=server_name, tool=_name, error=str(e)).warning(
                "MCP tool call failed"
            )
            raise RuntimeError(f"MCP tool {_name} failed: {e}") from e
        is_error = getattr(results, "isError", False)
        text = _result_text(results)
        if is_error:
            raise RuntimeError(text or f"MCP tool {_name} returned an error")
        return text

    return {"schema": schema, "execute": execute}


async def _connect_one(
    server: dict, log: Any
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
        log.bind(server=name).warning("MCP server has no url; skipping")
        return None
    transport = (server.get("transport") or "streamable_http").lower()
    headers = server.get("headers") or None

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
                log.bind(server=name, url=url, error=str(e)).debug(
                    "MCP server connection ended with error"
                )

    task = asyncio.create_task(_run(), name=f"mcp-{name or url}")
    try:
        descriptors = await ready
    except Exception as e:  # noqa: BLE001
        close_event.set()
        await asyncio.gather(task, return_exceptions=True)
        log.bind(server=name, url=url, error=str(e)).warning(
            "failed to connect MCP server; skipping"
        )
        return None

    async def closer() -> None:
        close_event.set()
        await asyncio.gather(task, return_exceptions=True)

    log.bind(server=name, url=url, tools=[d["schema"]["name"] for d in descriptors]).info(
        "connected MCP server"
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
    descriptors: list[dict] = []
    closers: list[Callable[[], Awaitable[None]]] = []
    for server in servers:
        result = await _connect_one(server, log)
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
