"""Tests for inbound SIP INVITE X- header capture -> metadata.aplisay.sipHeaders.

The sipbridge and voiceblender gateways surface every X- header from the inbound
INVITE (keys lowercased) so agents can reference them via metadata paths like
``aplisay.sipHeaders.x-my-header``. These tests pin:

  - ``collect_sip_headers``: the shared filter/normalise helper;
  - the sipbridge WS-handshake denylist (sipbridge's own transport headers +
    proxy noise dropped; the INVITE contract + custom carrier headers kept);
  - the voiceblender ``custom_headers`` collection (and the ``sip_headers``
    fallback);
  - ``setup_inbound_call``: sipHeaders lands under ``metadata.aplisay`` only when
    the gateway populated it (Daily / FreeSWITCH leave it None -> key omitted).
"""

from __future__ import annotations

import asyncio
import types

import pytest

from pipecat_aplisay.sip_gateway.base import InboundCallContext, collect_sip_headers


# ---- collect_sip_headers -------------------------------------------------


def test_collect_keeps_only_x_headers_lowercased():
    out = collect_sip_headers(
        [
            ("X-Customer-ID", "42"),
            ("X-Account-Type", "premium"),
            ("Host", "example"),
            ("Content-Type", "application/sdp"),
        ]
    )
    assert out == {"x-customer-id": "42", "x-account-type": "premium"}


def test_collect_excludes_named_and_prefixed():
    out = collect_sip_headers(
        [
            ("X-Sipbridge-From", "sip:a@b"),
            ("X-Forwarded-For", "10.0.0.1"),
            ("X-Aplisay-Trunk", "tk"),
            ("X-Real", "keep"),  # not in the denylist -> kept
        ],
        exclude=frozenset({"x-sipbridge-from"}),
        exclude_prefixes=("x-forwarded-",),
    )
    assert out == {"x-aplisay-trunk": "tk", "x-real": "keep"}


def test_collect_skips_none_and_dedups_last_wins():
    out = collect_sip_headers(
        [
            ("X-A", None),
            ("X-B", "1"),
            ("x-b", "2"),
        ]
    )
    assert out == {"x-b": "2"}


def test_collect_empty():
    assert collect_sip_headers([]) == {}


# ---- gateway call-site configurations ------------------------------------


def test_sipbridge_handshake_selection():
    """Replicates the sipbridge resolver's exact collect_sip_headers() call to
    pin which handshake headers become sipHeaders."""
    from pipecat_aplisay.worker import _SIPBRIDGE_NON_INVITE_HEADERS

    # A realistic sipbridge WS handshake header set (Starlette lowercases names).
    handshake = [
        ("host", "pipecat-worker:8082"),
        ("upgrade", "websocket"),
        ("x-sipbridge-call-id", "abc@host"),
        ("x-sipbridge-from", "sip:+441234@sbc"),
        ("x-sipbridge-to", "sip:+445678@sbc"),
        ("x-aplisay-trunk", "trunk-1"),
        ("x-lk-realip", "203.0.113.9"),
        ("x-customer-id", "42"),
        ("x-campaign", "spring"),
        ("x-forwarded-for", "10.0.0.1"),
    ]
    out = collect_sip_headers(
        handshake,
        exclude=_SIPBRIDGE_NON_INVITE_HEADERS,
        exclude_prefixes=("x-forwarded-",),
    )
    # Contract headers (x-aplisay-*, x-lk-*) AND arbitrary carrier headers kept;
    # sipbridge transport metadata and proxy noise dropped.
    assert out == {
        "x-aplisay-trunk": "trunk-1",
        "x-lk-realip": "203.0.113.9",
        "x-customer-id": "42",
        "x-campaign": "spring",
    }


def test_voiceblender_sip_headers():
    # Voiceblender delivers the inbound INVITE's X- headers in the `leg.ringing`
    # event's `sip_headers` field (`LegRingingData.SIPHeaders` in the voiceblender
    # source — it extracts every `X-*` INVITE header). Non-X- entries are dropped.
    event = {
        "sip_headers": {"X-Aplisay-Trunk": "tk", "X-Customer-ID": "42", "Route": "r"}
    }
    out = collect_sip_headers((event.get("sip_headers") or {}).items())
    assert out == {"x-aplisay-trunk": "tk", "x-customer-id": "42"}


# ---- InboundCallContext default ------------------------------------------


def test_inbound_ctx_defaults_sip_headers_none():
    ctx = InboundCallContext(session_id="s", called_id="t", caller_id="f")
    assert ctx.sip_headers is None


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


def test_setup_inbound_call_includes_sip_headers(monkeypatch):
    from pipecat_aplisay.call_session import setup_inbound_call

    captured: dict = {}
    gw, instance, agent = _patch_api(monkeypatch, captured)
    ctx = InboundCallContext(
        session_id="s",
        called_id="+445678",
        caller_id="+441234",
        sip_headers={"x-customer-id": "42", "x-aplisay-trunk": "tk"},
    )
    asyncio.run(setup_inbound_call(gw, ctx, instance=instance, agent=agent))
    aplisay = captured["payload"]["metadata"]["aplisay"]
    assert aplisay["sipHeaders"] == {"x-customer-id": "42", "x-aplisay-trunk": "tk"}


@pytest.mark.parametrize("empty", [None, {}])
def test_setup_inbound_call_omits_sip_headers_when_empty(monkeypatch, empty):
    # None = Daily / FreeSWITCH (never populated); {} = a sipbridge/voiceblender
    # call that carried no X- headers. Both omit the key so it is present iff
    # there was at least one header, matching the LiveKit runtime.
    from pipecat_aplisay.call_session import setup_inbound_call

    captured: dict = {}
    gw, instance, agent = _patch_api(monkeypatch, captured)
    ctx = InboundCallContext(
        session_id="s", called_id="+445678", caller_id="+441234", sip_headers=empty
    )
    asyncio.run(setup_inbound_call(gw, ctx, instance=instance, agent=agent))
    aplisay = captured["payload"]["metadata"]["aplisay"]
    assert "sipHeaders" not in aplisay
