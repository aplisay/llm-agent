"""Route registered consult callbacks before inbound lookup; they are absent from the outbound registry. See PR #194.
Use parent metadata for callerId and the transfer target for calledId; see PRs #196 and #197."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from starlette.websockets import WebSocket

from pipecat_aplisay import api_client, worker
from pipecat_aplisay.call_session import TransferState
from pipecat_aplisay.sip_gateway.sipbridge_gateway import SipBridgeSipGateway


def _drive_handler(
    gateway: SipBridgeSipGateway,
    session_id: str,
    live_calls: dict | None = None,
) -> list[dict]:
    """Run ``sipbridge_agent`` against a scripted WS; return the frames it sent."""
    app = SimpleNamespace(
        state=SimpleNamespace(
            sip_gateway=gateway, live_calls=live_calls if live_calls is not None else {}
        )
    )
    scope = {
        "type": "websocket",
        "path": f"/sipbridge/agent/{session_id}",
        "headers": [],
        "app": app,
        # Advertise the ASGI WebSocket Denial Response extension (as uvicorn
        # does) so a denial shows up as an http.response.start frame.
        "extensions": {"websocket.http.response": {}},
    }
    incoming: list[dict] = [{"type": "websocket.connect"}]
    sent: list[dict] = []

    async def receive() -> dict:
        if incoming:
            return incoming.pop(0)
        return {"type": "websocket.disconnect", "code": 1006}

    async def send(message: dict) -> None:
        sent.append(message)

    ws = WebSocket(scope, receive=receive, send=send)
    asyncio.run(worker.sipbridge_agent(ws, session_id))
    return sent


def test_consult_session_ws_is_accepted_not_denied():
    """A registered consult session id must never hit inbound resolution."""
    gateway = SipBridgeSipGateway()
    session_id = "sb-consult-11111111-2222-3333-4444-555555555555"
    gateway.register_consult_session(
        consult_session_id=session_id,
        parent_session_id="parent-session",
        transfer_prompt_template="prompt",
        parent_transcript="transcript",
    )

    sent = _drive_handler(gateway, session_id)

    # Regression: this used to be a websocket.http.response.start with
    # status 404 ("no agent for dialled number").
    assert sent, "handler sent nothing"
    assert sent[0]["type"] == "websocket.accept"
    assert not any(m["type"] == "websocket.http.response.start" for m in sent)
    # With no live parent CallSession the handler closes 1011 and clears
    # the consult registration — that teardown is part of the contract.
    assert any(
        m["type"] == "websocket.close" and m.get("code") == 1011 for m in sent
    )
    assert gateway.consult_payload(session_id) is None


def test_unknown_session_ws_still_takes_inbound_path(monkeypatch):
    """No consult/outbound/takeover state → inbound resolution → 404 deny."""

    async def no_agent(_websocket):
        return None

    monkeypatch.setattr(worker, "_sipbridge_resolve_agent_from_headers", no_agent)

    sent = _drive_handler(SipBridgeSipGateway(), "unknown-inbound-call-id")

    assert sent, "handler sent nothing"
    assert sent[0]["type"] == "websocket.http.response.start"
    assert sent[0]["status"] == 404
    assert not any(m["type"] == "websocket.accept" for m in sent)


def test_consult_ws_reaches_run_session_with_metadata_caller_id(monkeypatch):
    """Use a real CallRecord to catch invalid callerId access; consult caller identity comes from parent metadata. See PR
    #196."""
    gateway = SipBridgeSipGateway()
    session_id = "sb-consult-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
    gateway.register_consult_session(
        consult_session_id=session_id,
        parent_session_id="parent-session",
        transfer_prompt_template="Consult prompt. ${parentTranscript}",
        parent_transcript="caller: hello",
        destination="443300889471",
    )

    parent_call = api_client.CallRecord(
        id="parent-call",
        userId="user-1",
        organisationId="org-1",
        instanceId="instance-1",
        agentId="agent-1",
        metadata={"aplisay": {"callerId": "07970939456", "calledId": "+441539454616"}},
    )
    parent = SimpleNamespace(
        session_id="parent-session",
        call=parent_call,
        agent={
            "id": "agent-1",
            "userId": "user-1",
            "organisationId": "org-1",
            "modelName": "pipecat:ultravox",
            "options": {},
        },
        instance={"id": "instance-1"},
        transfer_state=TransferState("dialling", "Dialling transfer target..."),
    )

    captured: dict = {}

    async def fake_setup_consult_call(sip_gateway, ctx, *, instance, transfer_agent, parent):
        captured["ctx"] = ctx
        captured["instance"] = instance
        captured["transfer_agent"] = transfer_agent
        return SimpleNamespace(call=SimpleNamespace(id="consult-call-1"))

    async def fake_run_session(app, session, call_id):
        captured["ran_call_id"] = call_id

    monkeypatch.setattr(worker, "setup_consult_call", fake_setup_consult_call)
    monkeypatch.setattr(worker, "_run_session", fake_run_session)

    sent = _drive_handler(gateway, session_id, live_calls={"parent-call": parent})

    assert sent[0]["type"] == "websocket.accept"
    assert not any(m["type"] == "websocket.http.response.start" for m in sent)
    # The crash line: caller id must be read from the aplisay metadata.
    assert captured["ctx"].caller_id == "07970939456"
    # calledId = the transfer destination stashed on the ConsultPayload
    # (None here 400s the consult call-record POST — see the payload test).
    assert captured["ctx"].called_id == "443300889471"
    assert captured["ctx"].raw["consult_of"] == "parent-session"
    # The TransferAgent inherits the parent's model with the consult prompt.
    assert captured["transfer_agent"]["modelName"] == "pipecat:ultravox"
    assert "caller: hello" in captured["transfer_agent"]["prompt"]
    # The consult bot's pipeline actually ran.
    assert captured["ran_call_id"] == "consult-call-1"
    # No accept_transfer fired before the WS ended → parent marked rejected.
    assert parent.transfer_state.state == "rejected"
    # Consult registration cleaned up on exit.
    assert gateway.consult_payload(session_id) is None


