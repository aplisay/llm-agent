"""Tests for outbound destination authorisation on the Pipecat worker.

Before this gate the worker dialled whatever the model asked for: unlike the
LiveKit worker and the originate API it consulted neither
``options.outboundCallFilter`` nor any default, so a prompt-injected or simply
over-eager agent could transfer a call to any number on earth.

The worker deliberately does NOT hold the policy — it asks llm-agent
(``/api/agent-db/outbound-authorisation``), because only the server can see the
egress trunk's operator filter and the organisation's rating deck. What is pinned
here is that every transfer path consults it, that it FAILS CLOSED, and that the
registration-egress discriminator is reported correctly (a leg leaving via the
customer's own B2BUA is never on our carrier).
"""

from __future__ import annotations

import asyncio

from pipecat_aplisay import api_client, outbound_filter
from pipecat_aplisay.call_session import CallSession

REG_UUID = "11111111-1111-4111-8111-111111111111"

AGENT = {
    "id": "agent-1",
    "modelName": "pipecat:openai/gpt-4o",
    "organisationId": "org-1",
    "userId": "user-1",
    "options": {"outboundCallFilter": "^\\+44\\d+$"},
}


def _session(**kwargs) -> CallSession:
    call = api_client.CallRecord(
        id="call-1", userId="user-1", organisationId="org-1",
        instanceId="inst-1", agentId="agent-1", persisted=False,
    )

    class _StubGatewaySession:
        transport = None

        async def shutdown(self) -> None:  # pragma: no cover
            return None

    return CallSession(
        session_id="s1",
        agent=dict(AGENT),
        instance={"streamLog": False},
        sip_gateway=None,  # type: ignore[arg-type]
        gateway_session=_StubGatewaySession(),  # type: ignore[arg-type]
        call=call,
        **kwargs,
    )


def _patch_authorisation(monkeypatch, *, response=None, raises=None):
    """Capture the request the worker makes, and script the platform's answer."""
    seen: dict = {}

    async def fake(**kwargs):
        seen.update(kwargs)
        if raises is not None:
            raise raises
        return response

    monkeypatch.setattr(api_client, "authorise_outbound_destination", fake)
    return seen


class TestAuthoriseDestination:
    """The thin client in outbound_filter.py."""

    def test_allows_when_platform_allows(self, monkeypatch) -> None:
        seen = _patch_authorisation(monkeypatch, response={
            "allowed": True, "code": "ok", "reason": None,
            "chargeable": True, "trunkId": "public", "destination": "+447700900123",
        })
        decision = asyncio.run(outbound_filter.authorise_destination(
            number="+447700900123", agent=AGENT, aplisay_id="trunk-a",
        ))
        assert decision.allowed is True
        assert decision.chargeable is True
        assert seen["called_id"] == "+447700900123"
        assert seen["organisation_id"] == "org-1"
        assert seen["agent_options"] == AGENT["options"]
        assert seen["registration_originated"] is False

    def test_refusal_carries_the_platform_reason(self, monkeypatch) -> None:
        _patch_authorisation(monkeypatch, response={
            "allowed": False, "code": "not_rateable",
            "reason": "destination +8801700000000 is not rated for this organisation",
            "chargeable": True, "trunkId": "public", "destination": "+8801700000000",
        })
        decision = asyncio.run(outbound_filter.authorise_destination(
            number="+8801700000000", agent=AGENT,
        ))
        assert decision.allowed is False
        assert decision.code == "not_rateable"
        assert "not rated" in decision.failure_message

    def test_fails_closed_when_the_platform_is_unreachable(self, monkeypatch) -> None:
        _patch_authorisation(monkeypatch, raises=RuntimeError("connection refused"))
        decision = asyncio.run(outbound_filter.authorise_destination(
            number="+447700900123", agent=AGENT,
        ))
        assert decision.allowed is False
        assert decision.code == "unavailable"

    def test_empty_destination_never_reaches_the_platform(self, monkeypatch) -> None:
        seen = _patch_authorisation(monkeypatch, response={"allowed": True, "code": "ok"})
        decision = asyncio.run(outbound_filter.authorise_destination(number="  ", agent=AGENT))
        assert decision.allowed is False
        assert decision.code == "invalid_destination"
        assert seen == {}

    def test_registration_egress_is_reported_as_not_our_carrier(self, monkeypatch) -> None:
        seen = _patch_authorisation(monkeypatch, response={"allowed": True, "code": "ok"})
        asyncio.run(outbound_filter.authorise_destination(
            number="8092", agent=AGENT, registration_endpoint_id=REG_UUID,
        ))
        assert seen["registration_originated"] is True


