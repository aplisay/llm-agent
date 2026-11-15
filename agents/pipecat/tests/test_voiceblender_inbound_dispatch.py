"""The worker behind call control (``VOICEBLENDER_INBOUND=dispatch``).

Call control owns every ringing call in and hands a leg over with
``POST /dispatch``, ``kind: "inbound"``. Pinned here:

  - the replies (200, 400, 401, 404, 409, 503) and that a refusal sends the
    engine nothing but a read. 409 is kept for a leg the worker may hold:
    call control waits such a reply out, and acts on a 404 at once;
  - the reply goes out before the leg is answered, and no answer is sent
    after the time limit;
  - a repeat of one ``handoffId`` gets the same answer and has no second effect;
  - with the setting off, a hand-over is refused.

``test_voiceblender_inbound_mode.py`` has the setting itself.
"""

from __future__ import annotations

import asyncio
import types

import httpx
import pytest

from pipecat_aplisay import api_client, drain, worker
from pipecat_aplisay.sip_gateway.voiceblender_gateway import (
    INBOUND_DISPATCH,
    VoiceblenderSipGateway,
)

TOKEN = "test-dispatch-token"
AUTH = {"authorization": f"Bearer {TOKEN}"}

INSTANCE = {
    "id": "inst-1",
    "metadata": {},
    "Agent": {"id": "agent-1", "organisationId": "org-1", "userId": "u", "modelName": "m"},
}
EVENT = {
    "from": "+441234",
    "to": "+445678",
    "from_display_name": "Alice Smith",
    "sip_headers": {"X-Aplisay-Trunk": "tk-1", "X-Custom": "v"},
}


def _payload(**over):
    body = {
        "kind": "inbound",
        "handoffId": "h-1",
        "callId": "cc-1",
        "legId": "leg-1",
        "instanceId": "inst-1",
        "agentId": "agent-1",
        "organisationId": "org-1",
        "acceptWithinMs": 2000,
        "event": EVENT,
    }
    body.update(over)
    return body


class _Rig:
    """The worker's real app with a voiceblender gateway whose engine and
    llm-agent are fakes. ``timeline`` records what happened in order."""

    def __init__(self, monkeypatch, mode=INBOUND_DISPATCH):
        monkeypatch.setenv("PIPECAT_DISPATCH_TOKEN", TOKEN)
        if mode is None:
            monkeypatch.delenv("VOICEBLENDER_INBOUND", raising=False)
        else:
            monkeypatch.setenv("VOICEBLENDER_INBOUND", mode)
        self.gateway = VoiceblenderSipGateway()
        self.timeline: list = []
        self.leg = {"id": "leg-1", "type": "sip_inbound", "state": "ringing"}
        self.instance = INSTANCE
        self.origin = worker._InboundOrigin(force_refer_transfer=True)
        self.lookup_instance = INSTANCE
        self.lookup_delay = 0.0
        self.answer_error = None

        async def call_api(method, path, body, *, raise_on_error=True):
            self.timeline.append((method, path))
            if path.endswith("/answer") and self.answer_error:
                raise RuntimeError(self.answer_error)
            return None

        async def read_leg(leg_id):
            if isinstance(self.leg, Exception):
                raise self.leg
            return self.leg

        async def get_instance(instance_id):
            await asyncio.sleep(self.lookup_delay)
            if isinstance(self.instance, Exception):
                raise self.instance
            return self.instance

        async def lookup(*, phone_registration, to_number, aplisay_id):
            self.lookup_keys = (phone_registration, to_number, aplisay_id)
            if isinstance(self.lookup_instance, Exception):
                raise self.lookup_instance
            return self.lookup_instance, self.origin

        monkeypatch.setattr(self.gateway, "_call_api", call_api)
        monkeypatch.setattr(self.gateway, "read_leg", read_leg)
        monkeypatch.setattr(api_client, "get_instance_by_id", get_instance)
        monkeypatch.setattr(worker, "_lookup_instance_for_inbound", lookup)

        state = worker.app.state
        monkeypatch.setattr(state, "sip_gateway", self.gateway, raising=False)
        monkeypatch.setattr(state, "live_calls", {}, raising=False)
        monkeypatch.setattr(state, "tasks", set(), raising=False)
        monkeypatch.setattr(state, "draining", False, raising=False)

    async def _app(self, scope, receive, send):
        async def noting(message):
            if message["type"] == "http.response.body":
                self.timeline.append("reply sent")
            await send(message)

        await worker.app(scope, receive, noting)

    def post(self, path="/dispatch", body=None, headers=AUTH, client=("127.0.0.1", 5555)):
        async def run():
            transport = httpx.ASGITransport(app=self._app, client=client)
            async with httpx.AsyncClient(transport=transport, base_url="http://worker") as http:
                response = await http.post(path, json=body, headers=headers)
            # Let the tasks the reply started finish.
            await asyncio.gather(*list(worker.app.state.tasks), return_exceptions=True)
            return response

        return asyncio.run(run())

    def engine_writes(self):
        return [step for step in self.timeline if step != "reply sent"]


