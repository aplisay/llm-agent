"""Tests for transfer-leg target normalisation on the sipbridge gateway.

Root cause pinned here (beta 2026-08-04): a trunk-origin blind transfer takes
the dial_bridge path, which POSTed the agent-configured bare number verbatim;
the Go bridge's ``Manager.Originate`` → ``sip.ParseUri`` then 502s with
``invalid target URI "44...": invalid uri scheme``. The outbound-originate
path already solved this (``_outbound_target_uri``); these tests pin the
shared ``_routable_leg_uri`` helper and the dial_bridge / consult POST bodies
(routable target, caller-ID fallback, X-Aplisay-* egress headers).
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

import pytest

from pipecat_aplisay.sip_gateway.base import TransferRequest
from pipecat_aplisay.sip_gateway.sipbridge_gateway import (
    _routable_leg_uri,
    _transfer_egress_headers,
    _SbGatewaySession,
)


# ---- _routable_leg_uri ----------------------------------------------------


def test_bare_number_routes_to_outbound_sbc():
    assert (
        _routable_leg_uri("443300889471", outbound_sbc="sbc.example:5061;transport=tls")
        == "sip:443300889471@sbc.example:5061;transport=tls"
    )


def test_sip_uri_passes_through_unchanged():
    uri = "sips:+441234@carrier.example;transport=tls"
    assert _routable_leg_uri(uri, outbound_sbc="sbc.example") == uri


def test_registration_origin_routes_to_b2bua_gateway():
    assert (
        _routable_leg_uri(
            "8093",
            registration_endpoint_id="reg-1",
            b2bua_gateway_ip="10.0.0.5",
            b2bua_gateway_transport=None,
            outbound_sbc="sbc.example",
        )
        == "sip:8093@10.0.0.5:5070;transport=tcp"
    )


def test_bare_number_without_route_raises():
    with pytest.raises(RuntimeError, match="PIPECAT_SIP_OUTBOUND"):
        _routable_leg_uri("443300889471", outbound_sbc=None)


# ---- _transfer_egress_headers ---------------------------------------------


def _req(**kw: Any) -> TransferRequest:
    base = dict(destination="443300889471", operation="blind")
    base.update(kw)
    return TransferRequest(**base)


def test_trunk_egress_headers():
    req = _req(aplisay_id="magrathea", origin_caller_id="07970939456")
    assert _transfer_egress_headers(req) == {
        "X-Aplisay-Trunk": "magrathea",
        "X-Aplisay-Origin-Caller-Id": "07970939456",
    }


def test_trunk_srtp_opt_out_is_stamped_on_the_transfer_leg():
    """``Trunk.flags.srtp == false`` reaches the bridge as X-Aplisay-Srtp: off.

    A transfer leg egresses over a trunk exactly as an originate does, so a
    carrier that advertises RTP/SAVP and then sends plain RTP breaks a transfer
    the same way — and the reject-driven downgrade never fires there either,
    because nothing is ever rejected.
    """
    req = _req(aplisay_id="magrathea", srtp=False)
    assert _transfer_egress_headers(req) == {
        "X-Aplisay-Trunk": "magrathea",
        "X-Aplisay-Srtp": "off",
    }


def test_srtp_header_absent_unless_explicitly_off():
    """Absence means unchanged, so None and True must stamp nothing."""
    for value in (None, True):
        assert "X-Aplisay-Srtp" not in _transfer_egress_headers(
            _req(aplisay_id="magrathea", srtp=value)
        )


def test_registration_egress_headers():
    req = _req(
        registration_endpoint_id="reg-1",
        b2bua_gateway_ip="10.0.0.5",
        b2bua_gateway_transport="tcp",
    )
    assert _transfer_egress_headers(req) == {
        "X-Aplisay-PhoneRegistration": "reg-1",
        "X-Lk-RealIp": "10.0.0.5",
        "X-Lk-Transport": "tcp",
    }


# ---- dial_bridge POST body ------------------------------------------------


class _FakeGateway:
    """Captures _call_api invocations; quacks like SipBridgeSipGateway for the
    slices _do_blind touches."""

    def __init__(self, outbound_sbc: Optional[str] = "sbc.example:5061;transport=tls"):
        self.outbound_sbc = outbound_sbc
        self.calls: list[tuple[str, str, Optional[dict]]] = []

    async def _call_api(self, method: str, path: str, body: Optional[dict], **kw: Any):
        self.calls.append((method, path, body))
        return {}

    # consult-leg bookkeeping used by _do_blind's preamble
    def get_consult_call_id(self, session_id: str) -> Optional[str]:
        return None

    def clear_consult_call_id(self, session_id: str) -> None:  # pragma: no cover
        pass


def _session(gateway: _FakeGateway) -> _SbGatewaySession:
    return _SbGatewaySession(
        transport=None,  # not touched by transfer()
        session_id="sess-1",
        bridge_call_id="call-1",
        _gateway=gateway,
    )


def test_dial_bridge_posts_routable_target_and_egress_headers():
    gw = _FakeGateway()
    session = _session(gw)
    req = _req(
        force_bridged=True,
        aplisay_id="magrathea",
        origin_caller_id="07970939456",
    )
    asyncio.run(session.transfer(req))

    assert len(gw.calls) == 1
    method, path, body = gw.calls[0]
    assert (method, path) == ("POST", "/v1/calls/call-1/transfer")
    assert body == {
        "target": "sip:443300889471@sbc.example:5061;transport=tls",
        "mode": "dial_bridge",
        # no explicit override -> falls back to the genuine origin caller
        "caller_id": "07970939456",
        "custom_headers": {
            "X-Aplisay-Trunk": "magrathea",
            "X-Aplisay-Origin-Caller-Id": "07970939456",
        },
        "monitor_dtmf": False,
        "tap_audio": False,
    }


def test_dial_bridge_caller_id_override_wins():
    gw = _FakeGateway()
    session = _session(gw)
    req = _req(
        force_bridged=True,
        caller_id_override="8092",
        origin_caller_id="07970939456",
    )
    asyncio.run(session.transfer(req))
    _, _, body = gw.calls[0]
    assert body["caller_id"] == "8092"


def test_dial_bridge_bare_number_without_sbc_fails_before_posting():
    gw = _FakeGateway(outbound_sbc=None)
    session = _session(gw)
    req = _req(force_bridged=True)
    with pytest.raises(RuntimeError, match="bridged transfer has no route"):
        asyncio.run(session.transfer(req))
    assert gw.calls == []  # nothing hit the bridge API


def test_refer_path_unchanged_for_bare_numbers():
    """Blind REFER keeps the raw target: the Go side builds the Refer-To
    (bare numbers are normalised there against the bridge's signal IP and
    rewritten by the upstream B2BUA)."""
    gw = _FakeGateway()
    session = _session(gw)
    req = _req(force_bridged=False)
    asyncio.run(session.transfer(req))
    _, _, body = gw.calls[0]
    assert body == {"target": "443300889471", "mode": "blind"}
