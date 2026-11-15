"""``VOICEBLENDER_INBOUND``: who acts on a ringing call in.

``events`` (the default): the gateway, as before. ``dispatch``: call control,
which sits in front of the engine and hands each call to the worker. Then the
gateway does nothing on an inbound ``leg.ringing``, and it listens to every
event because a leg it is handed does not carry its app id.
"""

from __future__ import annotations

import asyncio
import types

import pytest

from pipecat_aplisay.sip_gateway.voiceblender_gateway import (
    VoiceblenderSipGateway,
    _VbGatewaySession,
)

RINGING = {
    "type": "leg.ringing",
    "leg_id": "leg-9",
    "leg_type": "sip_inbound",
    "from": "+441234",
    "to": "+445678",
    "sip_headers": {"X-Aplisay-Trunk": "tk-1"},
}
ORIGIN = types.SimpleNamespace(
    registration_originated=False,
    force_refer_transfer=None,
    force_bridged_transfer=None,
    registration_username=None,
)


@pytest.fixture
def make_gateway(monkeypatch):
    def make(mode):
        if mode is None:
            monkeypatch.delenv("VOICEBLENDER_INBOUND", raising=False)
        else:
            monkeypatch.setenv("VOICEBLENDER_INBOUND", mode)
        gateway = VoiceblenderSipGateway()
        gateway.calls = []
        gateway.resolved = []

        async def call_api(method, path, body, *, raise_on_error=True):
            gateway.calls.append((method, path, body))
            return None

        async def resolve(event):
            gateway.resolved.append(event)
            return {"id": "inst-1"}, {"id": "agent-1"}, ORIGIN

        monkeypatch.setattr(gateway, "_call_api", call_api)
        gateway.set_agent_resolver(resolve)
        return gateway

    return make


def test_the_default_is_events(make_gateway):
    assert make_gateway(None).inbound_mode == "events"
    assert make_gateway(" Dispatch ").inbound_mode == "dispatch"


def test_an_unknown_setting_stops_the_worker(monkeypatch):
    monkeypatch.setenv("VOICEBLENDER_INBOUND", "sometimes")
    with pytest.raises(RuntimeError, match="VOICEBLENDER_INBOUND"):
        VoiceblenderSipGateway()


def test_dispatch_a_ringing_call_in_causes_no_call_to_the_engine(make_gateway):
    gateway = make_gateway("dispatch")
    asyncio.run(gateway._handle_vsi_event(dict(RINGING)))
    # No lookup, no answer and no reject.
    assert gateway.resolved == []
    assert gateway.calls == []
    assert gateway.pending_attaches == {}


@pytest.mark.parametrize("mode", [None, "events"])
def test_events_a_ringing_call_in_is_still_answered(make_gateway, mode):
    gateway = make_gateway(mode)
    asyncio.run(gateway._handle_vsi_event(dict(RINGING)))
    assert len(gateway.resolved) == 1
    assert [(method, path) for method, path, _ in gateway.calls] == [
        ("POST", "/v1/legs/leg-9/answer"),
        ("POST", "/v1/legs/leg-9/agent/pipecat"),
    ]
