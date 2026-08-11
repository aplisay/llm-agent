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
    # Set once this leg is one half of an installed media bridge (native
    # dial_bridge or consultative finalise). From that point the bridged
    # call belongs to the two humans, not to this worker session — the
    # session's teardown must NOT delete the bridge call (the bridge tears
    # both legs down itself when either side BYEs).
    bridged: bool = False
    # Post-bridge DTMF watcher context (``options.bridgedTransferToAgent``).
    # Set by ``CallSession`` when a monitored bridge is installed; consumed
    # by the /sipbridge/agent WS handler, which keeps reading the (still
    # open) WS for ``source: "transfer_target"`` DTMF events after the
    # pipeline ends. See ``bridged_transfer.py``.
    bta_context: Optional[Any] = None

    async def hangup(self, reason: str) -> None:
        if self.bridged:
            logger.bind(call_id=self.bridge_call_id, reason=reason).info(
                "sipbridge hangup skipped — leg is part of a live bridge"
            )
            return
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

    async def send_dtmf(self, digits: str) -> None:
        """Play ``digits`` as out-of-band RFC 4733 DTMF toward the caller.

        The Go bridge owns the SIP/RTP leg, so it synthesises the
        telephone-event RTP itself; we just hand it the digit string. The
        bridge validates the alphabet again and plays the burst on a
        background goroutine, so this returns as soon as it's accepted.
        """
        logger.bind(call_id=self.bridge_call_id, digits=digits).info("sipbridge send_dtmf")
        await self._gateway._call_api(
            "POST",
            f"/v1/calls/{self.bridge_call_id}/dtmf",
            {"digits": digits},
        )

    async def transfer(self, req: TransferRequest) -> None:
        """Route the transfer through the bridge's REST surface.

        Matches the LiveKit-parity contract in
        ``docs/call-transfers.md`` and ``transfer_prompts.py``:

          - ``blind``: in-dialog REFER on the existing call. If
            ``force_bridged`` (typically from a registration endpoint
            that can't honour REFER) the native dial+bridge route is
            taken instead: the bridge dials the target as a fresh
            agent-less leg and relays media between it and the caller,
            keeping media inside the platform (``mode: "dial_bridge"``).
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

        # force_bridged (typically a registration endpoint that can't
        # honour REFER, or a trunk-origin call — the trunk default) takes
        # the native dial+relay path: the bridge dials the target as a
        # fresh agent-less leg and relays media between it and the caller,
        # keeping media inside the bridge. Otherwise we REFER and let the
        # upstream B2BUA reroute.
        if req.force_bridged:
            # The bridge has no outbound proxy: a bare-number target must be
            # resolved to a routable URI here (the Go side hard-rejects it
            # with "invalid uri scheme" otherwise), exactly as the outbound
            # originate path does via _outbound_target_uri.
            target = _routable_leg_uri(
                req.destination,
                registration_endpoint_id=req.registration_endpoint_id,
                b2bua_gateway_ip=req.b2bua_gateway_ip,
                b2bua_gateway_transport=req.b2bua_gateway_transport,
                outbound_sbc=self._gateway.outbound_sbc,
                purpose="bridged transfer",
            )
            # From toward the gateway: explicit override, else the genuine
            # origin caller (LiveKit: fromNumber = registrationUsername ||
            # origin). Without a From user the bridge falls back to sipgo's
            # synthetic From (user@localhost) and the SBC's handler-domain
            # gate drops the leg.
            caller_id = req.caller_id_override or req.origin_caller_id or ""
            logger.bind(
                call_id=self.bridge_call_id,
                target=target,
                mode="dial_bridge",
                monitor_dtmf=req.monitor_dtmf,
            ).info("sipbridge transfer (native dial+bridge)")
            await self._gateway._call_api(
                "POST",
                f"/v1/calls/{self.bridge_call_id}/transfer",
                {
                    "target": target,
                    "mode": "dial_bridge",
                    "caller_id": caller_id,
                    "custom_headers": _transfer_egress_headers(req),
                    "monitor_dtmf": req.monitor_dtmf,
                    "tap_audio": req.tap_audio,
                },
            )
            self.bridged = True
            return

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
        # Resolve the routable URI BEFORE registering the consult session so a
        # no-route failure propagates cleanly without leaking a registration.
        # Same normalisation as dial_bridge / outbound originate: the consult
        # leg also lands in ``Manager.Originate``.
        destination_uri = _routable_leg_uri(
            req.destination,
            registration_endpoint_id=req.registration_endpoint_id,
            b2bua_gateway_ip=req.b2bua_gateway_ip,
            b2bua_gateway_transport=req.b2bua_gateway_transport,
            outbound_sbc=self._gateway.outbound_sbc,
            purpose="consult transfer",
        )

        consult_session_id = f"sb-consult-{uuid.uuid4()}"
        # Stash the TransferAgent payload for the WS handler. ``destination``
        # rides along because the bridge's callback WS carries only the
        # session id in the URL — the WS arm needs it for the consult call
        # record's calledId (a null calledId is a 400 at the agent-db API).
        self._gateway.register_consult_session(
            consult_session_id=consult_session_id,
            parent_session_id=self.session_id,
            transfer_prompt_template=req.transfer_prompt_template or "",
            parent_transcript=req.parent_transcript or "",
            destination=req.destination or "",
        )

        # Trunk / registration egress routing plus the genuine-origin
        # assertion (X-Aplisay-Origin-Caller-Id → P-Asserted-Identity at the
        # B2BUA). Mirrors the outbound originate header contract.
        custom_headers = _transfer_egress_headers(req)

        body: dict[str, Any] = {
            "destination": destination_uri,
            "caller_id": req.caller_id_override or req.origin_caller_id or "",
            "agent_ws_session_id": consult_session_id,
            "custom_headers": custom_headers,
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

    async def bridge_with(
        self, other: GatewaySession, *, monitor_dtmf: bool = False, tap_audio: bool = False
    ) -> None:
        """Install a sipbridge media relay between this session's leg
        and ``other``'s leg.

        Implements the ``GatewaySession.bridge_with`` Protocol method
        for the sipbridge backend. ``other`` must also be a
        ``_SbGatewaySession`` (consult and parent share a gateway).
        Calls ``POST /v1/calls/{this}/transfer { target: <other>, mode:
        "bridged" }`` on the bridge — same primitive the bridge uses
        internally for ``BridgeRelay`` (see
        ``agents/pipecat/sipbridge/internal/call/manager.go``).
        ``monitor_dtmf`` keeps this (caller) leg's worker WS open across
        the bridge so transfer-target DTMF events reach the worker
        (``options.bridgedTransferToAgent``).
        """
        if not isinstance(other, _SbGatewaySession):
            raise NotImplementedError(
                f"sipbridge bridge_with: peer must be _SbGatewaySession, "
                f"got {type(other).__name__}"
            )
        await self._gateway._call_api(
            "POST",
            f"/v1/calls/{self.bridge_call_id}/transfer",
            {
                "target": other.bridge_call_id,
                "mode": "bridged",
                "monitor_dtmf": monitor_dtmf,
                "tap_audio": tap_audio,
            },
        )
        self.bridged = True
        other.bridged = True

    async def unbridge(self, *, agent_ws_session_id: str) -> None:
        """Finalise a human-to-agent takeover: drop the bridged peer
        (transfer target) and have the bridge re-dial a fresh agent WS
        for this leg at ``/sipbridge/agent/{agent_ws_session_id}``. The
        worker must have stashed a TakeoverPayload for that session id
        before calling this. See ``bridged_transfer.py``."""
        await self._gateway._call_api(
            "POST",
            f"/v1/calls/{self.bridge_call_id}/unbridge",
            {"agent_ws_session_id": agent_ws_session_id},
        )

    async def attended_refer_with(self, other: GatewaySession) -> None:
        """Finalise a consultative transfer via attended SIP REFER.

        Sends the bridge a ``mode: "attended"`` transfer on *this* leg
        (the original caller A↔bridge dialog) whose ``replaces`` is the
        consult leg's bridge call id (``other``). The bridge resolves that
        call id to the consult dialog's Call-ID + tags, builds a
        ``Refer-To: <sip:C@host?Replaces=...>`` and REFERs A to C. A then
        re-INVITEs C with ?Replaces, the bridge drops both legs, and A and
        C talk directly. See RFC 3891 and
        ``agents/pipecat/sipbridge/internal/sip/server.go``.
        """
        if not isinstance(other, _SbGatewaySession):
            raise NotImplementedError(
                f"sipbridge attended_refer_with: peer must be _SbGatewaySession, "
                f"got {type(other).__name__}"
            )
        logger.bind(
            call_id=self.bridge_call_id,
            consult_call_id=other.bridge_call_id,
            mode="attended",
        ).info("sipbridge transfer (attended REFER + Replaces)")
        await self._gateway._call_api(
            "POST",
            f"/v1/calls/{self.bridge_call_id}/transfer",
            {"target": other.bridge_call_id, "mode": "attended"},
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
        # Default to 127.0.0.1:8090 — matches both deployment styles in this
        # repo. The compose stack (docker-compose.yml) runs the sipbridge
        # container with ``network_mode: host`` and sets ``SIPBRIDGE_BASE_URL``
        # to ``http://127.0.0.1:8090`` for the worker, and the dev workflow
        # (docker-compose.dev.yml + ``uv run python -m pipecat_aplisay``)
        # reaches the host-networked sipbridge container at the same address.
        # A Docker-DNS name like ``sipbridge`` would only work inside a bridge
        # network, which isn't how either deployment is wired.
        base = os.environ.get("SIPBRIDGE_BASE_URL", "http://127.0.0.1:8090")
        self.base_url = base.rstrip("/")
        self.api_token = os.environ.get("SIPBRIDGE_API_TOKEN")

        # Outbound routing for trunk-origin originate. The Go bridge has no
        # outbound proxy: it INVITEs whatever host is in the target URI. For a
        # trunk-origin outbound call (no inbound dialog to route back through),
        # we route via the global Aplisay outbound SBC — the analogue of
        # LiveKit's pre-provisioned "Aplisay Outbound" trunk. Format:
        # ``host[:port][;transport=tls|tcp|udp]`` (e.g. ``sbc.aplisay.com:5061;transport=tls``).
        # Registration-origin calls don't need this — they route to the
        # registration's own B2BUA gateway (b2buaId), carried per-call.
        #
        # ``PIPECAT_SIP_OUTBOUND`` is the platform-wide outbound SBC setting
        # (named to line up with the LiveKit stack). Only the sipbridge gateway
        # consumes it: FreeSWITCH (esl-poller) and voiceblender route outbound
        # inside their own backends from the ``X-Aplisay-Trunk`` / ``aplisayId``
        # they're handed, so they don't need an explicit SBC target here.
        self.outbound_sbc = os.environ.get("PIPECAT_SIP_OUTBOUND")

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

        # Map of worker session_id → live _SbGatewaySession, so the WS
        # handler's outbound branch can find the session object (and its
        # ``bta_context``) when a bridged transfer-to-agent watch is armed
        # on an outbound-origin call.
        self._sessions: dict[str, _SbGatewaySession] = {}

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
        self._sessions[session_id] = session

        pending = self._pending_outbound.get(session_id)
        if pending and not pending.done():
            pending.set_result(session)

        return session

    def live_session(self, session_id: str) -> Optional[_SbGatewaySession]:
        return self._sessions.get(session_id)

    def signal_bta_armed(self, session_id: str) -> None:
        """Wake the WS handler's outbound wait loop when a bridged
        transfer-to-agent watch is armed mid-call, so it can take over
        reading the (kept-open) WS for transfer-target DTMF. No-op for
        inbound calls, where nothing waits on the leg-done event."""
        ev = self._leg_done_events.get(session_id)
        if ev is not None:
            ev.set()

    def unregister_session(self, session_id: str) -> None:
        """Called when the WS handler exits, regardless of cause.

        The bridge will already have cleaned up its end (SIP-side BYE
        triggers WS close); we just drop our mapping and wake any
        waiter on the leg-done event.
        """
        self._session_to_bridge_call.pop(session_id, None)
        self._sessions.pop(session_id, None)
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

        # Tell the bridge: dial ``destination`` from ``caller_id``, attach
        # the resulting leg to our worker's WS at
        # ``/sipbridge/agent/{session_id}``. The destination MUST be a routable
        # SIP URI (the bridge has no outbound proxy and INVITEs the URI host
        # directly); build it from the per-call routing (registration B2BUA vs
        # trunk SBC). The bridge does the rest.
        body: dict[str, Any] = {
            "destination": _outbound_target_uri(params, self.outbound_sbc),
            "caller_id": params.caller_id,
            "agent_ws_session_id": session_id,
            "custom_headers": _custom_headers_for(params),
            "metadata": {"aplisay_call_id": params.call_id},
        }
        try:
            # The bridge blocks this POST until the SIP final response (it runs
            # WaitAnswer inline — see api/server.go:handleOriginate, which gives
            # itself a 60s context). A slow-answering PSTN callee can ring for
            # 20s+, so this request MUST outlive the bridge's own answer budget;
            # the default 15s control-call timeout would abort mid-ring, pop the
            # pending future below, and 404 the WS that arrives on answer. Allow
            # a small margin over the bridge's 60s so its timeout/error surfaces
            # as a real HTTP response rather than a client-side abort.
            await self._call_api("POST", "/v1/calls", body, timeout=65.0)
        except Exception:
            self._pending_outbound.pop(session_id, None)
            raise

        # The WS connects (resolving this future via register_inbound_session)
        # as the bridge wires media on answer — i.e. just before the POST above
        # returns — so by here the future is typically already resolved. Keep a
        # generous ceiling matching the answer budget as a backstop.
        try:
            return await asyncio.wait_for(future, timeout=65.0)
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
        timeout: float = 15.0,
    ) -> Optional[dict]:
        url = f"{self.base_url}{path}"
        headers: dict[str, str] = {"content-type": "application/json"}
        if self.api_token:
            headers["authorization"] = f"Bearer {self.api_token}"
        async with httpx.AsyncClient(timeout=timeout) as client:
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


def _outbound_target_uri(params: OutboundCallParams, outbound_sbc: Optional[str]) -> str:
    """Build a routable SIP URI for an outbound originate.

    The Go bridge sends the INVITE to the host in this URI (it has no outbound
    proxy of its own), so a bare ``+E164`` is rejected (``invalid uri scheme``).
    Mirrors LiveKit's two originate routes:

      - **Registration origin** (``registration_endpoint_id`` +
        ``b2bua_gateway_ip``): route to that registration's B2BUA gateway on
        :5070 (the registrar is reached through it), e.g.
        ``sip:+44...@10.0.0.5:5070;transport=tcp``.
      - **Trunk origin** (``aplisay_id``): route to the global Aplisay outbound
        SBC (``PIPECAT_SIP_OUTBOUND``); the SBC fans out to the carrier using
        the ``X-Aplisay-Trunk`` header, e.g. ``sip:+44...@sbc:5061;transport=tls``.

    A ``destination`` that is already a ``sip:``/``sips:`` URI is passed through
    unchanged.
    """
    return _routable_leg_uri(
        params.called_id,
        registration_endpoint_id=params.registration_endpoint_id,
        b2bua_gateway_ip=params.b2bua_gateway_ip,
        b2bua_gateway_transport=params.b2bua_gateway_transport,
        outbound_sbc=outbound_sbc,
        purpose="outbound originate",
    )


def _routable_leg_uri(
    destination: str,
    *,
    registration_endpoint_id: Optional[str] = None,
    b2bua_gateway_ip: Optional[str] = None,
    b2bua_gateway_transport: Optional[str] = None,
    outbound_sbc: Optional[str] = None,
    purpose: str = "originate",
) -> str:
    """Resolve a dial target to a URI the Go bridge can route.

    Shared by outbound originates AND gateway-originated transfer legs
    (dial_bridge / consult) — all three end in ``Manager.Originate``, whose
    ``sip.ParseUri`` rejects a bare number with ``invalid uri scheme``.
    ``purpose`` only flavours the no-route error message.
    """
    dest = (destination or "").strip()
    if dest.lower().startswith(("sip:", "sips:")):
        return dest
    if registration_endpoint_id and b2bua_gateway_ip:
        # ``host[:port]`` — append the B2BUA SIP port (5070) only when the
        # configured value doesn't already carry one.
        host = _strip_sip_scheme(b2bua_gateway_ip)
        authority = host if ":" in host else f"{host}:5070"
        transport = b2bua_gateway_transport or "tcp"
        return f"sip:{dest}@{authority};transport={transport}"
    if not outbound_sbc:
        raise RuntimeError(
            f"sipbridge {purpose} has no route for a trunk-origin call: "
            "set PIPECAT_SIP_OUTBOUND (host[:port][;transport=...]) to the "
            "Aplisay outbound SBC, or originate with a registration endpoint as "
            "the caller-ID"
        )
    # The SBC value is an authority (``host[:port][;transport=...]``). Tolerate
    # an operator who included a ``sip:`` scheme — we add our own.
    return f"sip:{dest}@{_strip_sip_scheme(outbound_sbc)}"


def _transfer_egress_headers(req: TransferRequest) -> dict[str, str]:
    """The X-Aplisay-*/X-Lk-* routing contract for a gateway-originated
    transfer leg — the same section-6 header set ``_custom_headers_for``
    stamps on outbound originates (minus the call id: bridged transfer legs
    live only inside the bridge), sourced from the TransferRequest's egress
    tuple, plus the origin-caller assertion the consult path has always
    sent. Without X-Aplisay-Trunk the upstream SBC 403s a trunk-egress
    INVITE."""
    h: dict[str, str] = {}
    if req.aplisay_id:
        h["X-Aplisay-Trunk"] = req.aplisay_id
    if req.registration_endpoint_id:
        h["X-Aplisay-PhoneRegistration"] = req.registration_endpoint_id
    if req.b2bua_gateway_ip:
        h["X-Lk-RealIp"] = req.b2bua_gateway_ip
    if req.b2bua_gateway_transport:
        h["X-Lk-Transport"] = req.b2bua_gateway_transport
    if req.origin_caller_id:
        h["X-Aplisay-Origin-Caller-Id"] = req.origin_caller_id
    if req.srtp is False:
        # Same per-trunk opt-out as the originate path — see
        # ``_custom_headers_for``. A transfer leg egresses over a trunk too, so
        # a carrier that advertises SAVP and then sends plain RTP breaks a
        # transfer exactly as it breaks an originate.
        h["X-Aplisay-Srtp"] = "off"
    return h


def _strip_sip_scheme(authority: str) -> str:
    """Drop a leading ``sip:`` / ``sips:`` from a host/authority value so it can
    be embedded after ``sip:<user>@`` without producing ``sip:...@sip:...``."""
    a = (authority or "").strip()
    low = a.lower()
    if low.startswith("sips:"):
        return a[5:]
    if low.startswith("sip:"):
        return a[4:]
    return a


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
    if params.srtp is False:
        # Per-trunk opt-out (Trunk.flags.srtp). Only ever sent to say "don't":
        # its ABSENCE means the historical behaviour, so a bridge that predates
        # the header keeps offering SAVP exactly as it does today.
        h["X-Aplisay-Srtp"] = "off"
    return h
