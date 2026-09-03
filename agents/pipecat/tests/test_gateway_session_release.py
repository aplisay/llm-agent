"""The gateway must release its per-call registrations on every exit path.

From the 2026-09-03 production-readiness audit. Two of its highest-impact
findings were the same shape: state registered at call setup and released
only on the happy path.

  * W1 — every OUTBOUND call. The dispatch task owns the CallSession and
    runner; the WebSocket handler only registers the transport and then
    parks on the leg-done event. Nothing but ``unregister_session`` sets
    that event, and dispatch's teardown calls ``shutdown()`` → ``hangup()``,
    so the handler task, its transport, its Starlette WebSocket and three
    map entries were retained for the life of the process, per call. The
    comment claiming FastAPI cancels the handler on peer close is not true
    of uvicorn: peer close only enqueues a ``websocket.disconnect``.

  * W6 — a completed warm transfer never cleared its consult call id,
    because ``hangup`` returns early once the leg is bridged.
"""

from __future__ import annotations

import asyncio

import pytest

from pipecat_aplisay.sip_gateway.sipbridge_gateway import (
    SipBridgeSipGateway,
    _SbGatewaySession,
)


@pytest.fixture()
def gateway(monkeypatch):
    gw = SipBridgeSipGateway()

    async def _no_rest(*_a, **_k):
        return None

    # The bridge isn't running in a unit test; hangup's DELETEs are not
    # what's under test here.
    monkeypatch.setattr(gw, "_call_api", _no_rest)
    return gw


def _register(gw, session_id="sess-1"):
    session = gw.register_inbound_session(
        session_id=session_id,
        bridge_call_id="bridge-1",
        transport=object(),
    )
    # The outbound arm of the WS handler waits on this.
    gw.wait_for_leg_done(session_id)
    return session


def test_shutdown_releases_every_registration(gateway):
    """W1: shutdown() is the ONLY teardown the outbound path runs."""
    session = _register(gateway)
    assert gateway.live_session("sess-1") is session

    asyncio.run(session.shutdown())

    assert gateway.live_session("sess-1") is None
    assert "sess-1" not in gateway._sessions
    assert "sess-1" not in gateway._session_to_bridge_call


def test_shutdown_wakes_the_parked_ws_handler(gateway):
    """The parked handler unwinds only when the leg-done event is set.

    Without this the handler task never returns, and uvicorn's graceful
    shutdown waits for it — so one leaked handler turns every SIGTERM
    into a SIGKILL at the termination-grace deadline.
    """

    async def scenario() -> None:
        session = _register(gateway)
        done = gateway.wait_for_leg_done("sess-1")
        assert not done.is_set()
        await session.shutdown()
        # The real handler does `await done_event.wait()`; if shutdown
        # didn't set it, this would hang rather than fail.
        await asyncio.wait_for(done.wait(), timeout=1.0)

    asyncio.run(scenario())


def test_shutdown_is_idempotent(gateway):
    """The inbound arm's ``finally`` also unregisters — both must be safe."""

    async def scenario() -> None:
        session = _register(gateway)
        await session.shutdown()
        gateway.unregister_session("sess-1")
        await session.shutdown()

    asyncio.run(scenario())
    assert gateway._sessions == {}


def test_bridged_leg_still_releases_its_registrations(gateway):
    """A leg that became half of a live bridge skips the hangup DELETE —
    but its worker-side registrations must go regardless."""

    async def scenario() -> None:
        session = _register(gateway)
        session.bridged = True  # the transfer completed; the bridge owns both legs
        await session.shutdown()

    asyncio.run(scenario())
    assert gateway._sessions == {}
    assert gateway._session_to_bridge_call == {}


def test_consult_call_id_is_cleared_after_a_completed_transfer(gateway):
    """W6: ``hangup`` returns early once bridged, so the consult id it
    would otherwise have cleared survived every successful warm
    transfer — one string per transfer, for the life of the process."""

    async def scenario() -> None:
        session = _register(gateway)
        gateway.set_consult_call_id("sess-1", "consult-leg-1")
        assert gateway.get_consult_call_id("sess-1") == "consult-leg-1"
        session.bridged = True
        await session.shutdown()

    asyncio.run(scenario())
    assert gateway.get_consult_call_id("sess-1") is None


def test_unregister_releases_a_never_shutdown_session(gateway):
    """The inbound arm's failure path (W2) calls unregister directly."""
    _register(gateway, "sess-2")
    gateway.unregister_session("sess-2")
    assert gateway.live_session("sess-2") is None
    assert gateway.wait_for_leg_done("sess-2").is_set()
