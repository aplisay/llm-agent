"""Tests for the ``rest`` implementation of the pipecat function handler.

Regression coverage for the 2026-07-25 beta incident: keyed rest functions
(booking_get_slots / booking_book / notify_email_team) were dispatched with NO
credentials because the Python port of ``lib/function-handler.js`` accepted the
agent ``keys`` but never resolved a function's ``key`` reference into an
Authorization header — every call 401'd at the integrations tool plane even
though the key was armed on the agent.

Covers:
- bearer / basic / custom-header / query key resolution (JS-handler parity
  plus the ``query`` type ``mcp_tools`` already supports);
- unknown key name → request still goes out, keyless (server decides);
- >= 400 responses surface the response BODY as the tool result alongside the
  error (previously the model saw ``result: None`` and couldn't tell why);
- unconsumed inputs become the query string on GET (URLSearchParams parity);
- the ``rest_callout`` telemetry emission before the request.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Optional

import pytest

import pipecat_aplisay.function_handler as fh


class _FakeResponse:
    def __init__(self, status_code: int = 200, body: Any = None, json_body: bool = True):
        self.status_code = status_code
        self._body = body if body is not None else {"ok": True}
        self._json = json_body
        self.headers = {"content-type": "application/json" if json_body else "text/plain"}

    @property
    def text(self) -> str:
        return json.dumps(self._body) if self._json else str(self._body)

    def json(self) -> Any:
        return self._body


class _FakeClient:
    """Stands in for httpx.AsyncClient; records the single request it serves."""

    last: Optional[dict] = None
    response: _FakeResponse = _FakeResponse()

    def __init__(self, *_a, **_k):
        pass

    async def __aenter__(self) -> "_FakeClient":
        return self

    async def __aexit__(self, *_exc) -> None:
        return None

    async def request(self, method: str, url: str, headers=None, params=None, json=None):
        _FakeClient.last = {
            "method": method,
            "url": url,
            "headers": dict(headers or {}),
            "params": list(params) if params else None,
            "json": json,
        }
        return _FakeClient.response


@pytest.fixture(autouse=True)
def _fake_httpx(monkeypatch):
    _FakeClient.last = None
    _FakeClient.response = _FakeResponse()
    monkeypatch.setattr(fh.httpx, "AsyncClient", _FakeClient)
    yield


def _rest_fn(**over) -> dict:
    fn = {
        "name": "booking_get_slots",
        "implementation": "rest",
        "method": "post",
        "url": "https://integrations.example/v1/tools/booking.get_slots",
        "key": "POLITE_BOOKING",
        "input_schema": {
            "properties": {
                "days": {"type": "number"},
                "policy": {"type": "string", "source": "static", "from": "bpol_x"},
            }
        },
    }
    fn.update(over)
    return fn


def _run(fn: dict, keys: list[dict], llm_input: Optional[dict] = None, messages: Optional[list] = None) -> dict:
    async def handler(message: dict) -> None:
        if messages is not None:
            messages.append(message)

    async def go() -> dict:
        return await fh.function_handler(
            [{"name": fn["name"], "input": llm_input or {}}],
            [fn],
            keys,
            handler,
            {},
            {},
            {},
        )

    return asyncio.run(go())


class TestKeyResolution:
    def test_bearer_key_sets_authorization(self) -> None:
        result = _run(_rest_fn(), [{"name": "POLITE_BOOKING", "in": "bearer", "value": "sekrit"}], {"days": 7})
        assert result["function_results"][0]["error"] is None
        assert _FakeClient.last["headers"]["Authorization"] == "Bearer sekrit"
        # generated + static params both land in the JSON body on POST
        assert _FakeClient.last["json"] == {"days": 7, "policy": "bpol_x"}

    def test_basic_key_sets_authorization(self) -> None:
        _run(_rest_fn(), [{"name": "POLITE_BOOKING", "in": "basic", "value": "dXNlcjpwdw=="}])
        assert _FakeClient.last["headers"]["Authorization"] == "Basic dXNlcjpwdw=="

    def test_header_key_uses_named_header(self) -> None:
        _run(_rest_fn(), [{"name": "POLITE_BOOKING", "in": "header", "header": "X-Api-Key", "value": "k1"}])
        assert _FakeClient.last["headers"]["X-Api-Key"] == "k1"
        assert "Authorization" not in _FakeClient.last["headers"]

    def test_query_key_appends_param(self) -> None:
        _run(_rest_fn(), [{"name": "POLITE_BOOKING", "in": "query", "value": "qv"}])
        assert ("POLITE_BOOKING", "qv") in (_FakeClient.last["params"] or [])

    def test_unknown_key_sends_no_auth(self) -> None:
        result = _run(_rest_fn(), [{"name": "OTHER_KEY", "in": "bearer", "value": "x"}])
        # The request still goes out (server decides) — matching the JS handler.
        assert _FakeClient.last is not None
        assert "Authorization" not in _FakeClient.last["headers"]
        assert result["function_results"][0]["error"] is None

    def test_unkeyed_function_untouched(self) -> None:
        _run(_rest_fn(key=None), [{"name": "POLITE_BOOKING", "in": "bearer", "value": "sekrit"}])
        assert "Authorization" not in _FakeClient.last["headers"]


class TestErrorSurfacing:
    def test_http_error_returns_body_as_result(self) -> None:
        _FakeClient.response = _FakeResponse(status_code=401, body={"error": "unauthorized"})
        result = _run(_rest_fn(), [])
        first = result["function_results"][0]
        assert "401" in first["error"]
        assert first["result"] == {"error": "unauthorized"}

    def test_http_error_text_body(self) -> None:
        _FakeClient.response = _FakeResponse(status_code=503, body="upstream down", json_body=False)
        result = _run(_rest_fn(), [])
        first = result["function_results"][0]
        assert "503" in first["error"]
        assert first["result"] == "upstream down"


class TestQueryStringMethods:
    def test_get_leftovers_become_params(self) -> None:
        fn = _rest_fn(method="get", url="https://api.example/slots/{policy}")
        _run(fn, [{"name": "POLITE_BOOKING", "in": "bearer", "value": "v"}], {"days": 3})
        # {policy} consumed into the URL; days left over -> query param
        assert _FakeClient.last["url"] == "https://api.example/slots/bpol_x"
        assert ("days", "3") in _FakeClient.last["params"]
        assert _FakeClient.last["json"] is None


class TestTelemetry:
    def test_rest_callout_emitted_before_request(self) -> None:
        messages: list = []
        _run(_rest_fn(), [{"name": "POLITE_BOOKING", "in": "bearer", "value": "v"}], {}, messages)
        kinds = [next(iter(m)) for m in messages]
        assert kinds.index("rest_callout") < kinds.index("function_results")
        callout = next(m for m in messages if "rest_callout" in m)["rest_callout"]
        assert callout["url"].endswith("booking.get_slots")
        assert callout["key"] == "POLITE_BOOKING"


class TestUnsuppliedParamsOmitted:
    """Params the model didn't supply are OMITTED, never fabricated as null.

    Beta 2026-07-27: {"from": null, "days": null} reached booking.get_slots
    for every no-preference call; Number(null) === 0 server-side coerced the
    scan to one day and afternoon callers were told nothing was available.
    """

    def test_unsupplied_generated_param_is_absent_from_the_body(self) -> None:
        _run(_rest_fn(), [{"name": "POLITE_BOOKING", "in": "bearer", "value": "k"}], {})
        assert _FakeClient.last["json"] == {"policy": "bpol_x"}
        assert "days" not in _FakeClient.last["json"]

    def test_model_sent_explicit_null_is_treated_as_unsupplied(self) -> None:
        _run(_rest_fn(), [{"name": "POLITE_BOOKING", "in": "bearer", "value": "k"}], {"days": None})
        assert "days" not in _FakeClient.last["json"]

    def test_declared_default_still_fills_an_absent_param(self) -> None:
        fn = _rest_fn()
        fn["input_schema"]["properties"]["days"] = {"type": "number", "default": 7}
        _run(fn, [{"name": "POLITE_BOOKING", "in": "bearer", "value": "k"}], {})
        assert _FakeClient.last["json"]["days"] == 7

    def test_missing_metadata_without_default_is_omitted_not_null(self) -> None:
        fn = _rest_fn()
        fn["input_schema"]["properties"]["callerNumber"] = {
            "type": "string",
            "source": "metadata",
            "from": "aplisay.callerId",
        }
        _run(fn, [{"name": "POLITE_BOOKING", "in": "bearer", "value": "k"}], {"days": 3})
        assert _FakeClient.last["json"] == {"days": 3, "policy": "bpol_x"}
