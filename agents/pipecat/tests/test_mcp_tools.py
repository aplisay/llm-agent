"""Unit tests for the worker-as-MCP-client tool adapter (``mcp_tools.py``).

These exercise the pure adapter logic — name namespacing, result-text
extraction, descriptor shape, and the ``execute`` proxy — against a fake MCP
``ClientSession``, so no network or real MCP server is needed. The
network-bearing ``connect_mcp_servers`` is covered for its misconfiguration /
empty-list short-circuits and, with faked transports, for its connect-failure
and success paths (including the diagnostic content of the logs — see the
2026-07-18 emf-bar incident, where a bare "failed to connect" line hid a 404
from a url missing its ``/mcp`` path).
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
        self.is_error = is_error


class _Tool:
    def __init__(self, name, description, input_schema):
        self.name = name
        self.description = description
        self.input_schema = input_schema


class _FakeSession:
    """Records the last call_tool invocation and returns a canned result."""

    def __init__(self, result=None, raises=None):
        self._result = result
        self._raises = raises
        self.calls = []

    async def call_tool(self, name, arguments=None, read_timeout_seconds=None):
        self.calls.append((name, arguments))
        self.last_read_timeout = read_timeout_seconds
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


class _CapturingLog(_NullLog):
    """Records (level, message) tuples so tests can assert on log content."""

    def __init__(self):
        self.records = []

    def debug(self, message, *_a, **_k):
        self.records.append(("debug", message))

    def info(self, message, *_a, **_k):
        self.records.append(("info", message))

    def warning(self, message, *_a, **_k):
        self.records.append(("warning", message))

    def messages(self, level):
        return [m for lvl, m in self.records if lvl == level]


# --- connect: error summaries and log diagnosability -------------------------

def test_error_summary_unwraps_nested_exception_groups():
    leaf = ValueError("Client error '404 Not Found' for url 'https://x/'")
    grouped = ExceptionGroup(
        "unhandled errors in a TaskGroup",
        [ExceptionGroup("sub-group", [leaf]), ValueError(str(leaf))],
    )
    summary = mcp_tools._error_summary(grouped)
    assert "404 Not Found" in summary
    assert "TaskGroup" not in summary
    # duplicate leaves collapse to one
    assert summary == "ValueError: Client error '404 Not Found' for url 'https://x/'"


def test_error_summary_plain_exception_keeps_type_and_text():
    assert mcp_tools._error_summary(RuntimeError("boom")) == "RuntimeError: boom"
    assert mcp_tools._error_summary(RuntimeError()) == "RuntimeError"


class _ExplodingCM:
    """Async CM standing in for ``streamable_http_client`` whose enter fails the
    way anyio surfaces transport errors — wrapped in an ExceptionGroup."""

    def __init__(self, exc):
        self._exc = exc

    async def __aenter__(self):
        raise self._exc

    async def __aexit__(self, *_exc_info):
        return False


def test_connect_failure_log_names_server_url_and_cause(monkeypatch):
    import mcp.client.streamable_http as shttp

    url = "https://mcp.example.com"  # note: missing the /mcp path
    cause = ExceptionGroup(
        "unhandled errors in a TaskGroup",
        [ValueError(f"Client error '404 Not Found' for url '{url}/'")],
    )
    monkeypatch.setattr(
        shttp, "streamable_http_client", lambda *_a, **_k: _ExplodingCM(cause)
    )

    log = _CapturingLog()
    descriptors, closers = asyncio.run(
        mcp_tools.connect_mcp_servers(
            {"mcpServers": [{"name": "emf_bar", "url": url}]}, log=log
        )
    )

    assert descriptors == []
    assert closers == []
    [warning] = log.messages("warning")
    # The message itself must carry the diagnosis: which server, which url,
    # and the leaf error — not the ExceptionGroup wrapper text.
    assert "emf_bar" in warning
    assert url in warning
    assert "404 Not Found" in warning
    assert "TaskGroup" not in warning


class _FakeStreamsCM:
    async def __aenter__(self):
        return ("read", "write", None)

    async def __aexit__(self, *_exc_info):
        return False


class _FakeClientSessionCM:
    """Stands in for ``mcp.ClientSession``: yields a session that lists tools."""

    def __init__(self, *_a, **_k):
        pass

    async def __aenter__(self):
        return _FakeSession(result=_ToolResult([_Content("ok")]))

    async def __aexit__(self, *_exc_info):
        return False


def test_connect_success_logs_server_and_tool_names(monkeypatch):
    import mcp
    import mcp.client.streamable_http as shttp

    async def _list_tools(self):
        class _Listed:
            tools = [_Tool("order_drink", "Order a drink", {})]

        return _Listed()

    async def _initialize(self):
        return None

    monkeypatch.setattr(_FakeSession, "initialize", _initialize, raising=False)
    monkeypatch.setattr(_FakeSession, "list_tools", _list_tools, raising=False)
    monkeypatch.setattr(
        shttp, "streamable_http_client", lambda *_a, **_k: _FakeStreamsCM()
    )
    monkeypatch.setattr(mcp, "ClientSession", _FakeClientSessionCM)

    log = _CapturingLog()

    async def _connect_and_close():
        descriptors, closers = await mcp_tools.connect_mcp_servers(
            {"mcpServers": [{"name": "emf_bar", "url": "https://mcp.example.com/mcp"}]},
            log=log,
        )
        await mcp_tools.close_mcp_servers(closers, log=log)
        return descriptors

    descriptors = asyncio.run(_connect_and_close())

    assert [d["schema"]["name"] for d in descriptors] == ["emf_bar_order_drink"]
    [info] = log.messages("info")
    assert "emf_bar" in info
    assert "https://mcp.example.com/mcp" in info
    assert "emf_bar_order_drink" in info


# --- result size cap ------------------------------------------------------------
#
# An MCP server is a third party and can return whatever it likes. On the
# 2026-09-14 beta call four results totalling 92 KB arrived in one turn and
# exhausted the responses delegation's 32768-byte per-session tool budget,
# which stranded the delegation and left the caller in silence.


def _capped(text, max_bytes, name="reader"):
    session = _FakeSession(result=_ToolResult([_Content(text)]))
    desc = mcp_tools._make_descriptor(
        server_name="srv", session=session, tool=_Tool(name, "", {}), log=_NullLog(),
        max_result_bytes=max_bytes,
    )
    return asyncio.run(desc["execute"]({}))


def test_a_result_within_the_cap_is_untouched():
    assert _capped("short answer", 8000) == "short answer"


def test_an_oversized_result_is_cut_to_the_cap():
    out = _capped("y" * 40000, 2500)
    # The marker is added after the cut, so the body is what obeys the cap.
    body = out.split("\n\n[", 1)[0]
    assert len(body.encode("utf-8")) <= 2500
    assert len(out.encode("utf-8")) < 3200, "the marker is a footnote, not a second payload"


def test_truncation_says_so_and_says_what_to_do():
    # Silence here is the dangerous option: a model cannot tell a short answer
    # from a cut one, and would answer confidently from half a document.
    out = _capped("y" * 40000, 2500, name="read_doc")
    assert "truncated here" in out
    assert "read_doc" in out
    assert "37" in out and "40000" in out, "names the bytes dropped and the total"
    assert "smaller or more specific part" in out
    assert "do not repeat this call unchanged" in out


def test_the_cut_prefers_a_line_boundary_without_losing_much():
    text = "\n".join("line %d" % n for n in range(2000))
    out = _capped(text, 1000)
    body = out.split("\n\n[", 1)[0]
    assert not body.endswith("lin"), "not cut mid-token when a boundary is near"
    assert len(body.encode("utf-8")) > 750, "and not sacrificing a quarter to find one"


def test_a_cut_inside_a_multibyte_character_stays_valid_utf8():
    # A naive byte slice can split a character and produce invalid UTF-8,
    # which would break the JSON encoding of the tool result downstream.
    out = _capped("é" * 4000, 1001)
    assert out.encode("utf-8").decode("utf-8") == out
    assert "�" not in out


def test_the_delegated_cap_leaves_room_for_a_conversation():
    # The real point of the tighter cap: a whole call's worth of tool calls
    # has to fit in the delegation's per-session budget, not just one.
    budget = 32768
    calls_that_fit = budget // (mcp_tools.MCP_MAX_RESULT_BYTES_DELEGATED + 400)
    assert calls_that_fit >= 11, f"only {calls_that_fit} tool calls would fit"
    # The incident's four results were 92699 bytes; capped they are far less
    # than the budget rather than three times it.
    assert 4 * mcp_tools.MCP_MAX_RESULT_BYTES_DELEGATED < budget


def test_an_error_result_is_not_capped_but_raised():
    # The error path must keep raising rather than returning a truncated
    # error string the model would read as data.
    session = _FakeSession(result=_ToolResult([_Content("x" * 40000)], is_error=True))
    desc = mcp_tools._make_descriptor(
        server_name="srv", session=session, tool=_Tool("explode", "", {}), log=_NullLog(),
        max_result_bytes=100,
    )
    with pytest.raises(RuntimeError):
        asyncio.run(desc["execute"]({}))


def test_a_cap_of_zero_disables_capping():
    assert _capped("y" * 40000, 0) == "y" * 40000


def test_truncation_is_logged_loudly_with_the_numbers():
    # The tool log's own copy of a result is capped at 8000 chars, so without
    # this line an oversized result is invisible after the fact.
    records = []

    class _Log:
        def bind(self, **kw):
            records.append(kw)
            return self

        def debug(self, *a, **k):
            pass

        def warning(self, *a, **k):
            records[-1]["_level"] = "warning"

    session = _FakeSession(result=_ToolResult([_Content("y" * 40000)]))
    desc = mcp_tools._make_descriptor(
        server_name="srv", session=session, tool=_Tool("reader", "", {}), log=_Log(),
        max_result_bytes=2500,
    )
    asyncio.run(desc["execute"]({}))
    warned = [r for r in records if r.get("_level") == "warning"]
    assert len(warned) == 1
    assert warned[0]["dropped_bytes"] > 37000
    assert warned[0]["cap"] == 2500
    assert warned[0]["tool"] == "reader"


def test_the_cap_reaches_a_real_descriptor_through_connect(monkeypatch):
    """The wiring is the part that actually protects a call.

    A cap the connect path drops on the floor would pass every unit test
    above, so this drives the whole path with faked transports and checks the
    result a tool call actually returns.
    """
    import mcp
    import mcp.client.streamable_http as shttp

    async def _list_tools(self):
        class _Listed:
            tools = [_Tool("read_doc", "Read a document", {})]

        return _Listed()

    async def _initialize(self):
        return None

    async def _call_tool(self, name, arguments=None, read_timeout_seconds=None):
        return _ToolResult([_Content("y" * 40000)])

    monkeypatch.setattr(_FakeSession, "initialize", _initialize, raising=False)
    monkeypatch.setattr(_FakeSession, "list_tools", _list_tools, raising=False)
    monkeypatch.setattr(_FakeSession, "call_tool", _call_tool, raising=False)
    monkeypatch.setattr(shttp, "streamable_http_client", lambda *_a, **_k: _FakeStreamsCM())
    monkeypatch.setattr(mcp, "ClientSession", _FakeClientSessionCM)

    agent = {"mcpServers": [{"name": "docs", "url": "https://mcp.example.com/mcp"}]}

    async def _run(cap):
        descriptors, closers = await mcp_tools.connect_mcp_servers(
            agent, log=_NullLog(), max_result_bytes=cap)
        out = await descriptors[0]["execute"]({})
        await mcp_tools.close_mcp_servers(closers, log=_NullLog())
        return out

    out = asyncio.run(_run(2500))
    body = out.split("\n\n[", 1)[0]
    assert len(body.encode("utf-8")) <= 2500, "the cap survived the whole connect path"
    assert "truncated here" in out

    # and the default applies when no cap is named
    async def _run_default():
        descriptors, closers = await mcp_tools.connect_mcp_servers(agent, log=_NullLog())
        out = await descriptors[0]["execute"]({})
        await mcp_tools.close_mcp_servers(closers, log=_NullLog())
        return out

    out = asyncio.run(_run_default())
    body = out.split("\n\n[", 1)[0]
    assert len(body.encode("utf-8")) <= mcp_tools.MCP_MAX_RESULT_BYTES
