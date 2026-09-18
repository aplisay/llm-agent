"""The inbound instance lookup ladder resolves by (number, trunk) or not at all.

Pins the removal of the bare-number rung: after the trunk-qualified lookup
finds nothing (404) or finds a number with no agent, the ladder stops. It
must never re-ask for the number without the trunk, because that answer
could belong to a different trunk entirely.
"""

from __future__ import annotations

import asyncio

import pytest

from pipecat_aplisay import api_client, worker


def _run(**kwargs):
    return asyncio.run(worker._lookup_instance_for_inbound(**kwargs))


def _install(monkeypatch, *, by_id=None, by_number=None, instance_by_id=None, calls=None):
    calls = calls if calls is not None else []

    async def fake_by_id(reg_id):
        calls.append(("by_id", reg_id))
        if by_id is None:
            raise api_client.ApiRequestError(404, {}, "not found")
        return by_id

    async def fake_by_number(number, trunk_id=None):
        calls.append(("by_number", number, trunk_id))
        if by_number is None:
            raise api_client.ApiRequestError(404, {}, "not found")
        return by_number

    async def fake_instance(instance_id):
        calls.append(("instance", instance_id))
        if instance_by_id is None:
            raise api_client.ApiRequestError(404, {}, "not found")
        return instance_by_id

    monkeypatch.setattr(api_client, "get_phone_endpoint_by_id", fake_by_id)
    monkeypatch.setattr(api_client, "get_phone_endpoint_by_number", fake_by_number)
    monkeypatch.setattr(api_client, "get_instance_by_id", fake_instance)
    return calls


def test_number_lookup_carries_the_trunk(monkeypatch):
    calls = _install(
        monkeypatch,
        by_number={"number": "445678", "instanceId": "i1", "trunk": {"flags": {"canRefer": True}}},
        instance_by_id={"id": "i1", "Agent": {"id": "a"}},
    )
    instance, origin = _run(phone_registration=None, to_number="445678", aplisay_id="tk")
    assert instance == {"id": "i1", "Agent": {"id": "a"}}
    assert ("by_number", "445678", "tk") in calls
    assert origin.force_refer_transfer is True


def test_no_bare_number_rung_after_a_404(monkeypatch):
    calls = _install(monkeypatch)  # everything 404s
    instance, _ = _run(phone_registration=None, to_number="445678", aplisay_id="tk")
    assert instance is None
    # Exactly one number lookup, and it was trunk-qualified.
    assert [c for c in calls if c[0] == "by_number"] == [("by_number", "445678", "tk")]


def test_no_bare_number_rung_when_the_number_has_no_agent(monkeypatch):
    calls = _install(monkeypatch, by_number={"number": "445678", "instanceId": None})
    instance, _ = _run(phone_registration=None, to_number="445678", aplisay_id="tk")
    assert instance is None
    assert [c for c in calls if c[0] == "by_number"] == [("by_number", "445678", "tk")]
    assert not [c for c in calls if c[0] == "instance"]


def test_registration_without_an_agent_falls_through_to_trunk_and_number(monkeypatch):
    calls = _install(
        monkeypatch,
        by_id={"id": "reg-1", "instanceId": None, "username": "8092"},
        by_number={"number": "445678", "instanceId": "i2"},
        instance_by_id={"id": "i2", "Agent": {"id": "a"}},
    )
    instance, origin = _run(phone_registration="reg-1", to_number="445678", aplisay_id="tk")
    assert instance == {"id": "i2", "Agent": {"id": "a"}}
    assert ("by_number", "445678", "tk") in calls
    assert origin.registration_originated is False


def test_a_trunk_mismatch_is_not_absorbed(monkeypatch):
    async def fake_by_number(number, trunk_id=None):
        raise api_client.ApiRequestError(400, {}, "Trunk mismatch")

    monkeypatch.setattr(api_client, "get_phone_endpoint_by_number", fake_by_number)
    with pytest.raises(api_client.ApiRequestError):
        _run(phone_registration=None, to_number="445678", aplisay_id="tk")


def test_bare_number_client_helper_is_gone():
    assert not hasattr(api_client, "get_instance_by_number")
