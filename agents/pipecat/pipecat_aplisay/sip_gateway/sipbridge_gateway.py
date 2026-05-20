"""sipbridge gateway implementation.

Architecture (see ``docs/sipbridge-integration.md`` for the long-form note):

- **sipbridge** is a small Go container (``agents/pipecat/sipbridge``) —
  sipgo for SIP signalling, pion/rtp for RTP framing, hand-rolled G.711
  codecs and 8↔16 kHz resampler, hand-rolled Pipecat protobuf wire
  codec. ~2 kLoC total, no protoc / cgo at build time.

- **Media path**: sipbridge dials our worker over WebSocket at
  ``/sipbridge/agent/{session_id}`` carrying ``pipecat.Frame``
  protobufs at 16 kHz mono. On the worker side we receive that WS in
  :func:`pipecat_aplisay.worker.sipbridge_agent` and wrap it in a
  ``FastAPIWebsocketTransport`` with ``ProtobufFrameSerializer``.
  Same shape as the voiceblender path.

- **Control path**: REST only. The bridge exposes
  ``GET /health``, ``DELETE /v1/calls/{id}``, and (Phase B+)
  ``POST /v1/calls``, ``POST /v1/calls/{id}/transfer``. No long-lived
  event stream — sipbridge passes SIP-derived metadata inline on the WS
  opening handshake as ``X-Sipbridge-*`` / ``X-Aplisay-*`` request
  headers, so the worker can resolve the agent at WS accept time
  without a separate event subscription.

- **Inbound dispatch**: sipbridge sees the INVITE, builds the SDP
  answer (allocating an RTP socket), then dials our worker WS with the
  SIP headers attached. The worker's WS handler reads those headers,
  runs the usual agent-lookup chain, calls ``setup_inbound_call(...)``
  and runs the pipeline. If the WS dial fails (no agent, worker down),
  sipbridge tears down the SIP transaction with a 5xx — same
  fail-clean semantics as voiceblender's webhook path.

- **Outbound originate** (Phase B): worker POSTs ``/v1/calls`` to
  sipbridge with the agent WS URL pre-set; sipbridge INVITEs the
  destination and dials our worker WS on answer. Same future-resolution
  pattern as the FreeSWITCH and voiceblender outbound paths.

This gateway is intentionally thinner than ``VoiceblenderSipGateway``:
no VSI subscriber, no event taxonomy mapping — just REST control + the
WS that the WS handler owns. The shape matches the abstraction the
``SipGateway`` Protocol already defines; the implementation differences
are entirely about how SIP-side events reach the worker.
"""

from __future__ import annotations

import asyncio
import os
import uuid  # noqa: F401  (used by warm-transfer flow)
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from loguru import logger
from pipecat.transports.base_transport import BaseTransport

from .base import (
    ConsultStateMixin,
    GatewaySession,
    GatewaySessionParams,
    InboundCallContext,
    OutboundCallParams,
    SipGateway,
    TransferRequest,
)


