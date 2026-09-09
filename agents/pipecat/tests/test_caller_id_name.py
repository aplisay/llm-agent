"""Tests for ``metadata.aplisay.callerIdName`` — the caller's display-name from
the inbound INVITE's From header (docs/caller-id-name.md).

Pins:

  - ``normalise_display_name``: quoted-string / backslash quoted-pair /
    whitespace / control-character handling, and the None-for-empty contract;
  - the sipbridge resolver: the percent-encoded ``X-Sipbridge-From-Name`` WS
    handshake header -> ``InboundCallContext.caller_id_name``, and its exclusion
    from ``sipHeaders`` (it is sipbridge transport metadata, not an INVITE
    header);
  - ``setup_inbound_call``: ``callerIdName`` lands under ``metadata.aplisay``
    only when the gateway populated it.
"""

from __future__ import annotations

import asyncio
import types

import pytest
from starlette.datastructures import Headers

from pipecat_aplisay.sip_gateway.base import InboundCallContext, normalise_display_name


# ---- normalise_display_name ----------------------------------------------


@pytest.mark.parametrize(
    "raw, expected",
    [
        ("Alice Smith", "Alice Smith"),
        # sipgo strips the quotes but leaves the quoted-pairs in place.
        ('Alice \\"A\\" Smith', 'Alice "A" Smith'),
        ("Smith \\\\ Co", "Smith \\ Co"),
        # Raw quoted-string form (quotes still on).
        ('"Alice Smith"', "Alice Smith"),
        ('"Smith, \\"Ali\\""', 'Smith, "Ali"'),
        # UTF-8 passes through.
        ("Zoë Müller", "Zoë Müller"),
        # Whitespace collapsed, control characters replaced, trimmed.
        ("  Alice \t  Smith\x01 ", "Alice Smith"),
        # A lone trailing backslash is dropped rather than kept.
        ("Alice\\", "Alice"),
    ],
)
def test_normalise_display_name(raw, expected):
    assert normalise_display_name(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "   ", '""', '"  "', "\x00\x1f"])
def test_normalise_display_name_empty_is_none(raw):
    assert normalise_display_name(raw) is None


def test_inbound_ctx_defaults_caller_id_name_none():
    ctx = InboundCallContext(session_id="s", called_id="t", caller_id="f")
    assert ctx.caller_id_name is None


# ---- sipbridge WS handshake ------------------------------------------------


class _WS:
    """Just enough of a Starlette WebSocket for the resolver: ``.headers``
    (Starlette lowercases header names and decodes them as latin-1, exactly as
    the real handshake does)."""

    def __init__(self, headers: dict):
        self.headers = Headers(headers)


_HANDSHAKE = {
    "host": "pipecat-worker:8082",
    "upgrade": "websocket",
    "x-sipbridge-call-id": "abc@host",
    "x-sipbridge-from": "sip:+441234@sbc",
    "x-sipbridge-to": "sip:+445678@sbc",
    "x-aplisay-trunk": "trunk-1",
    "x-customer-id": "42",
}


def _patch_lookup(monkeypatch):
    from pipecat_aplisay import worker

    async def fake_lookup(*, phone_registration, to_number, aplisay_id):
        return {"id": "i", "Agent": {"id": "a"}}, worker._InboundOrigin()

    monkeypatch.setattr(worker, "_lookup_instance_for_inbound", fake_lookup)
    return worker


def test_sipbridge_from_name_is_percent_decoded_and_normalised(monkeypatch):
    worker = _patch_lookup(monkeypatch)
    # What the Go bridge sends for From: "Zoë \"A\" Smith" <sip:+441234@sbc>
    # (sipgo DisplayName `Zoë \"A\" Smith`, url.PathEscape'd).
    ws = _WS({**_HANDSHAKE, "x-sipbridge-from-name": "Zo%C3%AB%20%5C%22A%5C%22%20Smith"})
    resolved = asyncio.run(worker._sipbridge_resolve_agent_from_headers(ws))
    assert resolved is not None
    _instance, _agent, ctx = resolved
    assert ctx.caller_id_name == 'Zoë "A" Smith'
    assert ctx.caller_id == "+441234"
    # The name header is transport metadata, never an INVITE X- header.
    assert ctx.sip_headers == {"x-aplisay-trunk": "trunk-1", "x-customer-id": "42"}


