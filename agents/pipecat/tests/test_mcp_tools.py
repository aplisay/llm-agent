"""Unit tests for the worker-as-MCP-client tool adapter (``mcp_tools.py``).

These exercise the pure adapter logic — name namespacing, result-text
extraction, descriptor shape, and the ``execute`` proxy — against a fake MCP
``ClientSession``, so no network or real MCP server is needed. The
network-bearing ``connect_mcp_servers`` is covered only for its
misconfiguration / empty-list short-circuits.
"""

from __future__ import annotations

import asyncio

import pytest

from pipecat_aplisay import mcp_tools


class _Content:
    def __init__(self, text=None):
        if text is not None:
            self.text = text


class _ToolResult:
    def __init__(self, content, is_error=False):
        self.content = content
        self.isError = is_error


class _Tool:
    def __init__(self, name, description, input_schema):
        self.name = name
        self.description = description
        self.inputSchema = input_schema


class _FakeSession:
    """Records the last call_tool invocation and returns a canned result."""

    def __init__(self, result=None, raises=None):
        self._result = result
        self._raises = raises
        self.calls = []

    async def call_tool(self, name, arguments=None):
        self.calls.append((name, arguments))
        if self._raises:
            raise self._raises
        return self._result


def test_namespace_tool_name_sanitises_and_truncates():
    assert mcp_tools._namespace_tool_name("weather", "get") == "weather_get"
    # dots / dashes / spaces collapse to underscores
    assert mcp_tools._namespace_tool_name("my-srv", "a.b c") == "my_srv_a_b_c"
    # truncated to 64 chars
    assert len(mcp_tools._namespace_tool_name("x" * 50, "y" * 50)) == 64


def test_result_text_concatenates_text_blocks():
    res = _ToolResult([_Content("hello "), _Content(), _Content("world")])
    assert mcp_tools._result_text(res) == "hello world"
    assert mcp_tools._result_text(_ToolResult(None)) == ""


def test_make_descriptor_schema_shape():
    tool = _Tool(
        "lookup",
        "Look something up",
        {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]},
    )
    desc = mcp_tools._make_descriptor(
        server_name="dir", session=_FakeSession(), tool=tool, log=_NullLog()
    )
    assert desc["schema"] == {
        "name": "dir_lookup",
        "description": "Look something up",
        "properties": {"q": {"type": "string"}},
        "required": ["q"],
    }
    assert callable(desc["execute"])


def test_execute_proxies_to_session_with_original_name():
    session = _FakeSession(result=_ToolResult([_Content("42")]))
    tool = _Tool("answer", "", {})
    desc = mcp_tools._make_descriptor(
        server_name="srv", session=session, tool=tool, log=_NullLog()
    )

    out = asyncio.run(desc["execute"]({"x": 1}))

    assert out == "42"
    # The server is called with the ORIGINAL (un-namespaced) tool name.
    assert session.calls == [("answer", {"x": 1})]


def test_execute_raises_on_tool_error_flag():
    session = _FakeSession(result=_ToolResult([_Content("boom")], is_error=True))
    tool = _Tool("explode", "", {})
    desc = mcp_tools._make_descriptor(
        server_name="srv", session=session, tool=tool, log=_NullLog()
    )
    with pytest.raises(RuntimeError):
        asyncio.run(desc["execute"]({}))


def test_connect_skips_servers_without_url():
    descriptors, closers = asyncio.run(
        mcp_tools.connect_mcp_servers(
            {"mcpServers": [{"name": "broken"}]}, log=_NullLog()
        )
    )
    assert descriptors == []
    assert closers == []


def test_connect_empty_when_no_servers():
    descriptors, closers = asyncio.run(
        mcp_tools.connect_mcp_servers({}, log=_NullLog())
    )
    assert descriptors == []
    assert closers == []


# --- key-based authentication (mcpServers[].key -> agent keys) ---------------

def _resolve(key_name, keys, url="https://mcp.example.com/mcp"):
    return mcp_tools._resolve_key_auth(
        key_name, keys, url, log=_NullLog(), server_name="srv"
    )


def test_resolve_bearer_key_sets_authorization_header():
    headers, url = _resolve("k", [{"name": "k", "in": "bearer", "value": "sk-tok"}])
    assert headers == {"Authorization": "Bearer sk-tok"}
    assert url == "https://mcp.example.com/mcp"


def test_resolve_basic_key_uses_precomputed_value():
    headers, _ = _resolve("k", [{"name": "k", "in": "basic", "value": "dXNlcjpwYXNz"}])
    assert headers == {"Authorization": "Basic dXNlcjpwYXNz"}


def test_resolve_basic_key_encodes_username_password_when_no_value():
    headers, _ = _resolve(
        "k", [{"name": "k", "in": "basic", "username": "user", "password": "pass"}]
    )
    # base64("user:pass") == "dXNlcjpwYXNz"
    assert headers == {"Authorization": "Basic dXNlcjpwYXNz"}


def test_resolve_custom_header_key_uses_header_name():
    headers, _ = _resolve(
        "k", [{"name": "k", "in": "header", "header": "X-Api-Key", "value": "abc"}]
    )
    assert headers == {"X-Api-Key": "abc"}


def test_resolve_query_key_appends_to_url():
    headers, url = _resolve(
        "api_key",
        [{"name": "api_key", "in": "query", "value": "abc"}],
        url="https://mcp.example.com/mcp?x=1",
    )
    assert headers == {}
    assert url == "https://mcp.example.com/mcp?x=1&api_key=abc"


def test_resolve_unknown_key_yields_no_auth():
    headers, url = _resolve("missing", [{"name": "other", "in": "bearer", "value": "v"}])
    assert headers == {}
    assert url == "https://mcp.example.com/mcp"


def test_resolve_unsupported_in_yields_no_auth():
    headers, _ = _resolve("k", [{"name": "k", "in": "path", "value": "v"}])
    assert headers == {}


class _NullLog:
    """Minimal loguru-style logger: ``.bind(...).debug/info/warning(...)``."""

    def bind(self, **_kwargs):
        return self

    def debug(self, *_a, **_k):
        pass

    info = debug
    warning = debug
