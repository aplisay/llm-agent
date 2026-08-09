"""Voiceblender inbound agent resolution — field-name + origin threading.

Pins the fix for the `sip_headers` vs `custom_headers` misnomer: voiceblender's
`leg.ringing` VSI event carries the INVITE's routing headers in `sip_headers`
(`LegRingingData.SIPHeaders` in the voiceblender source), NOT `custom_headers`.
The resolver must read `sip_headers` and thread the resolved `_InboundOrigin`
back so `_on_leg_ringing` can stamp the transfer-mode context onto the inbound
`InboundCallContext` (mirroring the sipbridge resolver).
"""

from __future__ import annotations

import asyncio

import pytest

from pipecat_aplisay import worker


def test_resolver_reads_sip_headers_and_returns_origin(monkeypatch):
    captured: dict = {}
    origin = worker._InboundOrigin(
        registration_originated=True,
        force_bridged_transfer=True,
        registration_username="8092",
    )

    async def fake_lookup(*, phone_registration, to_number, aplisay_id):
        captured.update(
            phone_registration=phone_registration,
            to_number=to_number,
            aplisay_id=aplisay_id,
        )
        return {"id": "i", "Agent": {"id": "a"}}, origin

    monkeypatch.setattr(worker, "_lookup_instance_for_inbound", fake_lookup)

    event = {
        "to": "+445678",
        "sip_headers": {"X-Aplisay-Trunk": "tk", "X-Aplisay-PhoneRegistration": "reg-1"},
        # A stale `custom_headers` MUST be ignored — it is not the real field.
        "custom_headers": {"X-Aplisay-Trunk": "WRONG", "X-Aplisay-PhoneRegistration": "WRONG"},
    }
    result = asyncio.run(worker._voiceblender_resolve_agent(event))

    assert result is not None
    instance, agent, out_origin = result
    # Read from sip_headers, not custom_headers.
    assert captured == {
        "phone_registration": "reg-1",
        "to_number": "+445678",
        "aplisay_id": "tk",
    }
    # Origin is threaded back (was previously discarded).
    assert out_origin is origin
    assert agent == {"id": "a"}


def test_resolver_returns_none_when_no_instance(monkeypatch):
    async def fake_lookup(**_kwargs):
        return None, worker._InboundOrigin()

    monkeypatch.setattr(worker, "_lookup_instance_for_inbound", fake_lookup)
    result = asyncio.run(
        worker._voiceblender_resolve_agent({"to": "+445678", "sip_headers": {}})
    )
    assert result is None


def test_resolver_returns_none_when_instance_has_no_agent(monkeypatch):
    async def fake_lookup(**_kwargs):
        return {"id": "i"}, worker._InboundOrigin()  # no "Agent"

    monkeypatch.setattr(worker, "_lookup_instance_for_inbound", fake_lookup)
    result = asyncio.run(
        worker._voiceblender_resolve_agent({"to": "+445678", "sip_headers": {}})
    )
    assert result is None
