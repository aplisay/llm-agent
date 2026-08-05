"""/sipbridge/agent WS routing for warm-transfer consult legs.

Root cause pinned here (beta 2026-08-05, caller 07970939456): a consultative
transfer's callback WS (``sb-consult-<uuid>``, dialled by the Go bridge the
moment the transfer target answers — ``Consult`` → ``Originate`` opens the
worker WS only after the SIP dial completes) was 404-denied by the worker
itself. The handler only reached the consult flow inside ``if is_outbound:``,
but ``is_outbound()`` checks ``_pending_outbound``, which ``_do_consultative``
never touches (it registers in the ConsultStateMixin map instead). The WS fell
through to inbound agent resolution, which has no ``x-sipbridge-to`` header on
a worker-initiated leg → ``_ws_deny(404)`` → the bridge's POST /consult failed
502 and the just-answered consult leg was torn down.

These tests drive the real ``sipbridge_agent`` handler over a scripted ASGI
channel:

- a session id registered via ``register_consult_session`` must be ACCEPTED
  (here it then closes 1011 because no live parent session exists — the
  regression under test is the handshake-level 404 denial);
- an unknown session id must still take the inbound path and be denied
  (guard against over-routing).
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

from starlette.websockets import WebSocket

from pipecat_aplisay import worker
from pipecat_aplisay.sip_gateway.sipbridge_gateway import SipBridgeSipGateway


def _drive_handler(gateway: SipBridgeSipGateway, session_id: str) -> list[dict]:
    """Run ``sipbridge_agent`` against a scripted WS; return the frames it sent."""
    app = SimpleNamespace(state=SimpleNamespace(sip_gateway=gateway, live_calls={}))
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
