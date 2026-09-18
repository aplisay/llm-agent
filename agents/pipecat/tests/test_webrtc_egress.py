"""Tests for WebRTC-origin transfer egress tenant-ownership enforcement.

A browser (WebRTC) call has no inbound trunk, so an agent-initiated transfer
must carry its own outbound routing via an LLM/tool-supplied ``callerId``. That
``callerId`` is either a registration-endpoint UUID or an E.164 number, and the
worker resolves it to a B2BUA gateway / egress trunk in
``CallSession._resolve_webrtc_egress``.

The security property under test: a WebRTC session may only egress using a
registration or number owned by *its own agent's organisation*. Previously the
org check on the E.164 branch was log-only and the registration branch had no
check at all, so a session could dial out using another tenant's registration
credentials / trunk. These tests pin the hard-reject behaviour.
"""

from __future__ import annotations

import asyncio

import pytest

from pipecat_aplisay import api_client
from pipecat_aplisay.call_session import (
    CallSession,
    _WebrtcEgress,
    _WebrtcEgressError,
    _org_owns,
)

# Valid UUID (version 4, variant 8) so it matches the registration-endpoint
# discriminator regex ``_UUID_RE`` in call_session.
REG_UUID = "11111111-1111-4111-8111-111111111111"
NUMBER = "442080996945"


def _session(agent_org: str = "org-1", agent_user: str = "user-1") -> CallSession:
    """Build a minimal CallSession whose agent belongs to ``agent_org``.

    Only ``self.agent`` (organisationId / userId) is consulted by
    ``_resolve_webrtc_egress``; the other collaborators are inert stubs.
    """
    call = api_client.CallRecord(
        id="call-1",
        userId=agent_user,
        organisationId=agent_org,
        instanceId="inst-1",
        agentId="agent-1",
        persisted=False,
    )

    class _StubGatewaySession:
        transport = None

        async def shutdown(self) -> None:  # pragma: no cover
            return None

    return CallSession(
        session_id="s1",
        agent={
            "id": "agent-1",
            "modelName": "pipecat:openai/gpt-4o",
            "organisationId": agent_org,
            "userId": agent_user,
        },
        instance={"streamLog": False},
        sip_gateway=None,  # type: ignore[arg-type]
        gateway_session=_StubGatewaySession(),  # type: ignore[arg-type]
        call=call,
    )


def _patch_endpoint_by_id(monkeypatch, reg) -> None:
    async def fake(_endpoint_id: str):
        return reg

    monkeypatch.setattr(api_client, "get_phone_endpoint_by_id", fake)


def _patch_number(monkeypatch, row) -> None:
    async def fake(_number: str, trunk_id=None):
        return row

    monkeypatch.setattr(api_client, "get_phone_endpoint_by_number", fake)


class TestOrgOwns:
    """The conservative org-ownership predicate (mirrors lib/scope.js)."""

    def test_match(self) -> None:
        assert _org_owns({"organisationId": "o1"}, "o1") is True

    def test_mismatch(self) -> None:
        assert _org_owns({"organisationId": "o1"}, "o2") is False

    def test_null_agent_org(self) -> None:
        assert _org_owns({"organisationId": None}, "o1") is False

    def test_null_row_org(self) -> None:
        assert _org_owns({"organisationId": "o1"}, None) is False

    def test_both_null_never_matches(self) -> None:
        # The crux: a no-org agent must not own a no-org row by coincidence.
        assert _org_owns({"organisationId": None}, None) is False

    def test_missing_key(self) -> None:
        assert _org_owns({}, "o1") is False

    def test_empty_string_orgs(self) -> None:
        assert _org_owns({"organisationId": ""}, "") is False