class TestTransferGate:
    """_on_transfer refuses before any dialling happens."""

    def test_refused_transfer_never_reaches_the_gateway(self, monkeypatch) -> None:
        _patch_authorisation(monkeypatch, response={
            "allowed": False, "code": "trunk_filter",
            "reason": "destination +9098790123 is not permitted on this outbound trunk",
            "chargeable": True, "trunkId": "public", "destination": "+449098790123",
        })
        session = _session()
        dialled: list = []

        async def _explode(*args, **kwargs):  # pragma: no cover - must not run
            dialled.append(args)
            raise AssertionError("gateway must not be asked to dial a refused destination")

        session.gateway_session.transfer = _explode  # type: ignore[attr-defined]

        result = asyncio.run(session._on_transfer({"number": "09098790123", "operation": "blind"}))
        assert result["status"] == "FAILED"
        assert "not permitted" in result["reason"]
        assert session.transfer_state.state == "failed"
        assert dialled == []

    def test_webrtc_transfer_is_gated_too(self, monkeypatch) -> None:
        """The WebRTC (media-relay) paths branch off inside _on_transfer, so the
        gate has to sit ahead of that branch — pin it."""
        _patch_authorisation(monkeypatch, response={
            "allowed": False, "code": "agent_filter",
            "reason": "destination +18005550199 does not match the agent's outbound call filter",
            "chargeable": False, "trunkId": None, "destination": "+18005550199",
        })
        session = _session()
        session.is_webrtc_origin = True

        result = asyncio.run(session._on_transfer({"number": "+18005550199"}))
        assert result["status"] == "FAILED"
        assert "outbound call filter" in result["reason"]

    def test_a_registration_uuid_caller_id_marks_the_leg_off_carrier(self, monkeypatch) -> None:
        """A callerId that is a registration UUID means the leg egresses the
        customer's own B2BUA, so the chargeable-trunk policy must not be applied
        to it. Ownership of that registration is enforced separately by
        _resolve_webrtc_egress, so a bogus UUID buys nothing."""
        seen = _patch_authorisation(monkeypatch, response={
            "allowed": False, "code": "agent_filter", "reason": "nope",
            "chargeable": False, "trunkId": None, "destination": None,
        })
        session = _session()
        asyncio.run(session._on_transfer({"number": "8092", "callerId": REG_UUID}))
        assert seen["registration_originated"] is True
        # No point asking the platform to resolve an egress trunk for a leg that
        # does not use one.
        assert seen["caller_id"] is None

    def test_an_e164_caller_id_is_forwarded_for_trunk_resolution(self, monkeypatch) -> None:
        """A WebRTC-origin transfer routes on its tool-supplied callerId, so the
        platform needs it to find the egress trunk (and hence whether the
        chargeable-trunk policy applies)."""
        seen = _patch_authorisation(monkeypatch, response={
            "allowed": False, "code": "trunk_filter", "reason": "nope",
            "chargeable": True, "trunkId": "public", "destination": None,
        })
        session = _session()
        session.is_webrtc_origin = True
        asyncio.run(session._on_transfer({"number": "+18005550199", "callerId": "+442080996945"}))
        assert seen["caller_id"] == "+442080996945"
        assert seen["registration_originated"] is False