@pytest.fixture
def rig(monkeypatch):
    return _Rig(monkeypatch)


# ---- accepted -------------------------------------------------------------


def test_accepted_replies_first_then_answers_and_attaches(rig):
    response = rig.post(body=_payload())

    assert response.status_code == 200
    body = response.json()
    assert body["accepted"] is True
    session_id = body["sessionId"]
    # Nothing is sent to the engine before the reply.
    assert rig.timeline[0] == "reply sent"
    assert rig.timeline[1] == ("POST", "/v1/legs/leg-1/answer")
    assert rig.timeline[2] == ("POST", "/v1/legs/leg-1/agent/pipecat")
    assert rig.gateway.holds_leg("leg-1")

    pending = rig.gateway.pending_attaches[session_id]
    assert pending.leg_id == "leg-1"
    # The instance the plan named, loaded by its id.
    assert pending.instance is INSTANCE and pending.agent is INSTANCE["Agent"]
    ctx = pending.inbound_ctx
    # The call's context is built from the event, as on leg.ringing.
    assert (ctx.caller_id, ctx.called_id, ctx.caller_id_name) == ("+441234", "+445678", "Alice Smith")
    assert ctx.aplisay_id == "tk-1"
    assert ctx.sip_headers == {"x-aplisay-trunk": "tk-1", "x-custom": "v"}
    assert ctx.call_control_id == "cc-1"
    # The transfer rules still come from the lookup by the event's headers.
    assert rig.lookup_keys == (None, "+445678", "tk-1")
    assert ctx.force_refer_transfer is True


def test_the_plan_wins_when_the_lookup_names_another_instance(rig):
    rig.lookup_instance = {"id": "inst-other", "Agent": {"id": "agent-other"}}
    response = rig.post(body=_payload())
    assert response.status_code == 200
    pending = rig.gateway.pending_attaches[response.json()["sessionId"]]
    assert pending.instance["id"] == "inst-1"


def test_a_lookup_that_finds_nothing_does_not_stop_the_call(rig):
    rig.lookup_instance = None
    rig.origin = worker._InboundOrigin()
    assert rig.post(body=_payload()).status_code == 200


def test_call_control_id_is_kept_in_the_call_metadata(monkeypatch):
    from pipecat_aplisay.call_session import setup_inbound_call
    from pipecat_aplisay.sip_gateway.base import InboundCallContext

    captured: dict = {}

    async def create_call(payload):
        captured.update(payload)
        return types.SimpleNamespace(id="call-1", metadata=payload.get("metadata"))

    async def start_call(call):
        return None

    class _Gateway:
        name = "voiceblender"

        async def setup_inbound(self, inbound, params):
            return types.SimpleNamespace(transport=None, session_id="s")

    monkeypatch.setattr(api_client, "create_call", create_call)
    monkeypatch.setattr(api_client, "start_call", start_call)
    agent = INSTANCE["Agent"]

    def metadata_for(ctx):
        asyncio.run(setup_inbound_call(_Gateway(), ctx, instance=INSTANCE, agent=agent))
        return captured["metadata"]["aplisay"]

    handed = InboundCallContext(session_id="s", called_id="t", caller_id="f", call_control_id="cc-1")
    assert metadata_for(handed)["callControlId"] == "cc-1"
    plain = InboundCallContext(session_id="s", called_id="t", caller_id="f")
    assert "callControlId" not in metadata_for(plain)


# ---- refused: the leg is not touched -------------------------------------


def _refused(rig, status, reason, **over):
    response = rig.post(body=_payload(**over))
    assert (response.status_code, response.json()) == (status, {"accepted": False, "reason": reason})
    assert rig.engine_writes() == []
    assert rig.gateway.pending_attaches == {}
    assert not rig.gateway.holds_leg("leg-1")


