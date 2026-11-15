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


def test_dispatch_a_call_in_that_carries_our_app_id_is_not_ours_either(make_gateway):
    # The id on a call in comes from a header its sender chose.
    gateway = make_gateway("dispatch")
    asyncio.run(gateway._handle_vsi_event({**RINGING, "app_id": gateway.app_id}))
    assert gateway.resolved == []
    assert gateway.calls == []


@pytest.mark.parametrize("mode", [None, "events"])
def test_events_a_ringing_call_in_is_still_answered(make_gateway, mode):
    gateway = make_gateway(mode)
    asyncio.run(gateway._handle_vsi_event(dict(RINGING)))
    assert len(gateway.resolved) == 1
    assert [(method, path) for method, path, _ in gateway.calls] == [
        ("POST", "/v1/legs/leg-9/answer"),
        ("POST", "/v1/legs/leg-9/agent/pipecat"),
    ]


# ---- what the worker hears ---------------------------------------------------


def test_the_event_stream_is_filtered_by_app_id_only_in_events_mode(make_gateway):
    assert make_gateway(None)._vsi_url() == "ws://voiceblender:8080/v1/vsi?app_id=aplisay-pipecat"
    assert make_gateway("dispatch")._vsi_url() == "ws://voiceblender:8080/v1/vsi"


def test_dispatch_events_of_legs_that_are_not_ours_do_nothing(make_gateway):
    gateway = make_gateway("dispatch")

    async def run():
        for event_type in (
            "leg.ringing",
            "leg.connected",
            "leg.disconnected",
            "dtmf.received",
            "leg.transfer_requested",
            "stt.text",
            "room.created",
        ):
            await gateway._handle_vsi_event(
                {
                    "type": event_type,
                    "leg_id": "someone-elses-leg",
                    "leg_type": "sip_outbound",
                    "digit": "1",
                    "text": "hi",
                }
            )

    asyncio.run(run())
    assert gateway.calls == []
    assert gateway.resolved == []


def test_rooms_the_worker_makes_carry_its_app_id(make_gateway):
    gateway = make_gateway("dispatch")
    session = _VbGatewaySession(transport=None, session_id="s", leg_id="leg-a", _gateway=gateway)
    asyncio.run(session._bridge_legs("leg-a", "leg-b"))
    method, path, body = gateway.calls[0]
    assert (method, path) == ("POST", "/v1/rooms")
    assert body["app_id"] == "aplisay-pipecat"
    # Call control names its rooms "pbx-…", and deleting a room hangs up the
    # legs in it: the worker's rooms must not look like those.
    assert body["id"].startswith("bridge-")
