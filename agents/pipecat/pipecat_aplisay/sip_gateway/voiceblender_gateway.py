"""Voiceblender SIP gateway implementation.

Architecture (see `docs/voiceblender-integration.md` for the long-form note):

- **Voiceblender** (https://github.com/voiceblender/voiceblender) is a Go-based
  programmable voice platform that terminates SIP, owns the RTP media plane,
  and exposes a REST + WebSocket (`VSI`) control surface. It treats Pipecat as
  a "pluggable AI agent" attached to a leg via REST.

- **Media path**: voiceblender opens an outbound WebSocket *from* the
  voiceblender process *to* the worker, carrying ``pipecat.Frame`` protobufs
  at 16 kHz mono. On the worker side we receive that WebSocket on
  :func:`pipecat_aplisay.worker.voiceblender_agent` and wrap it in a
  ``FastAPIWebsocketTransport`` configured with
  ``pipecat.serializers.protobuf.ProtobufFrameSerializer`` — no custom
  serializer to write.

- **Control path**: this gateway holds two long-lived connections:

  * **HTTP client** (:class:`httpx.AsyncClient`) to voiceblender's REST API
    for ``POST /v1/legs/{id}/answer``, ``POST /v1/legs/{id}/agent``,
    ``DELETE /v1/legs/{id}``, ``POST /v1/legs/{id}/transfer``, and outbound
    ``POST /v1/legs``.

  * **VSI WebSocket** (`GET /v1/vsi`) — voiceblender's event stream. The
    subscriber loop watches for ``leg.ringing`` (inbound dispatch trigger),
    ``leg.transfer_progress``/``_completed``/``_failed`` (transfer state
    machine), and ``leg.disconnected`` (session teardown).

- **Inbound dispatch**: when ``leg.ringing`` arrives the subscriber resolves
  the target agent (via the same lookup chain as the FreeSWITCH and Daily
  paths — registration, trunk+number, number), reserves a ``session_id``,
  POSTs ``/answer`` then ``/agent`` with our worker's per-session WebSocket
  URL, and registers a pending-attach entry. When voiceblender then dials
  the WS, the worker's WS handler resolves the pending entry to find the
  agent + leg id and brings up a :class:`CallSession`.

- **Outbound originate**: ``POST /v1/legs`` is called with the agent
  WebSocket URL pre-set, then we wait for the resulting WS attach the same
  way the FreeSWITCH path waits for mod_audio_stream to call back.

Headers and the SIP wire contract from section 6 of the architecture doc are
preserved where voiceblender exposes them — ``X-Aplisay-Trunk``,
``X-Aplisay-PhoneRegistration``, ``X-Aplisay-Call-Id`` etc. ride through
voiceblender's per-leg ``custom_headers`` field on inbound and are stamped
on outbound INVITE.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

import httpx
import websockets
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


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


@dataclass
class PendingAttach:
    """Bookkeeping for an inbound leg between VSI ``leg.ringing`` and the
    matching WebSocket arrival on ``/voiceblender/agent/{session_id}``.

    Populated by the VSI subscriber after agent resolution; consumed by
    :func:`pipecat_aplisay.worker.voiceblender_agent` when the WS opens.
    """

    session_id: str
    leg_id: str
    instance: dict
    agent: dict
    inbound_ctx: InboundCallContext
    created_at: float


# Type alias for the worker's resolver callback. The gateway has no
# api_client dependency itself — the worker injects a resolver that does the
# usual phone-registration / number lookup. This keeps the gateway pure and
# easy to test without spinning up an HTTP client to llm-agent.
AgentResolver = Callable[[dict], Awaitable[Optional[tuple[dict, dict]]]]


@dataclass
class _VbGatewaySession(GatewaySession):
    transport: BaseTransport
    session_id: str
    leg_id: str
    _gateway: "VoiceblenderSipGateway"
    # Set once this leg is one half of an installed room bridge (native
    # dial_bridge or consultative finalise). From then on the bridged call
    # belongs to the two humans — the worker session's teardown must NOT
    # delete the leg (the room reaps itself when the legs BYE).
    bridged: bool = False
    # The bridge-room id and the peer (transfer-target) leg id, recorded
    # when this session installs a bridge — needed by the human-to-agent
    # takeover (``options.bridgedTransferToAgent``) to drop the target and
    # pull this leg back out of the room.
    bridge_room_id: Optional[str] = None
    bridge_peer_leg_id: Optional[str] = None

    async def hangup(self, reason: str) -> None:
        if self.bridged:
            logger.bind(leg_id=self.leg_id, reason=reason).info(
                "voiceblender hangup skipped — leg is part of a live bridge"
            )
            return
        logger.bind(leg_id=self.leg_id, reason=reason).info("voiceblender hangup")
        await self._gateway._call_api(
            "DELETE",
            f"/v1/legs/{self.leg_id}",
            {"reason": _vb_reason_for(reason)},
            raise_on_error=False,
        )

    async def transfer(self, req: TransferRequest) -> None:
        """Route the transfer through voiceblender's REST surface.

          - ``blind``: voiceblender ``mode: "blind"`` — in-dialog REFER.
          - ``consultative``: full LiveKit-parity warm-transfer flow.
            Dial a consult leg with our worker's WS attached, spawn a
            TransferAgent CallSession on the consult side; accept/
            reject tools on the TransferAgent finalise via
            ``bridge_with`` or ``shutdown``. Returns immediately —
            the bot polls ``transfer_status`` for the outcome. See
            ``docs/call-transfers.md``.

        Legacy ``operation="consult"`` is normalised to
        ``"consultative"`` upstream by ``CallSession._on_transfer``;
        ``"bridged"`` is normalised to ``blind`` + ``force_bridged=True``
        — neither name reaches this method directly any more.
        """
        op = req.operation or "blind"
        if op == "consultative":
            await self._do_consultative(req)
            return
        if op != "blind":
            raise RuntimeError(
                f"voiceblender: unknown transfer operation {op!r} "
                "(expected 'blind' or 'consultative')"
            )

        # force_bridged (typically a registration endpoint that can't
        # honour REFER) takes the native room-bridge path: dial the
        # target as a fresh agent-less leg, then drop both legs into a
        # voiceblender room so media stays inside the platform. Plain
        # blind otherwise issues an in-dialog REFER.
        if req.force_bridged:
            await self._do_dial_bridge(req)
            return

        # Voiceblender's ``POST /v1/legs/{id}/transfer`` body is just
        # ``{target: <SIP URI>, replaces_leg_id?}`` — blind vs attended is
        # implied by the absence/presence of ``replaces_leg_id`` (no ``mode``
        # field). ``target`` must be a routable SIP URI, so run a bare E.164
        # through the same trunk-route helper as originate.
        body: dict[str, Any] = {
            "target": self._gateway._target_uri(req.destination),
        }
        logger.bind(leg_id=self.leg_id, mode="blind", target=req.destination).info(
            "voiceblender transfer (blind REFER)"
        )
        await self._gateway._call_api(
            "POST", f"/v1/legs/{self.leg_id}/transfer", body
        )

    async def _do_dial_bridge(self, req: TransferRequest) -> None:
        """Native blind bridged transfer for voiceblender.

        Dials ``req.destination`` as a fresh outbound leg with NO agent
        attached (omit the ``agent`` field so no bot WS is opened), then
        room-bridges it with this leg via :meth:`_bridge_legs`. Media
        stays inside voiceblender — no carrier REFER — so it works on
        registrations/trunks that don't honour REFER.

        NOTE: depends on ``POST /v1/legs`` accepting an agent-less
        origination (returning a leg that simply rings the PSTN target).
        Flagged for live verification against the voiceblender external
        API — if the server requires an ``agent``, this needs the API to
        grow an explicit "bridge-only" origination mode.
        """
        body: dict[str, Any] = {
            "type": "sip",
            "to": self._gateway._target_uri(req.destination),
            "from": (req.caller_id_override or "").lstrip("+"),
            "app_id": self._gateway.app_id,
            "metadata": {"bridge_of": self.leg_id},
        }
        auth = self._gateway._sip_auth()
        if auth:
            body["auth"] = auth
        logger.bind(
            original_leg_id=self.leg_id, target=req.destination, mode="dial_bridge"
        ).info("voiceblender transfer (native dial+bridge): dialing target")

        resp = await self._gateway._call_api("POST", "/v1/legs", body)
        new_leg_id = (resp or {}).get("id") or (resp or {}).get("leg_id")
        if not new_leg_id:
            raise RuntimeError(
                f"voiceblender dial_bridge: POST /v1/legs did not return a leg id: {resp!r}"
            )
        room_id = await self._bridge_legs(self.leg_id, new_leg_id)
        self.bridged = True
        self.bridge_room_id = room_id
        self.bridge_peer_leg_id = new_leg_id
        logger.bind(
            original_leg=self.leg_id, target_leg=new_leg_id, room=room_id
        ).info("voiceblender dial_bridge: caller bridged to target leg")

    async def _do_consultative(self, req: TransferRequest) -> None:
        """Fire-and-forget consultative-transfer initiation.

        Mirrors the sipbridge contract (``LiveKit-parity, returns
        immediately, accept/reject tools on the consult bot drive the
        rest``). Voiceblender's ``POST /v1/legs`` originates an
        outbound leg with an attached agent; we tell it to dial our
        worker's per-session WS as soon as the third party answers.

        See ``docs/call-transfers.md`` for the canonical sequence.
        """
        consult_session_id = f"vb-consult-{uuid.uuid4()}"
        self._gateway.register_consult_session(
            consult_session_id=consult_session_id,
            parent_session_id=self.session_id,
            transfer_prompt_template=req.transfer_prompt_template or "",
            parent_transcript=req.parent_transcript or "",
        )

        body: dict[str, Any] = {
            "type": "sip",
            "to": self._gateway._target_uri(req.destination),
            "from": (req.caller_id_override or "").lstrip("+"),
            "app_id": self._gateway.app_id,
            "metadata": {"consult_of": self.leg_id},
        }
        auth = self._gateway._sip_auth()
        if auth:
            body["auth"] = auth
        logger.bind(
            original_leg_id=self.leg_id,
            consult_session_id=consult_session_id,
            target=req.destination,
        ).info("voiceblender consultative: dialing third party")

        try:
            resp = await self._gateway._call_api("POST", "/v1/legs", body)
        except Exception:
            self._gateway.clear_consult_session(consult_session_id)
            raise

        consult_leg_id = (resp or {}).get("id") or (resp or {}).get("leg_id")
        if not consult_leg_id:
            self._gateway.clear_consult_session(consult_session_id)
            raise RuntimeError(
                f"voiceblender consultative: POST /v1/legs did not return a leg id: {resp!r}"
            )
        self._gateway.set_consult_call_id(self.session_id, consult_leg_id)

        # Voiceblender's WS handler discriminates inbound vs outbound vs
        # consult by walking ``pending_attaches`` — we stash a
        # PendingAttach with empty agent/instance (matches the regular
        # outbound originate pattern) so the handler picks the right
        # branch. The consult-specific branch is keyed off
        # ``consult_payload(session_id)``, which is the mixin's
        # ``_consult_payloads`` map we already populated above.
        self._gateway.pending_attaches[consult_session_id] = PendingAttach(
            session_id=consult_session_id,
            leg_id=consult_leg_id,
            instance={},
            agent={},
            inbound_ctx=InboundCallContext(
                session_id=consult_session_id,
                called_id=req.destination,
                caller_id=req.caller_id_override,
                aplisay_id=None,
                raw={"leg_id": consult_leg_id, "consult_of": self.session_id},
            ),
            created_at=asyncio.get_running_loop().time(),
        )
        # Fire-and-forget: wait for the third party to answer, then attach our
        # worker as the leg's Pipecat agent so VB dials the consult WS.
        asyncio.create_task(
            self._gateway._connect_then_attach(consult_leg_id, consult_session_id),
            name=f"vb-consult-attach-{consult_session_id}",
        )
        logger.bind(
            consult_leg_id=consult_leg_id,
            consult_session_id=consult_session_id,
        ).info("voiceblender consultative: consult leg requested; "
               "TransferAgent will spawn when WS arrives")

    async def bridge_with(
        self, other: GatewaySession, *, monitor_dtmf: bool = False, tap_audio: bool = False
    ) -> None:
        """Install a media bridge between this leg and ``other``'s leg.

        Voiceblender's native bridge primitive is room-based: create a
        temporary room, move both legs into it, the room's mixer joins
        the audio. The bots drop out as their WS attachments are
        removed when the legs leave the agent-attached state.

        ``POST /v1/rooms`` to create, then ``POST /v1/rooms/{room}/legs``
        with each leg id. The room is reaped automatically when the
        last leg leaves.

        ``monitor_dtmf`` records the bridge topology (room + peer leg) on
        this session so a human-to-agent takeover watcher can be armed —
        the DTMF events themselves arrive on the VSI stream regardless.
        """
        if not isinstance(other, _VbGatewaySession):
            raise NotImplementedError(
                f"voiceblender bridge_with: peer must be _VbGatewaySession, "
                f"got {type(other).__name__}"
            )
        room_id = await self._bridge_legs(self.leg_id, other.leg_id)
        self.bridged = True
        other.bridged = True
        self.bridge_room_id = room_id
        self.bridge_peer_leg_id = other.leg_id
        logger.bind(
            parent_leg=self.leg_id, consult_leg=other.leg_id, room=room_id,
            monitor_dtmf=monitor_dtmf,
        ).info("voiceblender bridge_with: legs joined in consult-bridge room")

    async def _bridge_legs(self, leg_a: str, leg_b: str) -> str:
        """Create a temporary voiceblender room and move both legs into
        it so the room mixer joins their audio. Returns the room id.

        Shared by :meth:`bridge_with` (consultative finalisation) and
        :meth:`_do_dial_bridge` (native blind bridged transfer). The
        room is reaped automatically once the last leg leaves. ``leg_a``
        is joined first so any agent WS on it detaches only after it is
        safely in the room.
        """
        room_id = f"bridge-{uuid.uuid4()}"
        # Create the temporary bridge room. Voiceblender's
        # ``POST /v1/rooms`` body is documented to accept ``id`` for
        # caller-chosen naming; if the server doesn't honour it, we
        # fall back to the server-assigned id from the response.
        try:
            resp = await self._gateway._call_api(
                "POST", "/v1/rooms", {"id": room_id}
            )
            if resp and isinstance(resp.get("id"), str):
                room_id = resp["id"]
        except Exception as e:  # noqa: BLE001
            raise RuntimeError(
                f"voiceblender _bridge_legs: room create failed: {e}"
            ) from e

        for leg_id in (leg_a, leg_b):
            await self._gateway._call_api(
                "POST",
                f"/v1/rooms/{room_id}/legs",
                {"leg_id": leg_id},
            )
        return room_id

    async def takeover_to_agent(self, *, agent_ws_session_id: str) -> None:
        """Finalise a human-to-agent takeover on this (caller) leg: hang
        up the bridged transfer-target leg, pull this leg back out of the
        bridge room, and re-attach a Pipecat agent so voiceblender dials
        ``/voiceblender/agent/{agent_ws_session_id}``. The worker must
        have stashed a TakeoverPayload for that session id first. See
        ``bridged_transfer.py``."""
        peer = self.bridge_peer_leg_id
        room = self.bridge_room_id
        if peer:
            await self._gateway._call_api(
                "DELETE",
                f"/v1/legs/{peer}",
                {"reason": "normal"},
                raise_on_error=False,
            )
        if room:
            await self._gateway._call_api(
                "DELETE",
                f"/v1/rooms/{room}/legs/{self.leg_id}",
                None,
                raise_on_error=False,
            )
        self.bridged = False
        self.bridge_room_id = None
        self.bridge_peer_leg_id = None
        await self._gateway._attach_pipecat(self.leg_id, agent_ws_session_id)

    async def shutdown(self) -> None:
        # Best-effort hangup. The VSI ``leg.disconnected`` listener will also
        # try to clean up; both paths are idempotent (``DELETE`` is a no-op
        # if the leg has already gone).
        await self.hangup("Session closed")


class VoiceblenderSipGateway(ConsultStateMixin, SipGateway):
    """Talks to a voiceblender instance over REST + VSI WebSocket.

    The gateway owns:

    - a single :class:`httpx.AsyncClient` for REST control,
    - a single VSI WebSocket subscriber task that fans out events to
      per-leg handlers,
    - a ``pending_attaches`` map (session_id → :class:`PendingAttach`) that
      bridges the inbound dispatch decision (made at ``leg.ringing``) to the
      WS handler that builds the Pipecat transport.

    All app-level state (live call sessions, agent lookup) is held outside
    the gateway. The worker registers itself via ``set_agent_resolver`` and
    ``set_session_lookup`` so the gateway can react to VSI events without
    pulling api_client / FastAPI into its own dependency graph.
    """

    name = "voiceblender"

    def __init__(self) -> None:
        base = os.environ.get("VOICEBLENDER_BASE_URL", "http://voiceblender:8080")
        self.base_url = base.rstrip("/")
        self.api_key = os.environ.get("VOICEBLENDER_API_KEY")
        self.app_id = os.environ.get("VOICEBLENDER_APP_ID", "aplisay-pipecat")
        # Worker's externally-reachable base URL that voiceblender will dial
        # for the audio WS — typically ``ws://pipecat-worker:8082`` inside the
        # compose network, or a public URL in cloud deploys.
        self.worker_ws_base = os.environ.get(
            "VOICEBLENDER_WORKER_WS_BASE", "ws://pipecat-worker:8082"
        ).rstrip("/")
        # Optional shared secret for VSI subscription (sent as Bearer).
        self.vsi_token = (
            os.environ.get("VOICEBLENDER_VSI_TOKEN") or self.api_key or None
        )

        # Outbound next-hop, derived from the platform-wide ``PIPECAT_SIP_*``
        # triple (same source sipbridge uses — see
        # ``sipbridge_gateway._outbound_target_uri``). Voiceblender has no
        # trunk config of its own: ``POST /v1/legs`` dials whatever SIP URI we
        # hand it, so the worker is responsible for turning a bare E.164 into a
        # routable ``sip:<e164>@<sbc>`` URI plus digest ``auth``. ``SIP_DOMAIN``
        # on the container stamps the From host from ``PIPECAT_SIP_FROM_DOMAIN``.
        self.outbound_sbc = os.environ.get("PIPECAT_SIP_OUTBOUND")
        self.sip_username = os.environ.get("PIPECAT_SIP_USERNAME")
        self.sip_password = os.environ.get("PIPECAT_SIP_PASSWORD")
        self.sip_from_domain = os.environ.get("PIPECAT_SIP_FROM_DOMAIN")

        self.pending_attaches: dict[str, PendingAttach] = {}
        # session_id → leg_id; the WS handler stores this when the WS opens
        # so the VSI subscriber can map leg-level events (transfer, hangup)
        # to the right call session.
        self._session_to_leg: dict[str, str] = {}
        self._leg_to_session: dict[str, str] = {}

        # Injected by the worker — see ``set_agent_resolver`` /
        # ``set_session_lookup``.
        self._resolve_agent: Optional[AgentResolver] = None
        self._session_lookup: Optional[Callable[[str], Optional[Any]]] = None

        self._vsi_task: Optional[asyncio.Task] = None
        self._stop = asyncio.Event()

        # Outbound originate: pending futures keyed by session_id. POST
        # ``/v1/legs`` returns synchronously with a leg_id, but the WS that
        # voiceblender opens to us is what unblocks the originate caller.
        self._pending_outbound: dict[str, asyncio.Future[_VbGatewaySession]] = {}

        # Outbound answer gate, keyed by leg_id. ``POST /v1/legs`` returns with
        # the leg in ``ringing``; the Pipecat agent can only be attached once
        # the remote answers (``leg.connected`` on VSI). originate()/consult
        # create this future before the POST and await it, then attach the
        # agent. The VSI subscriber resolves it on ``leg.connected`` or fails
        # it on ``leg.disconnected`` before connect (busy / no-answer / 401).
        self._pending_connected: dict[str, asyncio.Future[None]] = {}

        # Per-session leg-disconnected signals — set by the VSI subscriber
        # when ``leg.disconnected`` fires. The /voiceblender/agent WS
        # handler awaits this for outbound calls, where the dispatch task
        # (not the WS handler) owns running the pipeline; the handler
        # itself just needs to stay alive long enough for the dispatch
        # task to drive the transport.
        self._leg_done_events: dict[str, asyncio.Event] = {}

        # Warm-transfer state (LiveKit-parity) — shared mixin.
        self._init_consult_state()

        # Human-to-agent transfer watchers (``options.bridgedTransferToAgent``):
        # async callbacks keyed by the TRANSFER-TARGET leg id. While a
        # monitored bridge is up, ``dtmf.received`` events for that leg are
        # routed here (the target leg has no CallSession of its own). A second
        # map keyed the same way carries teardown callbacks fired when either
        # bridged leg disconnects. See ``bridged_transfer.py``.
        self._bta_digit_watchers: dict[str, Callable[[str], Awaitable[None]]] = {}
        self._bta_gone_watchers: dict[str, Callable[[], None]] = {}
        # Bridged-segment transcription (``options.bridgedTransferTranscribe``):
        # final stt.text events for a bridged human leg, keyed by leg id.
        self._bta_stt_watchers: dict[str, Callable[[str], Awaitable[None]]] = {}

    # ---- Human-to-agent transfer watchers --------------------------------

    def register_bta_watcher(
        self,
        target_leg_id: str,
        caller_leg_id: str,
        on_digit: Callable[[str], Awaitable[None]],
        on_gone: Callable[[], None],
    ) -> None:
        """Route ``dtmf.received`` for ``target_leg_id`` to ``on_digit`` and
        fire ``on_gone`` (idempotently) when either bridged leg disconnects."""
        self._bta_digit_watchers[target_leg_id] = on_digit
        self._bta_gone_watchers[target_leg_id] = on_gone
        # Caller-leg death also ends the watch; map it to the same teardown.
        self._bta_gone_watchers[caller_leg_id] = on_gone

    def register_stt_watcher(
        self, leg_id: str, on_text: Callable[[str], Awaitable[None]]
    ) -> None:
        """Route final ``stt.text`` VSI events for ``leg_id`` (a bridged
        human leg being transcribed via the container's native STT) to
        ``on_text``. See ``bridge_transcript.py``."""
        self._bta_stt_watchers[leg_id] = on_text

    def clear_bta_watcher(self, *leg_ids: str) -> None:
        for leg_id in leg_ids:
            self._bta_digit_watchers.pop(leg_id, None)
            self._bta_gone_watchers.pop(leg_id, None)
            self._bta_stt_watchers.pop(leg_id, None)

    async def start_leg_stt(
        self, leg_id: str, *, provider: str, language: Optional[str]
    ) -> None:
        """Start voiceblender's native real-time STT on a leg
        (``POST /v1/legs/{id}/stt``). Finals arrive as ``stt.text`` VSI
        events routed via :meth:`register_stt_watcher`."""
        body: dict[str, Any] = {"provider": provider, "partial": False}
        if language:
            body["language"] = language
        await self._call_api("POST", f"/v1/legs/{leg_id}/stt", body)

    async def stop_leg_stt(self, leg_id: str) -> None:
        await self._call_api(
            "DELETE", f"/v1/legs/{leg_id}/stt", None, raise_on_error=False
        )

    # ---- Injection points used by the worker ----------------------------

    def set_agent_resolver(self, resolver: AgentResolver) -> None:
        """Inject the agent-lookup callback.

        Signature: ``resolver(event) -> (instance, agent) | None`` where
        ``event`` is the raw ``leg.ringing`` JSON. The worker plugs in a
        function that runs the same phone-registration / number / trunk
        lookup chain used by Daily and FreeSWITCH.
        """
        self._resolve_agent = resolver

    def set_session_lookup(self, lookup: Callable[[str], Optional[Any]]) -> None:
        """Inject a callback for finding the live ``CallSession`` by id.

        Used by VSI event handlers (transfer state, hangup) so the gateway
        can push events into the call's transfer state machine.
        """
        self._session_lookup = lookup

    # ---- Lifecycle ------------------------------------------------------

    async def start(self) -> None:
        """Verify reachability and spawn the VSI subscriber."""
        try:
            # Voiceblender exposes no dedicated health route; ``GET /v1/legs``
            # (200 + ``[]`` when idle) is the cheapest liveness probe.
            r = await self._call_api("GET", "/v1/legs", None, raise_on_error=True)
            logger.bind(legs=r).info("voiceblender reachable")
        except Exception as e:  # noqa: BLE001
            logger.warning(f"voiceblender health check failed at boot: {e}")
        self._vsi_task = asyncio.create_task(self._vsi_loop(), name="vsi-subscriber")

    async def stop(self) -> None:
        self._stop.set()
        if self._vsi_task and not self._vsi_task.done():
            self._vsi_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._vsi_task

    # ---- SipGateway protocol --------------------------------------------

    async def setup_inbound(
        self, ctx: InboundCallContext, params: GatewaySessionParams
    ) -> GatewaySession:
        """Build a session for an inbound leg whose WS just opened.

        The WS handler (``worker.voiceblender_agent``) pre-builds the
        Pipecat transport and passes it through ``ctx.raw``; the matching
        ``leg_id`` was placed in ``pending_attaches`` by the VSI subscriber
        when ``leg.ringing`` fired.
        """
        transport = ctx.raw.get("transport")
        leg_id = ctx.raw.get("leg_id")
        if transport is None or leg_id is None:
            raise RuntimeError(
                "VoiceblenderSipGateway.setup_inbound requires raw.transport and raw.leg_id "
                "(set by the /voiceblender/agent/{session_id} WebSocket handler)"
            )
        session = _VbGatewaySession(
            transport=transport,
            session_id=params.session_id,
            leg_id=leg_id,
            _gateway=self,
        )
        self._session_to_leg[params.session_id] = leg_id
        self._leg_to_session[leg_id] = params.session_id

        # Resolve any pending outbound originate waiting on this session.
        pending = self._pending_outbound.get(params.session_id)
        if pending and not pending.done():
            pending.set_result(session)

        return session

    async def originate(
        self, params: OutboundCallParams, session_params: GatewaySessionParams
    ) -> GatewaySession:
        """Originate an outbound leg via ``POST /v1/legs``.

        Voiceblender (v0.7.x) does **not** accept an inline agent on
        ``POST /v1/legs`` and has no trunk of its own — it dials whatever SIP
        URI we hand it. So the sequence is:

          1. ``POST /v1/legs`` with ``{type:"sip", to:<routable URI>, from,
             auth, headers}`` — VB sends the INVITE and the leg is ``ringing``.
          2. await ``leg.connected`` on VSI (the remote answered).
          3. ``POST /v1/legs/{id}/agent/pipecat {websocket_url}`` — VB dials our
             worker's per-session WS.
          4. The WS handler registers the session via ``setup_inbound``, which
             resolves the future returned here.
        """
        session_id = session_params.session_id
        to_uri = self._outbound_target_uri(params)
        future: asyncio.Future[_VbGatewaySession] = (
            asyncio.get_running_loop().create_future()
        )
        self._pending_outbound[session_id] = future

        body: dict[str, Any] = {
            "type": "sip",
            "to": to_uri,
            "from": (params.caller_id or "").lstrip("+"),
            "headers": _custom_headers_for(params),
            "app_id": self.app_id,
            # Carry our call id through so it shows up downstream for correlation.
            "metadata": {"aplisay_call_id": params.call_id},
        }
        auth = self._sip_auth()
        if auth:
            body["auth"] = auth

        leg_id: Optional[str] = None
        try:
            resp = await self._call_api("POST", "/v1/legs", body)
            leg_id = (resp or {}).get("id") or (resp or {}).get("leg_id")
            if not leg_id:
                raise RuntimeError(
                    f"voiceblender POST /v1/legs did not return a leg id: {resp!r}"
                )
            # Stash a pending-attach so the WS handler can build the session.
            self.pending_attaches[session_id] = PendingAttach(
                session_id=session_id,
                leg_id=leg_id,
                instance={},  # outbound: caller provides agent/instance via the
                agent={},     # worker-side dispatch path, not via VSI lookup.
                inbound_ctx=InboundCallContext(
                    session_id=session_id,
                    called_id=params.called_id,
                    caller_id=params.caller_id,
                    aplisay_id=params.aplisay_id,
                    raw={"leg_id": leg_id, "outbound": True},
                ),
                created_at=asyncio.get_running_loop().time(),
            )
            # Block until the remote answers, then attach the Pipecat agent so
            # VB opens the audio WS back to us.
            await self._await_connected(leg_id, timeout=45.0)
            await self._attach_pipecat(leg_id, session_id)
        except Exception:
            self._pending_outbound.pop(session_id, None)
            self.pending_attaches.pop(session_id, None)
            if leg_id is not None:
                self._pending_connected.pop(leg_id, None)
            raise

        try:
            return await asyncio.wait_for(future, timeout=30.0)
        finally:
            self._pending_outbound.pop(session_id, None)

    # ---- Outbound helpers -----------------------------------------------

    def _outbound_target_uri(self, params: OutboundCallParams) -> str:
        """Turn an outbound :class:`OutboundCallParams` into a routable SIP URI.

        Voiceblender dials the URI verbatim (no outbound proxy of its own), so a
        bare ``+E164`` won't route. Mirrors the sipbridge contract
        (``sipbridge_gateway._outbound_target_uri``):

          - **Registration origin** (``registration_endpoint_id`` +
            ``b2bua_gateway_ip``): route to that registration's B2BUA on :5070.
          - **Trunk origin**: route to the global Aplisay outbound SBC
            (``PIPECAT_SIP_OUTBOUND``); the SBC fans out to the carrier using
            the ``X-Aplisay-Trunk`` header.

        A ``called_id`` that is already a ``sip:``/``sips:`` URI passes through.
        """
        dest = (params.called_id or "").strip()
        if dest.lower().startswith(("sip:", "sips:")):
            return dest
        if params.registration_endpoint_id and params.b2bua_gateway_ip:
            host = _strip_sip_scheme(params.b2bua_gateway_ip)
            authority = host if ":" in host.split(";", 1)[0] else f"{host}:5070"
            transport = params.b2bua_gateway_transport or "tcp"
            sep = "" if ";transport=" in authority else f";transport={transport}"
            return f"sip:{dest}@{authority}{sep}"
        return self._target_uri(dest)

    def _target_uri(self, dest: str) -> str:
        """Trunk-path SIP URI for a bare destination (``sip:`` passes through).

        Used by the consult / dial-bridge paths, which carry only a destination
        (no registration/B2BUA params), so they always route via the SBC."""
        dest = (dest or "").strip()
        if dest.lower().startswith(("sip:", "sips:")):
            return dest
        if not self.outbound_sbc:
            raise RuntimeError(
                "voiceblender outbound originate has no route for a trunk-origin "
                "call: set PIPECAT_SIP_OUTBOUND (host[:port][;transport=...]) to "
                "the Aplisay outbound SBC, or originate with a registration "
                "endpoint as the caller-ID"
            )
        return f"sip:{dest}@{_strip_sip_scheme(self.outbound_sbc)}"

    async def _connect_then_attach(self, leg_id: str, session_id: str) -> None:
        """Background helper for the fire-and-forget consult path: wait for the
        leg to answer, then attach the Pipecat agent. Logged-only on failure —
        the parent bot observes the outcome via ``transfer_status``."""
        try:
            await self._await_connected(leg_id, timeout=45.0)
            await self._attach_pipecat(leg_id, session_id)
        except Exception as e:  # noqa: BLE001
            logger.bind(leg_id=leg_id, session_id=session_id).warning(
                f"voiceblender consult: connect+attach failed: {e}"
            )

    def _sip_auth(self) -> Optional[dict[str, str]]:
        """Digest credentials for the outbound INVITE (401/407 challenge from
        the SBC), from the ``PIPECAT_SIP_*`` triple. ``None`` when unset."""
        if not self.sip_password:
            return None
        return {"username": self.sip_username or "", "password": self.sip_password}

    async def _await_connected(self, leg_id: str, *, timeout: float) -> None:
        """Block until VSI reports ``leg.connected`` for ``leg_id``.

        The future is resolved by :meth:`_on_leg_connected`, or failed by
        :meth:`_on_leg_disconnected` if the leg drops before answering
        (busy / no-answer / 401 unauthorized)."""
        fut = self._pending_connected.get(leg_id)
        if fut is None:
            fut = asyncio.get_running_loop().create_future()
            self._pending_connected[leg_id] = fut
        try:
            await asyncio.wait_for(fut, timeout=timeout)
        except asyncio.TimeoutError as e:
            raise RuntimeError(
                f"voiceblender leg {leg_id} did not answer within {timeout:.0f}s"
            ) from e
        finally:
            self._pending_connected.pop(leg_id, None)

    async def _attach_pipecat(self, leg_id: str, session_id: str) -> None:
        """Attach our worker as the leg's Pipecat agent — VB then opens the
        audio WS to ``/voiceblender/agent/{session_id}``."""
        ws_url = f"{self.worker_ws_base}/voiceblender/agent/{session_id}"
        await self._call_api(
            "POST",
            f"/v1/legs/{leg_id}/agent/pipecat",
            {"websocket_url": ws_url},
        )

    # ---- VSI subscriber -------------------------------------------------

    async def _vsi_loop(self) -> None:
        """Long-lived loop that reconnects on disconnect.

        Voiceblender's ``/v1/vsi`` returns a continuous JSON-per-line event
        stream. We treat reconnect as a normal lifecycle event — back off
        modestly so we don't hammer a restart.
        """
        url = self.base_url.replace("http://", "ws://").replace("https://", "wss://")
        vsi_url = f"{url}/v1/vsi"
        if self.app_id:
            vsi_url += f"?app_id={self.app_id}"
        headers = {}
        if self.vsi_token:
            headers["Authorization"] = f"Bearer {self.vsi_token}"

        backoff = 1.0
        while not self._stop.is_set():
            try:
                logger.bind(url=vsi_url).info("voiceblender VSI subscriber connecting")
                async with websockets.connect(
                    vsi_url, additional_headers=headers, max_size=None, ping_interval=30
                ) as ws:
                    logger.info("voiceblender VSI subscriber connected")
                    backoff = 1.0
                    async for raw in ws:
                        try:
                            event = json.loads(raw)
                        except Exception as e:  # noqa: BLE001
                            logger.warning(f"VSI: bad JSON: {e}; raw={raw[:200]!r}")
                            continue
                        await self._handle_vsi_event(event)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001
                logger.warning(f"VSI subscriber dropped: {e}; reconnecting in {backoff}s")
            try:
                await asyncio.wait_for(self._stop.wait(), timeout=backoff)
                return
            except asyncio.TimeoutError:
                pass
            backoff = min(backoff * 2, 30.0)

    async def _handle_vsi_event(self, event: dict) -> None:
        """Dispatch one VSI event.

        Event shape: ``{"type": "leg.ringing", "leg_id": "...", "from": "+44...",
        "to": "+44...", "custom_headers": {...}, ...}``. Voiceblender flattens
        per-type fields at the top level of the envelope (see
        ``internal/events/types.go`` MarshalJSON).
        """
        etype = event.get("type")
        if etype == "leg.ringing":
            await self._on_leg_ringing(event)
        elif etype == "leg.connected":
            await self._on_leg_connected(event)
        elif etype == "leg.disconnected":
            await self._on_leg_disconnected(event)
        elif etype == "dtmf.received":
            await self._on_leg_dtmf(event)
        elif etype == "stt.text":
            await self._on_stt_text(event)
        elif etype in {
            "leg.transfer_initiated",
            "leg.transfer_requested",
            "leg.transfer_progress",
            "leg.transfer_completed",
            "leg.transfer_failed",
        }:
            await self._on_leg_transfer(etype, event)
        else:
            # Other event types (playback, AMD, recording, etc.) are out of
            # scope — they're available on the wire if/when we want them. Log
            # at debug only.
            logger.bind(type=etype).debug("VSI event ignored")

    async def _on_leg_connected(self, event: dict) -> None:
        """``leg.connected`` — the remote answered. Release the originate /
        consult answer-gate so the agent can be attached."""
        leg_id = event.get("leg_id") or event.get("id")
        if not leg_id:
            return
        fut = self._pending_connected.get(leg_id)
        if fut is not None and not fut.done():
            fut.set_result(None)

    async def _on_stt_text(self, event: dict) -> None:
        """Handle an ``stt.text`` VSI event from the container's native STT
        (started per bridged leg by ``start_leg_stt``). Only FINAL
        transcripts are forwarded — partials are noise for a transcript.
        Envelope: ``{"type": "stt.text", "leg_id": "...", "text": "...",
        "is_final": true}``."""
        leg_id = event.get("leg_id") or event.get("id")
        text = event.get("text")
        if not leg_id or not text or not event.get("is_final", True):
            return
        watcher = self._bta_stt_watchers.get(leg_id)
        if watcher is None:
            return
        try:
            await watcher(str(text))
        except Exception as e:  # noqa: BLE001
            logger.bind(leg_id=leg_id).warning(
                f"VSI: bridged-transfer STT watcher failed: {e}"
            )

    async def _on_leg_dtmf(self, event: dict) -> None:
        """Handle a ``dtmf.received`` VSI event.

        Voiceblender decodes RFC 4733 telephone-event tones in its pion media
        layer and publishes them on the VSI stream rather than forwarding them
        over the audio WebSocket (unlike sipbridge). The envelope is::

            {"type": "dtmf.received", "leg_id": "...", "digit": "5", "seq": 1}

        We map the leg back to its live CallSession and inject the digit into
        the pipeline, where the DTMF aggregator buffers it into the
        conversation exactly like the FreeSWITCH/sipbridge paths.
        """
        leg_id = event.get("leg_id") or event.get("id")
        digit = event.get("digit")
        if not leg_id or not digit:
            logger.bind(type="dtmf.received").debug(
                f"dtmf.received without leg_id/digit: {event!r}"
            )
            return
        # Human-to-agent transfer watch: post-bridge, the transfer-target
        # leg has no CallSession — its digits go to the registered watcher
        # (see ``bridged_transfer.py``) instead of a pipeline.
        watcher = self._bta_digit_watchers.get(leg_id)
        if watcher is not None:
            try:
                await watcher(str(digit))
            except Exception as e:  # noqa: BLE001
                logger.bind(leg_id=leg_id, digit=digit).warning(
                    f"VSI: bridged-transfer DTMF watcher failed: {e}"
                )
            return
        session_id = self._leg_to_session.get(leg_id)
        if not session_id or self._session_lookup is None:
            return
        session = self._session_lookup(session_id)
        if session is None:
            return
        try:
            await session.inject_dtmf(str(digit))
        except Exception as e:  # noqa: BLE001
            logger.bind(leg_id=leg_id, digit=digit).warning(
                f"VSI: failed to inject DTMF: {e}"
            )

    async def _on_leg_ringing(self, event: dict) -> None:
        leg_id = event.get("leg_id") or event.get("id")
        if not leg_id:
            logger.warning(f"leg.ringing without leg_id: {event!r}")
            return

        # leg.ringing fires for BOTH inbound INVITEs and our own outbound
        # originate / consult / transfer legs (``leg_type`` "sip_outbound").
        # Only an inbound leg should trigger agent dispatch. Guard on leg_type:
        # the outbound leg's ringing frame can arrive on the VSI socket *before*
        # ``originate()`` has registered its pending-attach (the POST /v1/legs
        # response and the VSI frame race on the event loop), so the
        # pending_attaches check below isn't sufficient on its own — without
        # this guard we'd reject our own outbound leg as an unrouted inbound.
        leg_type = event.get("leg_type") or ""
        if "outbound" in leg_type:
            logger.bind(leg_id=leg_id, leg_type=leg_type).debug(
                "leg.ringing for outbound leg, ignoring (handled by originate)"
            )
            return

        # If this leg matches a pending OUTBOUND originate we already kicked
        # off, voiceblender is just echoing the outbound progress back. We
        # don't need to re-answer or re-attach.
        if any(p.leg_id == leg_id for p in self.pending_attaches.values()):
            logger.bind(leg_id=leg_id).debug("leg.ringing for outbound originate, ignoring")
            return

        if self._resolve_agent is None:
            logger.warning(
                "leg.ringing arrived but no agent resolver is registered — "
                "dropping. (worker startup didn't call set_agent_resolver)"
            )
            await self._reject_leg(leg_id, "configuration_error")
            return

        try:
            resolved = await self._resolve_agent(event)
        except Exception as e:  # noqa: BLE001
            logger.error(f"agent resolution failed for leg {leg_id}: {e}")
            await self._reject_leg(leg_id, "service_unavailable")
            return

        if resolved is None:
            logger.bind(leg_id=leg_id, to=event.get("to")).info(
                "no agent for inbound voiceblender call"
            )
            await self._reject_leg(leg_id, "not_found")
            return

        instance, agent = resolved
        session_id = f"vb-{uuid.uuid4()}"
        ws_url = f"{self.worker_ws_base}/voiceblender/agent/{session_id}"

        # Stash the pending attach BEFORE we tell voiceblender to dial us,
        # to avoid a race where the WS arrives before we registered the
        # pending entry.
        self.pending_attaches[session_id] = PendingAttach(
            session_id=session_id,
            leg_id=leg_id,
            instance=instance,
            agent=agent,
            inbound_ctx=InboundCallContext(
                session_id=session_id,
                called_id=event.get("to"),
                caller_id=event.get("from"),
                aplisay_id=(event.get("sip_headers") or {}).get("X-Aplisay-Trunk"),
                phone_registration=(event.get("sip_headers") or {}).get(
                    "X-Aplisay-PhoneRegistration"
                ),
                b2bua_gateway_ip=(event.get("sip_headers") or {}).get("X-Lk-RealIp"),
                b2bua_gateway_transport=(event.get("sip_headers") or {}).get(
                    "X-Lk-Transport"
                ),
                call_id=(event.get("sip_headers") or {}).get("X-Aplisay-Call-Id"),
                raw={"leg_id": leg_id, "vsi_event": event},
            ),
            created_at=asyncio.get_running_loop().time(),
        )

        try:
            await self._call_api("POST", f"/v1/legs/{leg_id}/answer", {})
            await self._call_api(
                "POST",
                f"/v1/legs/{leg_id}/agent/pipecat",
                {"websocket_url": ws_url},
            )
        except Exception as e:  # noqa: BLE001
            logger.error(f"failed to answer+attach leg {leg_id}: {e}")
            self.pending_attaches.pop(session_id, None)
            await self._reject_leg(leg_id, "service_unavailable")

    async def _on_leg_disconnected(self, event: dict) -> None:
        leg_id = event.get("leg_id") or event.get("id")
        if not leg_id:
            return
        # A bridged-transfer watch ends when either bridged leg drops.
        gone = self._bta_gone_watchers.get(leg_id)
        if gone is not None:
            try:
                gone()
            except Exception as e:  # noqa: BLE001
                logger.bind(leg_id=leg_id).warning(
                    f"VSI: bridged-transfer gone-watcher failed: {e}"
                )
        # If an originate/consult is still waiting for this leg to answer, the
        # leg dropping first means the call failed (busy / no-answer / 401).
        # Reason lives under the CDR (``cdr.reason``) on the flattened envelope.
        gate = self._pending_connected.get(leg_id)
        if gate is not None and not gate.done():
            reason = (event.get("cdr") or {}).get("reason") or "disconnected"
            gate.set_exception(
                RuntimeError(f"voiceblender leg {leg_id} ended before answer: {reason}")
            )
        session_id = self._leg_to_session.get(leg_id)
        if not session_id:
            # No live mapping — call may have ended before our WS arrived,
            # or this is a leg we never owned. Clean any orphaned pending.
            self.pending_attaches = {
                sid: p for sid, p in self.pending_attaches.items() if p.leg_id != leg_id
            }
            return
        self._session_to_leg.pop(session_id, None)
        self._leg_to_session.pop(leg_id, None)
        self.pending_attaches.pop(session_id, None)
        # Signal the WS handler (outbound calls only — inbound handlers exit
        # via _run_session returning) that the call is over and it can stop
        # holding the WebSocket open.
        ev = self._leg_done_events.get(session_id)
        if ev is not None:
            ev.set()
        # The CallSession's runner will end on transport close; nothing
        # further to do here.
        logger.bind(leg_id=leg_id, session_id=session_id).info(
            "voiceblender leg disconnected"
        )

    def wait_for_leg_done(self, session_id: str) -> asyncio.Event:
        """Return (creating if necessary) the per-session leg-done event.

        Used by the ``/voiceblender/agent/{session_id}`` WebSocket handler
        on the outbound path to stay alive until voiceblender reports the
        leg gone.
        """
        ev = self._leg_done_events.get(session_id)
        if ev is None:
            ev = asyncio.Event()
            self._leg_done_events[session_id] = ev
        return ev

    def release_leg_done(self, session_id: str) -> None:
        """Drop the per-session leg-done event after the handler unwinds."""
        self._leg_done_events.pop(session_id, None)

    async def _on_leg_transfer(self, etype: str, event: dict) -> None:
        leg_id = event.get("leg_id") or event.get("id")
        if not leg_id:
            return
        session_id = self._leg_to_session.get(leg_id)
        if not session_id or self._session_lookup is None:
            return
        session = self._session_lookup(session_id)
        if session is None:
            return
        # Map VSI transfer events to our transfer_state taxonomy. The exact
        # shape mirrors how the FreeSWITCH path drives transfer_state via
        # esl-poller events.
        state_map = {
            "leg.transfer_initiated": ("initiated", "Transfer initiated"),
            "leg.transfer_requested": ("requested", "Transfer requested"),
            "leg.transfer_progress": (
                "in_progress",
                event.get("reason")
                or (f"SIP {event['status_code']}" if event.get("status_code") else None)
                or "Transfer in progress",
            ),
            "leg.transfer_completed": ("completed", "Transfer completed"),
            "leg.transfer_failed": ("failed", event.get("reason") or "Transfer failed"),
        }
        state, description = state_map.get(etype, ("unknown", etype))
        try:
            session.transfer_state.state = state
            session.transfer_state.description = description
        except Exception as e:  # noqa: BLE001
            logger.warning(f"VSI: failed to update transfer state: {e}")

    # ---- HTTP plumbing --------------------------------------------------

    async def _reject_leg(self, leg_id: str, reason: str) -> None:
        await self._call_api(
            "DELETE",
            f"/v1/legs/{leg_id}",
            {"reason": reason},
            raise_on_error=False,
        )

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
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.request(method, url, headers=headers, json=body)
        if resp.status_code >= 400:
            msg = f"voiceblender {method} {path} -> {resp.status_code} {resp.text}"
            if raise_on_error:
                raise RuntimeError(msg)
            logger.warning(msg)
            return None
        if resp.headers.get("content-type", "").startswith("application/json"):
            return resp.json()
        return None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _custom_headers_for(params: OutboundCallParams) -> dict[str, str]:
    """Return the X-Aplisay-* headers to stamp on the outbound INVITE.

    See section 6 of docs/livekit-agent-architecture.md.
    """
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


def _strip_sip_scheme(authority: str) -> str:
    """Drop a leading ``sip:`` / ``sips:`` from a host/authority value so it can
    be embedded after ``sip:<user>@`` without producing ``sip:...@sip:...``.
    Mirrors ``sipbridge_gateway._strip_sip_scheme``."""
    a = (authority or "").strip()
    low = a.lower()
    if low.startswith("sips:"):
        return a[5:]
    if low.startswith("sip:"):
        return a[4:]
    return a


def _vb_reason_for(reason: str) -> str:
    """Map our disconnect taxonomy onto voiceblender's leg ``reason`` enum.

    Voiceblender accepts free-form reasons but translates a known set into
    SIP cause codes. ``normal_clearing`` is the safe default.
    """
    mapping = {
        "Agent initiated hangup": "normal_clearing",
        "Session timeout": "no_answer",
        "Session closed": "normal_clearing",
    }
    return mapping.get(reason, "normal_clearing")