class TestRegistrationBranch:
    def _reg(self, org: str) -> dict:
        return {
            "id": REG_UUID,
            "outbound": True,
            "organisationId": org,
            "username": "8092",
            "b2buaId": "10.0.0.1",
            "options": {"transport": "tcp"},
        }

    def test_owned_registration_resolves(self, monkeypatch) -> None:
        _patch_endpoint_by_id(monkeypatch, self._reg("org-1"))
        session = _session(agent_org="org-1")
        egress = asyncio.run(session._resolve_webrtc_egress({"callerId": REG_UUID}))
        assert isinstance(egress, _WebrtcEgress)
        assert egress.registration_endpoint_id == REG_UUID
        assert egress.caller_id == "8092"
        assert egress.b2bua_gateway_ip == "10.0.0.1"
        assert egress.b2bua_gateway_transport == "tcp"

    def test_cross_tenant_registration_rejected(self, monkeypatch) -> None:
        # Registration belongs to org-2 but the agent is org-1.
        _patch_endpoint_by_id(monkeypatch, self._reg("org-2"))
        session = _session(agent_org="org-1")
        with pytest.raises(_WebrtcEgressError) as exc:
            asyncio.run(session._resolve_webrtc_egress({"callerId": REG_UUID}))
        assert "not owned" in str(exc.value)

    def test_no_org_agent_cannot_use_registration(self, monkeypatch) -> None:
        _patch_endpoint_by_id(monkeypatch, self._reg("org-2"))
        session = _session(agent_org="org-1")
        # A no-org agent owns no registration; null org must never coincidentally
        # match. (CallRecord.organisationId is a required str, so we null the
        # agent dict directly — that's the only field the egress check reads.)
        session.agent["organisationId"] = None
        with pytest.raises(_WebrtcEgressError):
            asyncio.run(session._resolve_webrtc_egress({"callerId": REG_UUID}))

    def test_registration_not_outbound_rejected(self, monkeypatch) -> None:
        reg = self._reg("org-1")
        reg["outbound"] = False
        _patch_endpoint_by_id(monkeypatch, reg)
        session = _session(agent_org="org-1")
        with pytest.raises(_WebrtcEgressError) as exc:
            asyncio.run(session._resolve_webrtc_egress({"callerId": REG_UUID}))
        assert "outbound" in str(exc.value)

    def test_unknown_registration_rejected(self, monkeypatch) -> None:
        _patch_endpoint_by_id(monkeypatch, None)
        session = _session(agent_org="org-1")
        with pytest.raises(_WebrtcEgressError) as exc:
            asyncio.run(session._resolve_webrtc_egress({"callerId": REG_UUID}))
        assert "not found" in str(exc.value)


class TestE164Branch:
    def _row(self, org, *, instance_id=None, outbound=True, aplisay="trunk-1") -> dict:
        return {
            "number": NUMBER,
            "outbound": outbound,
            "organisationId": org,
            "aplisayId": aplisay,
            "instanceId": instance_id,
        }

    def test_directly_owned_number_resolves(self, monkeypatch) -> None:
        _patch_number(monkeypatch, self._row("org-1"))
        session = _session(agent_org="org-1")
        egress = asyncio.run(session._resolve_webrtc_egress({"callerId": NUMBER}))
        assert egress.caller_id == NUMBER
        assert egress.aplisay_id == "trunk-1"
        assert egress.registration_endpoint_id is None

    def test_cross_tenant_number_rejected(self, monkeypatch) -> None:
        # Owned by org-2, no bound instance to claim ownership through.
        _patch_number(monkeypatch, self._row("org-2"))
        session = _session(agent_org="org-1")
        with pytest.raises(_WebrtcEgressError) as exc:
            asyncio.run(session._resolve_webrtc_egress({"callerId": NUMBER}))
        assert "not owned" in str(exc.value)

    def test_pool_number_claimed_via_owned_instance(self, monkeypatch) -> None:
        # Pool number (org NULL) is claimable transitively through its bound
        # listener Instance, when that instance belongs to the agent's org.
        _patch_number(monkeypatch, self._row(None, instance_id="inst-9"))

        async def fake_instance(_iid: str):
            return {"Agent": {"organisationId": "org-1", "userId": "user-x"}}

        monkeypatch.setattr(api_client, "get_instance_by_id", fake_instance)
        session = _session(agent_org="org-1")
        egress = asyncio.run(session._resolve_webrtc_egress({"callerId": NUMBER}))
        assert egress.aplisay_id == "trunk-1"

    def test_pool_number_via_foreign_instance_rejected(self, monkeypatch) -> None:
        _patch_number(monkeypatch, self._row(None, instance_id="inst-9"))

        async def fake_instance(_iid: str):
            return {"Agent": {"organisationId": "org-2", "userId": "user-z"}}

        monkeypatch.setattr(api_client, "get_instance_by_id", fake_instance)
        session = _session(agent_org="org-1")
        with pytest.raises(_WebrtcEgressError) as exc:
            asyncio.run(session._resolve_webrtc_egress({"callerId": NUMBER}))
        assert "not owned" in str(exc.value)

    def test_instance_lookup_failure_fails_closed(self, monkeypatch) -> None:
        _patch_number(monkeypatch, self._row(None, instance_id="inst-9"))

        async def boom(_iid: str):
            raise RuntimeError("agent-db unreachable")

        monkeypatch.setattr(api_client, "get_instance_by_id", boom)
        session = _session(agent_org="org-1")
        with pytest.raises(_WebrtcEgressError) as exc:
            asyncio.run(session._resolve_webrtc_egress({"callerId": NUMBER}))
        assert "could not verify ownership" in str(exc.value)

    def test_not_outbound_rejected(self, monkeypatch) -> None:
        _patch_number(monkeypatch, self._row("org-1", outbound=False))
        session = _session(agent_org="org-1")
        with pytest.raises(_WebrtcEgressError) as exc:
            asyncio.run(session._resolve_webrtc_egress({"callerId": NUMBER}))
        assert "outbound" in str(exc.value)

    def test_unknown_number_rejected(self, monkeypatch) -> None:
        _patch_number(monkeypatch, None)
        session = _session(agent_org="org-1")
        with pytest.raises(_WebrtcEgressError):
            asyncio.run(session._resolve_webrtc_egress({"callerId": NUMBER}))