@dataclass
class _SbGatewaySession(GatewaySession):
    transport: BaseTransport
    session_id: str
    bridge_call_id: str
    _gateway: "SipBridgeSipGateway"

    async def hangup(self, reason: str) -> None:
        logger.bind(call_id=self.bridge_call_id, reason=reason).info(
            "sipbridge hangup"
        )
        # If a consult leg was started but never finalised, drop it too
        # so it doesn't dangle. (The original call's hangup naturally
        # cleans up the consult side of the SIP dialog via BYE in the
        # bridge, but be defensive — Pipecat's tool surface can throw
        # an exception mid-consult that leaves us with no chance to
        # call /transfer.)
        consult = self._gateway.get_consult_call_id(self.session_id)
        if consult:
            await self._gateway._call_api(
                "DELETE",
                f"/v1/calls/{consult}",
                None,
                raise_on_error=False,
            )
            self._gateway.clear_consult_call_id(self.session_id)
        await self._gateway._call_api(
            "DELETE",
            f"/v1/calls/{self.bridge_call_id}",
            None,
            raise_on_error=False,
        )

    async def transfer(self, req: TransferRequest) -> None:
        """Route the transfer through the bridge's REST surface.

        Matches the LiveKit-parity contract in
        ``docs/call-transfers.md`` and ``transfer_prompts.py``:

          - ``blind``: in-dialog REFER on the existing call. If
            ``force_bridged`` (typically from a registration endpoint
            that can't honour REFER) the bridge route is taken instead
            via a synthesised consult+bridge — but for v1 we just
            REFER unconditionally; the upstream B2BUA should be
            REFER-capable for this gateway.
          - ``consultative``: dial a fresh leg, attach a TransferAgent
            (separate Pipecat session with bespoke prompt + accept/
            reject tools) on the worker side. **Returns immediately**:
            the caller has just kicked off consultation. The accept/
            reject tools on the TransferAgent drive subsequent state
            via the parent CallSession's ``transfer_state``; the
            original bot polls via ``transfer_status``.

        The TransferRequest's ``transfer_prompt_template`` and
        ``parent_transcript`` are populated by the parent CallSession
        before this method is called (see ``CallSession._on_transfer``);
        they are NOT looked up here — keeping the gateway gateway-
        generic.
        """
        op = req.operation or "blind"

        if op == "consultative":
            await self._do_consultative(req)
            return

        if op == "blind":
            await self._do_blind(req)
            return
        raise RuntimeError(
            f"sipbridge: unknown transfer operation {op!r} "
            "(expected 'blind' or 'consultative')"
        )

    async def _do_blind(self, req: TransferRequest) -> None:
        # Drop any in-flight consult leg first — if a previous
        # consultative transfer is still in flight on this same
        # session, a blind takes precedence and we don't want both
        # active.
        consult = self._gateway.get_consult_call_id(self.session_id)
        if consult:
            await self._gateway._call_api(
                "DELETE", f"/v1/calls/{consult}", None, raise_on_error=False
            )
            self._gateway.clear_consult_call_id(self.session_id)
        logger.bind(
            call_id=self.bridge_call_id, target=req.destination, mode="blind"
        ).info("sipbridge transfer (blind REFER)")
        await self._gateway._call_api(
            "POST",
            f"/v1/calls/{self.bridge_call_id}/transfer",
            {"target": req.destination, "mode": "blind"},
        )

    async def _do_consultative(self, req: TransferRequest) -> None:
        """Fire-and-forget consult initiation — matches LiveKit's
        return-immediately contract (transfer-handler.ts:807-812 +
        :1413).

        We:

          1. Register a session_id for the consult bot.
          2. Stash the TransferAgent prompt + parent transcript +
             parent session_id so the WS handler can build the
             TransferAgent CallSession when the bridge dials us.
          3. POST /consult to the bridge.
          4. Return.

        The consult bot's CallSession is built later (in the worker's
        ``/sipbridge/agent`` WS handler) from the TransferAgent data
        stashed in step 2. Accept/reject tools on the consult bot
        drive the parent's ``transfer_state`` from then on.
        """
        consult_session_id = f"sb-consult-{uuid.uuid4()}"
        # Stash the TransferAgent payload for the WS handler.
        self._gateway.register_consult_session(
            consult_session_id=consult_session_id,
            parent_session_id=self.session_id,
            transfer_prompt_template=req.transfer_prompt_template or "",
            parent_transcript=req.parent_transcript or "",
        )

        body: dict[str, Any] = {
            "destination": req.destination,
            "caller_id": req.caller_id_override or "",
            "agent_ws_session_id": consult_session_id,
            "custom_headers": {},
            "metadata": {},
        }
        logger.bind(
            original_call_id=self.bridge_call_id,
            consult_session_id=consult_session_id,
            target=req.destination,
        ).info("sipbridge consultative: dialing third party")

        try:
            resp = await self._gateway._call_api(
                "POST", f"/v1/calls/{self.bridge_call_id}/consult", body
            )
        except Exception:
            self._gateway.clear_consult_session(consult_session_id)
            raise

        consult_call_id = (resp or {}).get("consult_call_id")
        if not consult_call_id:
            self._gateway.clear_consult_session(consult_session_id)
            raise RuntimeError(
                f"sipbridge consultative: bridge response missing consult_call_id: {resp!r}"
            )

        # Remember the consult call id so the accept_transfer tool on
        # the TransferAgent can target it when building the media
        # relay. (The TransferAgent's CallSession also reads this via
        # the parent_session reference.)
        self._gateway.set_consult_call_id(self.session_id, consult_call_id)
        logger.bind(
            consult_call_id=consult_call_id,
            consult_session_id=consult_session_id,
        ).info("sipbridge consultative: consult leg requested; "
               "TransferAgent will spawn when WS arrives")

    async def bridge_with(self, other: GatewaySession) -> None:
        """Install a sipbridge media relay between this session's leg
        and ``other``'s leg.

        Implements the ``GatewaySession.bridge_with`` Protocol method
        for the sipbridge backend. ``other`` must also be a
        ``_SbGatewaySession`` (consult and parent share a gateway).
        Calls ``POST /v1/calls/{this}/transfer { target: <other>, mode:
        "bridged" }`` on the bridge — same primitive the bridge uses
        internally for ``BridgeRelay`` (see
        ``agents/pipecat/sipbridge/internal/call/manager.go``).
        """
        if not isinstance(other, _SbGatewaySession):
            raise NotImplementedError(
                f"sipbridge bridge_with: peer must be _SbGatewaySession, "
                f"got {type(other).__name__}"
            )
        await self._gateway._call_api(
            "POST",
            f"/v1/calls/{self.bridge_call_id}/transfer",
            {"target": other.bridge_call_id, "mode": "bridged"},
        )

    async def shutdown(self) -> None:
        await self.hangup("Session closed")


