"""Request bodies the voiceblender gateway sends to the VoiceBlender REST API.

Pins the field names against upstream v0.16 (see docs/voiceblender-integration.md):
``custom_data`` on ``POST /v1/legs``, the delete ``reason`` enum, and the
attended transfer body.
"""

from __future__ import annotations

import asyncio

import pytest

from pipecat_aplisay.sip_gateway.base import (
    GatewaySessionParams,
    OutboundCallParams,
    TransferRequest,
)
from pipecat_aplisay.sip_gateway.voiceblender_gateway import (
    VoiceblenderSipGateway,
    _VbGatewaySession,
)


@pytest.fixture
def gateway(monkeypatch):
    monkeypatch.setenv("PIPECAT_SIP_OUTBOUND", "sbc.example:5060")
    monkeypatch.delenv("PIPECAT_SIP_PASSWORD", raising=False)
    gw = VoiceblenderSipGateway()
    calls: list[tuple[str, str, object]] = []

    async def fake_call_api(method, path, body, *, raise_on_error=True):
        calls.append((method, path, body))
        if method == "POST" and path == "/v1/legs":
            return {"id": f"leg-{len(calls)}"}
        return None

    monkeypatch.setattr(gw, "_call_api", fake_call_api)
    gw.calls = calls
    return gw


def _session(gw, leg_id: str, session_id: str) -> _VbGatewaySession:
    return _VbGatewaySession(
        transport=None, session_id=session_id, leg_id=leg_id, _gateway=gw
    )


def test_originate_sends_custom_data_not_metadata(gateway, monkeypatch):
    async def no_answer(leg_id, *, timeout):
        raise RuntimeError("stop after the POST")

    monkeypatch.setattr(gateway, "_await_connected", no_answer)
    params = OutboundCallParams(
        caller_id="+441234", called_id="+445678", call_id="call-1"
    )
    with pytest.raises(RuntimeError):
        asyncio.run(
            gateway.originate(params, GatewaySessionParams(session_id="s-1"))
        )
    method, path, body = gateway.calls[0]
    assert (method, path) == ("POST", "/v1/legs")
    assert body["custom_data"] == {"aplisay_call_id": "call-1"}
    assert "metadata" not in body
    assert body["to"] == "sip:+445678@sbc.example:5060"


def test_consult_and_dial_bridge_send_custom_data(gateway, monkeypatch):
    async def no_attach(leg_id, session_id):
        return None

    monkeypatch.setattr(gateway, "_connect_then_attach", no_attach)
    parent = _session(gateway, "leg-a", "s-a")

    async def run():
        await parent.transfer(
            TransferRequest(destination="+447000", operation="consultative")
        )
        await parent.transfer(
            TransferRequest(
                destination="+447001", operation="blind", force_bridged=True
            )
        )

    asyncio.run(run())
    legs = [body for m, p, body in gateway.calls if (m, p) == ("POST", "/v1/legs")]
    assert legs[0]["custom_data"] == {"consult_of": "leg-a"}
    assert legs[1]["custom_data"] == {"bridge_of": "leg-a"}
    assert all("metadata" not in body for body in legs)


def test_attended_refer_uses_replaces_leg_id(gateway, monkeypatch):
    async def no_attach(leg_id, session_id):
        return None

    monkeypatch.setattr(gateway, "_connect_then_attach", no_attach)
    parent = _session(gateway, "leg-a", "s-a")

    async def run():
        await parent.transfer(
            TransferRequest(destination="+447000", operation="consultative")
        )
        consult_leg_id = gateway.get_consult_call_id("s-a")
        consult = _session(gateway, consult_leg_id, "s-c")
        await parent.attended_refer_with(consult)
        return consult_leg_id

    consult_leg_id = asyncio.run(run())
    assert gateway.calls[-1] == (
        "POST",
        "/v1/legs/leg-a/transfer",
        {"target": "sip:+447000@sbc.example:5060", "replaces_leg_id": consult_leg_id},
    )
    assert consult_leg_id not in gateway._consult_targets


def test_attended_refer_falls_back_without_a_dialled_uri(gateway):
    parent = _session(gateway, "leg-a", "s-a")
    consult = _session(gateway, "leg-unknown", "s-c")
    with pytest.raises(NotImplementedError):
        asyncio.run(parent.attended_refer_with(consult))
    assert gateway.calls == []


def test_consult_target_cleared_on_disconnect(gateway):
    gateway._consult_targets["leg-c"] = "sip:+447000@sbc.example:5060"
    asyncio.run(
        gateway._on_leg_disconnected({"type": "leg.disconnected", "leg_id": "leg-c"})
    )
    assert "leg-c" not in gateway._consult_targets


@pytest.mark.parametrize(
    "resolver, reason",
    [
        (None, "server_error"),
        ("raise", "unavailable"),
        ("none", "not_found"),
    ],
)
def test_inbound_reject_reasons_are_in_the_upstream_enum(gateway, resolver, reason):
    if resolver == "raise":
        async def resolve(event):
            raise RuntimeError("lookup down")
        gateway.set_agent_resolver(resolve)
    elif resolver == "none":
        async def resolve(event):
            return None
        gateway.set_agent_resolver(resolve)

    asyncio.run(
        gateway._on_leg_ringing(
            {"type": "leg.ringing", "leg_id": "leg-in", "leg_type": "sip_inbound"}
        )
    )
    assert gateway.calls == [("DELETE", "/v1/legs/leg-in", {"reason": reason})]


def test_inbound_attach_retries_while_the_leg_is_not_connected(gateway, monkeypatch):
    attempts = []

    async def call_api(method, path, body, *, raise_on_error=True):
        attempts.append(path)
        if len(attempts) < 3:
            raise RuntimeError(
                f'voiceblender {method} {path} -> 409 {{"error":"leg not connected"}}'
            )
        return None

    monkeypatch.setattr(gateway, "_call_api", call_api)
    asyncio.run(gateway._attach_after_answer("leg-in", "ws://worker/a/s1"))
    assert attempts == ["/v1/legs/leg-in/agent/pipecat"] * 3


def test_inbound_attach_does_not_retry_other_errors(gateway, monkeypatch):
    attempts = []

    async def call_api(method, path, body, *, raise_on_error=True):
        attempts.append(path)
        raise RuntimeError(
            f'voiceblender {method} {path} -> 409 {{"error":"agent already attached to this leg"}}'
        )

    monkeypatch.setattr(gateway, "_call_api", call_api)
    with pytest.raises(RuntimeError):
        asyncio.run(gateway._attach_after_answer("leg-in", "ws://worker/a/s1"))
    assert len(attempts) == 1