def test_missing_caller_id_rejected() -> None:
    session = _session()
    with pytest.raises(_WebrtcEgressError) as exc:
        asyncio.run(session._resolve_webrtc_egress({}))
    assert "callerId is required" in str(exc.value)


class TestRegistrationTrunkNumber:
    """A number on a REGISTRATION trunk egresses through that registration's
    B2BUA, presenting the number and keeping its trunk id."""

    def _row(self, org, reg_id=REG_UUID):
        return {
            "number": NUMBER,
            "outbound": True,
            "organisationId": org,
            "aplisayId": f"reg-{reg_id}",
            "instanceId": None,
            "trunk": {"id": f"reg-{reg_id}", "outbound": True, "flags": {"provider": "registration", "registrationId": reg_id}},
        }

    def test_registration_trunk_number_dials_the_b2bua(self, monkeypatch) -> None:
        _patch_number(monkeypatch, self._row("org-1"))
        _patch_endpoint_by_id(monkeypatch, {"id": REG_UUID, "b2buaId": "203.0.113.10", "options": {"transport": "tls"}})
        session = _session(agent_org="org-1")
        egress = asyncio.run(session._resolve_webrtc_egress({"callerId": NUMBER}))
        assert egress.caller_id == NUMBER
        assert egress.aplisay_id == f"reg-{REG_UUID}"
        assert egress.registration_endpoint_id == REG_UUID
        assert egress.b2bua_gateway_ip == "203.0.113.10"
        assert egress.b2bua_gateway_transport == "tls"

    def test_registration_trunk_not_held_is_rejected(self, monkeypatch) -> None:
        _patch_number(monkeypatch, self._row("org-1"))
        _patch_endpoint_by_id(monkeypatch, {"id": REG_UUID, "b2buaId": None, "options": {}})
        session = _session(agent_org="org-1")
        with pytest.raises(_WebrtcEgressError) as exc:
            asyncio.run(session._resolve_webrtc_egress({"callerId": NUMBER}))
        assert "not held by a SIP node" in str(exc.value)

    def test_a_plain_trunk_number_is_unchanged(self, monkeypatch) -> None:
        row = self._row("org-1")
        row["aplisayId"] = "trunk-1"
        row["trunk"] = {"id": "trunk-1", "outbound": True, "flags": {"canRefer": True}}
        _patch_number(monkeypatch, row)
        session = _session(agent_org="org-1")
        egress = asyncio.run(session._resolve_webrtc_egress({"callerId": NUMBER}))
        assert egress.registration_endpoint_id is None
        assert egress.aplisay_id == "trunk-1"
