"""X-Aplisay-Called carries the dialled number for a registration trunk.

The B2BUA forwards a trunk's inbound call with the dialled number in
X-Aplisay-Called (and, on this runtime, the Request-URI). The header wins
over the event's own `to` when both are present, and the plain `to` still
serves when it is absent.
"""

from __future__ import annotations

import asyncio

from pipecat_aplisay import worker


def _capture(monkeypatch):
    captured: dict = {}

    async def fake_lookup(*, phone_registration, to_number, aplisay_id):
        captured.update(phone_registration=phone_registration, to_number=to_number, aplisay_id=aplisay_id)
        return {"id": "i", "Agent": {"id": "a"}}, worker._InboundOrigin()

    monkeypatch.setattr(worker, "_lookup_instance_for_inbound", fake_lookup)
    return captured


def test_voiceblender_prefers_the_called_header(monkeypatch):
    captured = _capture(monkeypatch)
    event = {
        "to": "00000",
        "sip_headers": {"X-Aplisay-Trunk": "reg-abc", "X-Aplisay-PhoneRegistration": "abc", "X-Aplisay-Called": "+442079460100"},
    }
    asyncio.run(worker._voiceblender_resolve_agent(event))
    assert captured["to_number"] == "+442079460100"
    assert captured["aplisay_id"] == "reg-abc"
    assert captured["phone_registration"] == "abc"


def test_voiceblender_falls_back_to_the_event_to(monkeypatch):
    captured = _capture(monkeypatch)
    asyncio.run(worker._voiceblender_resolve_agent({"to": "+445678", "sip_headers": {"X-Aplisay-Trunk": "tk"}}))
    assert captured["to_number"] == "+445678"