def test_consult_call_record_posts_string_called_and_caller_ids(monkeypatch):
    """Exercise the agent-db POST: calledId must be the transfer destination, not null. See PR #197."""
    gateway = SipBridgeSipGateway()
    session_id = "sb-consult-99999999-8888-7777-6666-555555555555"
    gateway.register_consult_session(
        consult_session_id=session_id,
        parent_session_id="parent-session",
        transfer_prompt_template="Consult prompt. ${parentTranscript}",
        parent_transcript="caller: hello",
        destination="443300889471",
    )

    parent_call = api_client.CallRecord(
        id="parent-call",
        userId="user-1",
        organisationId="org-1",
        instanceId="instance-1",
        agentId="agent-1",
        metadata={"aplisay": {"callerId": "07970939456", "calledId": "+441539454616"}},
    )
    parent = SimpleNamespace(
        session_id="parent-session",
        call=parent_call,
        agent={
            "id": "agent-1",
            "userId": "user-1",
            "organisationId": "org-1",
            "modelName": "pipecat:ultravox",
            "options": {},
        },
        instance={"id": "instance-1"},
        transfer_state=TransferState("dialling", "Dialling transfer target..."),
    )

    posted: dict = {}

    async def fake_create_call(call_data: dict):
        posted.update(call_data)
        return api_client.CallRecord(
            id="consult-call-rec",
            userId=call_data["userId"],
            organisationId=call_data["organisationId"],
            instanceId=call_data["instanceId"],
            agentId=call_data["agentId"],
            metadata=call_data.get("metadata") or {},
            options=call_data.get("options") or {},
        )

    async def fake_start_call(call):
        return call

    async def fake_run_session(app, session, call_id):
        posted["ran_call_id"] = call_id

    monkeypatch.setattr(api_client, "create_call", fake_create_call)
    monkeypatch.setattr(api_client, "start_call", fake_start_call)
    monkeypatch.setattr(worker, "_run_session", fake_run_session)

    sent = _drive_handler(gateway, session_id, live_calls={"parent-call": parent})

    assert sent[0]["type"] == "websocket.accept"
    # The 400 killer: both ids must be non-empty strings on the wire.
    assert posted["calledId"] == "443300889471"
    assert posted["callerId"] == "07970939456"
    assert posted["metadata"]["aplisay"]["transferConsultation"] is True
    assert posted["parentId"] == "parent-call"
    # The real setup_consult_call completed and the pipeline ran.
    assert posted["ran_call_id"] == "consult-call-rec"
