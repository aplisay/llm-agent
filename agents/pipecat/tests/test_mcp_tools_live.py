# Copyright (c) 2026, Aplisay
#
# SPDX-License-Identifier: BSD 2-Clause License

"""``mcp_tools`` against a real MCP server over the real transport.

Every other MCP test replaces the transport with a fake, so none of them can
see whether a request actually carries the agent's auth. That is the part of
the client most likely to break silently on an SDK change: mcp 2's
``streamable_http_client`` takes no ``headers``, so they now ride on an HTTP
client we build and own, and a mistake there loses the credential rather than
raising. Same for the model attributes it reads back — an ``input_schema`` that
resolves to nothing publishes the tool with no parameters, and an ``is_error``
that resolves to nothing reports every failure as a success.

So this drives the whole path once against a server on localhost and checks
what arrived at the far end.
"""

# No `from __future__ import annotations` here: the MCP server resolves a
# tool's type hints at registration, and a stringised `Context` annotation on a
# function nested in the fixture is not resolvable from its scope.
import asyncio
import contextlib
import socket
import threading

import pytest

from pipecat_aplisay import mcp_tools

pytest.importorskip("mcp.server.mcpserver")
pytest.importorskip("uvicorn")

AUTH = "Bearer s3cr3t"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@pytest.fixture
def probe_server():
    """A two-tool MCP server on localhost. Yields its ``/mcp`` url."""
    import uvicorn
    from mcp.server.mcpserver import Context, MCPServer

    mcp = MCPServer("probe")

    @mcp.tool()
    def whoami(ctx: Context, detail: str) -> str:
        """Report the headers the server saw, and the argument it was given."""
        headers = ctx.headers or {}
        return (
            f"auth={headers.get('authorization', '<none>')} "
            f"x-extra={headers.get('x-extra', '<none>')} "
            f"detail={detail}"
        )

    @mcp.tool()
    def explode() -> str:
        """Always fails."""
        raise ValueError("deliberate failure")

    port = _free_port()
    # stateless_http: one request per session is all this test needs, and it
    # keeps the server from holding state between the calls below.
    server = uvicorn.Server(
        uvicorn.Config(
            mcp.streamable_http_app(stateless_http=True),
            host="127.0.0.1",
            port=port,
            log_level="error",
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        deadline = threading.Event()
        for _ in range(200):
            if server.started:
                break
            deadline.wait(0.05)
        assert server.started, "the probe MCP server never came up"
        yield f"http://127.0.0.1:{port}/mcp"
    finally:
        server.should_exit = True
        thread.join(timeout=10)


def test_the_agents_auth_reaches_a_real_mcp_server(probe_server):
    agent = {
        "mcpServers": [
            {
                "name": "probe",
                "url": probe_server,
                "key": "probe-key",
                # An explicit header alongside the key: both have to arrive.
                "headers": {"X-Extra": "explicit"},
            }
        ],
        "keys": [
            {
                "name": "probe-key",
                "in": "header",
                "header": "Authorization",
                "value": AUTH,
            }
        ],
    }

    async def _run():
        descriptors, closers = await mcp_tools.connect_mcp_servers(agent)
        try:
            by_name = {d["schema"]["name"]: d for d in descriptors}
            said = await by_name["probe_whoami"]["execute"]({"detail": "hello"})
            with pytest.raises(RuntimeError) as failed:
                await by_name["probe_explode"]["execute"]({})
            return by_name, said, str(failed.value)
        finally:
            for closer in closers:
                with contextlib.suppress(Exception):
                    await closer()

    by_name, said, failure = asyncio.run(_run())

    assert sorted(by_name) == ["probe_explode", "probe_whoami"]

    schema = by_name["probe_whoami"]["schema"]
    assert list(schema["properties"]) == ["detail"]
    assert schema["required"] == ["detail"]

    assert f"auth={AUTH}" in said
    assert "x-extra=explicit" in said
    assert "detail=hello" in said

    # The message is the server's own, not our "returned an error" fallback, so
    # the error content survived the round trip rather than only the flag.
    assert "explode" in failure
    assert "returned an error" not in failure