def test_404_no_such_instance(rig):
    rig.instance = api_client.ApiRequestError(404, {}, "not found")
    _refused(rig, 404, "instance_not_found")


def test_404_instance_with_no_agent(rig):
    rig.instance = {"id": "inst-1"}
    _refused(rig, 404, "agent_not_found")


def test_404_instance_of_another_organisation(rig):
    _refused(rig, 404, "instance_not_in_organisation", organisationId="org-2")


def test_404_leg_not_on_this_engine(rig):
    rig.leg = None
    _refused(rig, 404, "leg_not_on_this_engine")


@pytest.mark.parametrize(
    "leg",
    [
        {"type": "sip_inbound", "state": "connected"},
        {"type": "sip_inbound", "state": "hung_up"},
        {"type": "sip_outbound", "state": "ringing"},
    ],
)
def test_404_leg_that_is_not_a_ringing_call_in(rig, leg):
    rig.leg = leg
    _refused(rig, 404, "leg_not_ringing")


def test_409_leg_the_worker_already_holds(rig):
    rig.gateway._leg_to_session["leg-1"] = "vb-live"
    response = rig.post(body=_payload())
    assert (response.status_code, response.json()["reason"]) == (409, "leg_already_held")
    assert rig.engine_writes() == []


def test_409_a_second_handoff_for_a_leg_already_accepted(rig):
    assert rig.post(body=_payload()).status_code == 200
    writes = rig.engine_writes()
    response = rig.post(body=_payload(handoffId="h-2"))
    assert (response.status_code, response.json()["reason"]) == (409, "leg_already_held")
    assert rig.engine_writes() == writes


def test_503_stopping(rig):
    drained = rig.post(path="/drain")
    assert drained.json() == {"draining": True}
    _refused(rig, 503, "stopping")


def test_drain_is_taken_from_this_host_only(rig):
    response = rig.post(path="/drain", client=("10.108.3.4", 5555))
    assert response.status_code == 403
    assert worker.app.state.draining is False


def test_503_full(rig):
    worker.app.state.live_calls.update(
        {f"call-{i}": object() for i in range(worker.HEALTHZ_MAX_SESSIONS)}
    )
    _refused(rig, 503, "full")


def test_503_engine_not_reachable(rig):
    rig.leg = RuntimeError("connection refused")
    _refused(rig, 503, "engine_not_reachable")


def test_503_instance_lookup_failed(rig):
    rig.instance = api_client.ApiRequestError(502, {}, "bad gateway")
    _refused(rig, 503, "instance_lookup_failed")


def test_503_origin_lookup_failed(rig):
    rig.lookup_instance = api_client.ApiRequestError(500, {}, "server error")
    _refused(rig, 503, "origin_lookup_failed")


def test_503_not_ready_in_time(rig):
    # The limit is 80 ms and a quarter is kept back: a 200 ms lookup is too slow.
    rig.lookup_delay = 0.2
    _refused(rig, 503, "not_ready_in_time", acceptWithinMs=80)


def test_401_bad_or_missing_token(rig):
    for headers in ({}, {"authorization": "Bearer wrong"}):
        response = rig.post(body=_payload(), headers=headers)
        assert response.status_code == 401
    assert rig.timeline == ["reply sent", "reply sent"]


def test_400_missing_fields_and_unknown_kind(rig):
    assert rig.post(body=_payload(legId="")).status_code == 400
    assert rig.post(body={"kind": "inbound", "legId": "leg-1"}).status_code == 400
    assert rig.post(body={"kind": "sideways"}).status_code == 400
    assert rig.engine_writes() == []


# ---- the time limit --------------------------------------------------------


def test_no_answer_after_the_time_limit(rig):
    async def run():
        session_id = rig.gateway.accept_leg(
            leg_id="leg-1", event=EVENT, instance=INSTANCE, agent=INSTANCE["Agent"],
            origin=rig.origin, call_control_id="cc-1",
        )
        past = asyncio.get_running_loop().time() - 0.001
        await rig.gateway.take_leg("leg-1", session_id, answer_by=past)

    asyncio.run(run())
    # Not answered, and not rejected: call control may have moved the call on.
    assert rig.timeline == []
    assert rig.gateway.pending_attaches == {}
    assert not rig.gateway.holds_leg("leg-1")