class SipBridgeSipGateway(ConsultStateMixin, SipGateway):
    """REST client for the sipbridge container.

    Unlike :class:`VoiceblenderSipGateway` there is no long-lived event
    subscription — sipbridge dials our worker per call with the SIP
    metadata on the WS opening handshake. The gateway's only background
    state is the pending-attach map that bridges the worker's WS
    handler back to the in-process call session.
    """

    name = "sipbridge"

    def __init__(self) -> None:
        base = os.environ.get("SIPBRIDGE_BASE_URL", "http://sipbridge:8090")
        self.base_url = base.rstrip("/")
        self.api_token = os.environ.get("SIPBRIDGE_API_TOKEN")

        # Inbound: session_id is generated by the WS handler when the WS
        # opens; the bridge dials with X-Sipbridge-Call-ID set so we can
        # correlate REST cleanup later.
        # Outbound: session_id generated up front by ``originate()``,
        # bridge sees it in the WS URL we hand it.
        self._pending_outbound: dict[str, asyncio.Future[_SbGatewaySession]] = {}

        # Map of worker session_id → bridge call_id, populated when the
        # WS handler builds the session. Used so REST hangup/transfer
        # know which bridge resource to target.
        self._session_to_bridge_call: dict[str, str] = {}

        # Per-session leg-done signals — set when the gateway session's
        # WebSocket close handler fires. The /sipbridge/agent WS handler
        # awaits this for outbound calls (where the dispatch task owns
        # ``_run_session`` and the handler itself just needs to keep
        # the WS alive long enough for the runner to drive it).
        self._leg_done_events: dict[str, asyncio.Event] = {}

        # Warm-transfer state (LiveKit-parity, shared with FreeSWITCH /
        # voiceblender backends via ``ConsultStateMixin``).
        self._init_consult_state()

    async def start(self) -> None:
        try:
            r = await self._call_api("GET", "/health", None, raise_on_error=True)
            logger.bind(health=r).info("sipbridge reachable")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"sipbridge health check failed at boot: {e}")

    async def stop(self) -> None:
        # No long-lived connections; nothing to release.
        return None

    # ---- Worker-side helpers -------------------------------------------

    def register_inbound_session(
        self,
        *,
        session_id: str,
        bridge_call_id: str,
        transport: BaseTransport,
    ) -> _SbGatewaySession:
        """Called by ``/sipbridge/agent/{session_id}`` WS handler when a
        new bridge WebSocket arrives. Resolves any pending outbound
        future and returns a ``_SbGatewaySession``."""
        session = _SbGatewaySession(
            transport=transport,
            session_id=session_id,
            bridge_call_id=bridge_call_id,
            _gateway=self,
        )
        self._session_to_bridge_call[session_id] = bridge_call_id

        pending = self._pending_outbound.get(session_id)
        if pending and not pending.done():
            pending.set_result(session)

        return session

    def unregister_session(self, session_id: str) -> None:
        """Called when the WS handler exits, regardless of cause.

        The bridge will already have cleaned up its end (SIP-side BYE
        triggers WS close); we just drop our mapping and wake any
        waiter on the leg-done event.
        """
        self._session_to_bridge_call.pop(session_id, None)
        ev = self._leg_done_events.get(session_id)
        if ev is not None:
            ev.set()

    def is_outbound(self, session_id: str) -> bool:
        """True if ``session_id`` matches a pending outbound originate.

        The WS handler uses this to decide which lifecycle to run: for
        outbound, dispatch already owns the ``CallSession`` + runner;
        the handler just needs to wire the transport and keep the WS
        alive until the call ends. For inbound, the handler runs the
        whole flow itself.
        """
        return session_id in self._pending_outbound

    def wait_for_leg_done(self, session_id: str) -> asyncio.Event:
        """Return (creating if necessary) a per-session done event.

        Used by the WS handler on the outbound path. ``unregister_session``
        sets it when the handler exits, which propagates through the
        ``done_event.wait()`` in the handler to unwind cleanly.
        """
        ev = self._leg_done_events.get(session_id)
        if ev is None:
            ev = asyncio.Event()
            self._leg_done_events[session_id] = ev
        return ev

    def release_leg_done(self, session_id: str) -> None:
        """Drop the per-session leg-done event after the handler unwinds."""
        self._leg_done_events.pop(session_id, None)

    # ---- SipGateway protocol -------------------------------------------

    async def setup_inbound(
        self, ctx: InboundCallContext, params: GatewaySessionParams
    ) -> GatewaySession:
        """Direct construction from the WS handler — for sipbridge, the
        WS handler always calls ``register_inbound_session`` with the
        pre-built transport and bridge call id, so ``setup_inbound`` is
        only here for protocol conformance.
        """
        transport = ctx.raw.get("transport")
        bridge_call_id = ctx.raw.get("bridge_call_id")
        if transport is None or bridge_call_id is None:
            raise RuntimeError(
                "SipBridgeSipGateway.setup_inbound requires raw.transport and "
                "raw.bridge_call_id (set by the /sipbridge/agent WS handler)"
            )
        return self.register_inbound_session(
            session_id=params.session_id,
            bridge_call_id=bridge_call_id,
            transport=transport,
        )

    async def originate(
        self, params: OutboundCallParams, session_params: GatewaySessionParams
    ) -> GatewaySession:
        """POST /v1/calls to the bridge. Phase B — returns 501 until
        the bridge implements outbound origination."""
        session_id = session_params.session_id
        future: asyncio.Future[_SbGatewaySession] = (
            asyncio.get_running_loop().create_future()
        )
        self._pending_outbound[session_id] = future

        # Tell the bridge: dial ``called_id`` from ``caller_id``, attach
        # the resulting leg to our worker's WS at
        # ``/sipbridge/agent/{session_id}``. The bridge does the rest.
        body: dict[str, Any] = {
            "destination": params.called_id,
            "caller_id": params.caller_id,
            "agent_ws_session_id": session_id,
            "custom_headers": _custom_headers_for(params),
            "metadata": {"aplisay_call_id": params.call_id},
        }
        try:
            await self._call_api("POST", "/v1/calls", body)
        except Exception:
            self._pending_outbound.pop(session_id, None)
            raise

        try:
            return await asyncio.wait_for(future, timeout=30.0)
        finally:
            self._pending_outbound.pop(session_id, None)

    # ---- HTTP plumbing -------------------------------------------------

    async def _call_api(
        self,
        method: str,
        path: str,
        body: Optional[dict],
        *,
        raise_on_error: bool = True,
    ) -> Optional[dict]:
        url = f"{self.base_url}{path}"
        headers: dict[str, str] = {"content-type": "application/json"}
        if self.api_token:
            headers["authorization"] = f"Bearer {self.api_token}"
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.request(method, url, headers=headers, json=body)
        if resp.status_code >= 400:
            msg = f"sipbridge {method} {path} -> {resp.status_code} {resp.text}"
            if raise_on_error:
                raise RuntimeError(msg)
            logger.warning(msg)
            return None
        if resp.headers.get("content-type", "").startswith("application/json"):
            return resp.json()
        return None


def _custom_headers_for(params: OutboundCallParams) -> dict[str, str]:
    """Return the X-Aplisay-* headers to stamp on the outbound INVITE
    (Phase B). Matches the voiceblender gateway's helper of the same
    name, intentionally — both pass through the same architecture-doc
    section 6 header contract."""
    h: dict[str, str] = {}
    if params.aplisay_id:
        h["X-Aplisay-Trunk"] = params.aplisay_id
    if params.call_id:
        h["X-Aplisay-Call-Id"] = params.call_id
    if params.registration_endpoint_id:
        h["X-Aplisay-PhoneRegistration"] = params.registration_endpoint_id
    if params.b2bua_gateway_ip:
        h["X-Lk-RealIp"] = params.b2bua_gateway_ip
    if params.b2bua_gateway_transport:
        h["X-Lk-Transport"] = params.b2bua_gateway_transport
    return h