def test_sipbridge_plain_ascii_name(monkeypatch):
    worker = _patch_lookup(monkeypatch)
    ws = _WS({**_HANDSHAKE, "x-sipbridge-from-name": "Alice%20Smith"})
    _i, _a, ctx = asyncio.run(worker._sipbridge_resolve_agent_from_headers(ws))
    assert ctx.caller_id_name == "Alice Smith"


@pytest.mark.parametrize("value", [None, "", "%20", "%22%22"])
def test_sipbridge_no_or_empty_name_is_none(monkeypatch, value):
    worker = _patch_lookup(monkeypatch)
    headers = dict(_HANDSHAKE)
    if value is not None:
        headers["x-sipbridge-from-name"] = value
    _i, _a, ctx = asyncio.run(worker._sipbridge_resolve_agent_from_headers(_WS(headers)))
    assert ctx.caller_id_name is None


def test_sipbridge_denylist_excludes_from_name():
    from pipecat_aplisay.worker import _SIPBRIDGE_NON_INVITE_HEADERS

    assert "x-sipbridge-from-name" in _SIPBRIDGE_NON_INVITE_HEADERS


# ---- setup_inbound_call metadata shaping ---------------------------------


class _StubGatewaySession:
    transport = None
    session_id = "s"

    async def shutdown(self) -> None:  # pragma: no cover
        return None


class _StubGateway:
    name = "sipbridge"

    async def setup_inbound(self, inbound, params):
        return _StubGatewaySession()


def _patch_api(monkeypatch, captured):
    from pipecat_aplisay import api_client

    async def _fake_create_call(payload):
        captured["payload"] = payload
        return types.SimpleNamespace(id="call-1", metadata=payload.get("metadata"))

    async def _fake_start_call(call):  # pragma: no cover - trivial
        return None

    monkeypatch.setattr(api_client, "create_call", _fake_create_call)
    monkeypatch.setattr(api_client, "start_call", _fake_start_call)
    agent = {"userId": "u", "organisationId": "o", "id": "a", "modelName": "m"}
    instance = {"id": "i", "metadata": {}}
    return _StubGateway(), instance, agent


def test_setup_inbound_call_includes_caller_id_name(monkeypatch):
    from pipecat_aplisay.call_session import setup_inbound_call

    captured: dict = {}
    gw, instance, agent = _patch_api(monkeypatch, captured)
    ctx = InboundCallContext(
        session_id="s",
        called_id="+445678",
        caller_id="+441234",
        caller_id_name="Alice Smith",
    )
    asyncio.run(setup_inbound_call(gw, ctx, instance=instance, agent=agent))
    aplisay = captured["payload"]["metadata"]["aplisay"]
    assert aplisay["callerIdName"] == "Alice Smith"
    assert aplisay["callerId"] == "+441234"


@pytest.mark.parametrize("empty", [None, ""])
def test_setup_inbound_call_omits_caller_id_name_when_empty(monkeypatch, empty):
    # None = Daily / FreeSWITCH / a From with no display-name; "" defensively.
    # Both omit the key so it is present iff the INVITE carried a name,
    # matching the LiveKit runtime.
    from pipecat_aplisay.call_session import setup_inbound_call

    captured: dict = {}
    gw, instance, agent = _patch_api(monkeypatch, captured)
    ctx = InboundCallContext(
        session_id="s", called_id="+445678", caller_id="+441234", caller_id_name=empty
    )
    asyncio.run(setup_inbound_call(gw, ctx, instance=instance, agent=agent))
    assert "callerIdName" not in captured["payload"]["metadata"]["aplisay"]