def test_a_failed_answer_after_acceptance_ends_the_call(rig):
    rig.answer_error = "voiceblender POST /v1/legs/leg-1/answer -> 500 boom"
    response = rig.post(body=_payload())
    assert response.status_code == 200
    assert rig.engine_writes() == [
        ("POST", "/v1/legs/leg-1/answer"),
        ("DELETE", "/v1/legs/leg-1"),
    ]
    assert rig.gateway.pending_attaches == {}
    assert not rig.gateway.holds_leg("leg-1")


# ---- a repeat of one handoffId ------------------------------------------------


def test_a_repeat_gets_the_same_answer_and_has_no_second_effect(rig):
    first = rig.post(body=_payload())
    writes = rig.engine_writes()
    again = rig.post(body=_payload())
    assert (again.status_code, again.json()) == (200, first.json())
    assert rig.engine_writes() == writes
    assert len(rig.gateway.pending_attaches) == 1


def test_a_repeat_of_a_refusal_gets_the_same_refusal(rig):
    rig.leg = None
    first = rig.post(body=_payload())
    rig.leg = {"type": "sip_inbound", "state": "ringing"}
    again = rig.post(body=_payload())
    assert (again.status_code, again.json()) == (first.status_code, first.json()) == (
        404,
        {"accepted": False, "reason": "leg_not_on_this_engine"},
    )
    assert rig.engine_writes() == []


def test_a_repeat_that_arrives_while_the_first_is_decided(rig):
    rig.lookup_delay = 0.05

    async def run():
        transport = httpx.ASGITransport(app=rig._app, client=("127.0.0.1", 5555))
        async with httpx.AsyncClient(transport=transport, base_url="http://worker") as http:
            responses = await asyncio.gather(
                *(http.post("/dispatch", json=_payload(), headers=AUTH) for _ in range(3))
            )
        await asyncio.gather(*list(worker.app.state.tasks), return_exceptions=True)
        return responses

    responses = asyncio.run(run())
    assert {r.status_code for r in responses} == {200}
    assert len({r.json()["sessionId"] for r in responses}) == 1
    assert rig.engine_writes().count(("POST", "/v1/legs/leg-1/answer")) == 1


def test_old_answers_are_forgotten(rig):
    rig.post(body=_payload())

    async def sweep():
        for handoff in rig.gateway._handoffs.values():
            handoff.created_at -= 1000
        for pending in rig.gateway.pending_attaches.values():
            pending.created_at -= 1000
        rig.gateway._sweep_pending_once()

    asyncio.run(sweep())
    assert rig.gateway._handoffs == {}
    assert not rig.gateway.holds_leg("leg-1")


def test_a_handed_leg_is_released_when_it_ends(rig):
    response = rig.post(body=_payload())
    session_id = response.json()["sessionId"]

    async def run():
        # The engine's socket arrived: the session is live.
        rig.gateway.pending_attaches.pop(session_id)
        rig.gateway._leg_to_session["leg-1"] = session_id
        rig.gateway._session_to_leg[session_id] = "leg-1"
        await rig.gateway._handle_vsi_event({"type": "leg.disconnected", "leg_id": "leg-1"})

    asyncio.run(run())
    assert not rig.gateway.holds_leg("leg-1")


def test_setting_off_the_worker_refuses_a_handed_leg(monkeypatch):
    rig = _Rig(monkeypatch, mode="events")
    response = rig.post(body=_payload())
    assert (response.status_code, response.json()["reason"]) == (409, "inbound_dispatch_not_enabled")
    assert rig.engine_writes() == []


# ---- the preStop hook ---------------------------------------------------------


def _drain(readings, limit=60.0):
    said, now = [], [0.0]
    calls = iter(readings)

    def live_calls(base):
        value = next(calls)
        if isinstance(value, Exception):
            raise value
        return value

    posted = []
    result = drain.wait_for_calls(
        "http://worker",
        limit,
        post_drain=posted.append,
        live_calls=live_calls,
        sleep=lambda seconds: now.__setitem__(0, now[0] + seconds),
        clock=lambda: now[0],
        say=said.append,
    )
    return result, posted, now[0]


def test_the_hook_tells_the_worker_to_drain_then_waits_for_its_calls():
    assert _drain([2, 1, 0]) == ("empty", ["http://worker"], 10.0)


def test_the_hook_gives_up_at_the_limit():
    result, _, waited = _drain([1] * 100, limit=20.0)
    assert (result, waited) == ("deadline", 20.0)


def test_the_hook_does_not_wait_for_a_worker_that_has_gone():
    assert _drain([OSError("refused")])[0] == "no_reading"
