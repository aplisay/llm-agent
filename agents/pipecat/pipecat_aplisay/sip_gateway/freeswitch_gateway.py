"""FreeSWITCH SIP gateway implementation.

Architecture:

- **Media path**: FreeSWITCH ``mod_audio_stream`` opens an outbound WebSocket
  from FS to the Pipecat worker (``/freeswitch/audio`` route), carrying L16 PCM
  16kHz mono in both directions plus JSON metadata events.
- **Control path**: an HTTP client to the **esl-poller** sidecar (the
  TypeScript service in ``agents/pipecat/esl-poller``, which extends the
  aplisay-b2bua esl-poller with a call-control HTTP API). This worker does not
  speak ESL directly — esl-poller owns the FreeSWITCH connection and exposes
  ``POST /calls/originate`` / ``POST /calls/:uuid/transfer`` /
  ``POST /calls/:uuid/hangup`` to drive it.
- **Signalling**: FreeSWITCH is the SBC. All ``X-Aplisay-*`` wire headers from
  section 6 of docs/livekit-agent-architecture.md are stamped/read by the
  dialplan in ``freeswitch/conf/dialplan/default.xml``.

Inbound calls arrive at the worker through the WebSocket connection itself —
mod_audio_stream opens to ``/freeswitch/audio`` and sends a JSON ``start``
event with the channel variables the dialplan set. The HTTP `/freeswitch/audio`
endpoint registered in :mod:`pipecat_aplisay.worker` is the inbound entry point.

Outbound is driven by :meth:`FreeswitchSipGateway.originate`, which POSTs to the
esl-poller. The new channel calls back into the worker via mod_audio_stream,
where the matching pending future is resolved.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from dataclasses import dataclass, field
from typing import Optional

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
class _FsGatewaySession(GatewaySession):
    transport: BaseTransport
    session_id: str
    channel_uuid: str
    _gateway: "FreeswitchSipGateway"

    async def hangup(self, reason: str) -> None:
        logger.bind(channel_uuid=self.channel_uuid, reason=reason).info("freeswitch hangup")
        await self._gateway._call_api(
            "POST",
            f"/calls/{self.channel_uuid}/hangup",
            {"cause": _sip_cause_for(reason)},
            raise_on_error=False,
        )

    async def transfer(self, req: TransferRequest) -> None:
        """Route the transfer through esl-poller.

          - ``blind``: maps to esl-poller's ``refer`` (uuid_deflect)
            when REFER is available, or ``bridge`` (originate + bridge)
            otherwise / when ``force_bridged`` is set.
          - ``consultative``: LiveKit-parity warm-transfer flow — dials
            a consult leg via esl-poller, the new channel's
            mod_audio_stream connects to our worker, the worker spawns
            a TransferAgent CallSession. Returns immediately. See
            ``docs/call-transfers.md``.
        """
        op = req.operation or "blind"
        if op == "consultative":
            await self._do_consultative(req)
            return
        if op != "blind":
            raise RuntimeError(
                f"freeswitch: unknown transfer operation {op!r} "
                "(expected 'blind' or 'consultative')"
            )
        operation = "refer" if (req.can_refer and not req.force_bridged) else "bridge"
        await self._gateway._call_api(
            "POST",
            f"/calls/{self.channel_uuid}/transfer",
            {
                "destination": req.destination,
                "operation": operation,
                "callerIdOverride": req.caller_id_override,
            },
        )

    async def _do_consultative(self, req: TransferRequest) -> None:
        """Fire-and-forget consultative-transfer initiation.

        Dials a fresh outbound channel via esl-poller's
        ``POST /calls/originate``. The new channel's mod_audio_stream
        connects back to our worker on ``/freeswitch/audio``; the
        worker's WS handler discriminates this channel as a consult
        via ``consult_payload`` (keyed by ``channel_uuid`` — which we
        set explicitly here so the start event matches).
        """
        consult_channel_uuid = str(uuid.uuid4())
        # session_id == channel_uuid for FreeSWITCH consult — keeps the
        # mixin's payload lookup straightforward when the audio start
        # event arrives (the WS handler uses start.channel_uuid as the
        # lookup key).
        self._gateway.register_consult_session(
            consult_session_id=consult_channel_uuid,
            parent_session_id=self.session_id,
            transfer_prompt_template=req.transfer_prompt_template or "",
            parent_transcript=req.parent_transcript or "",
        )

        logger.bind(
            original_channel=self.channel_uuid,
            consult_channel=consult_channel_uuid,
            target=req.destination,
        ).info("freeswitch consultative: dialing third party")

        try:
            await self._gateway._call_api(
                "POST",
                "/calls/originate",
                {
                    "destination": req.destination,
                    "callerId": req.caller_id_override or "",
                    # callId is required by esl-poller for the
                    # outbound origination metadata; reuse the consult
                    # channel uuid so logs correlate.
                    "callId": consult_channel_uuid,
                    "channelUuid": consult_channel_uuid,
                },
            )
        except Exception:
            self._gateway.clear_consult_session(consult_channel_uuid)
            raise

        # Record the consult call_id (channel uuid for FreeSWITCH) so
        # accept/reject tools on the TransferAgent can target it.
        self._gateway.set_consult_call_id(self.session_id, consult_channel_uuid)
        logger.bind(
            consult_channel=consult_channel_uuid,
        ).info("freeswitch consultative: consult leg requested; "
               "TransferAgent will spawn when mod_audio_stream connects")

    async def bridge_with(self, other: GatewaySession) -> None:
        """Install a media bridge between this session's channel and
        ``other``'s channel via esl-poller's ``POST /calls/{uuid}/bridge``
        (which runs FreeSWITCH's ``uuid_bridge`` ESL command).
        """
        if not isinstance(other, _FsGatewaySession):
            raise NotImplementedError(
                f"freeswitch bridge_with: peer must be _FsGatewaySession, "
                f"got {type(other).__name__}"
            )
        await self._gateway._call_api(
            "POST",
            f"/calls/{self.channel_uuid}/bridge",
            {"peerUuid": other.channel_uuid},
        )

    async def shutdown(self) -> None:
        await self.hangup("Session closed")


class FreeswitchSipGateway(ConsultStateMixin, SipGateway):
    """Talks to the esl-poller sidecar over HTTP.

    No direct FreeSWITCH connection; the sidecar owns the ESL socket. This
    keeps the language boundary clean (Python worker, TypeScript ESL handler
    reusing aplisay-b2bua's library and ecosystem) and lets either side be
    redeployed independently.
    """

    name = "freeswitch"

    def __init__(self) -> None:
        base = os.environ.get("ESL_POLLER_URL", "http://esl-poller:4001")
        self.base_url = base.rstrip("/")
        self.token = os.environ.get("ESL_POLLER_TOKEN") or os.environ.get("CALL_API_TOKEN")
        self._pending_outbound: dict[str, asyncio.Future[_FsGatewaySession]] = {}
        # Warm-transfer state (LiveKit-parity) — shared mixin.
        self._init_consult_state()

    async def start(self) -> None:
        # No persistent connection; verify reachability via the poller's health.
        try:
            await self._call_api("GET", "/health", None, raise_on_error=True)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"esl-poller health check failed: {e}")

    async def setup_inbound(
        self, ctx: InboundCallContext, params: GatewaySessionParams
    ) -> GatewaySession:
        """FS inbound flow is upside-down compared to Daily.

        FreeSWITCH connects to the worker first via mod_audio_stream. That
        WebSocket endpoint constructs an InboundCallContext from the start
        event's channel variables, builds a FastAPIWebsocketTransport for
        Pipecat, and then calls this method passing the pre-built transport
        and channel UUID in ``ctx.raw``.
        """
        transport = ctx.raw.get("transport")
        channel_uuid = ctx.raw.get("channel_uuid")
        if transport is None or channel_uuid is None:
            raise RuntimeError(
                "FreeswitchSipGateway.setup_inbound requires raw.transport and raw.channel_uuid "
                "(set by the /freeswitch/audio WebSocket handler)"
            )
        return _FsGatewaySession(
            transport=transport,
            session_id=params.session_id,
            channel_uuid=channel_uuid,
            _gateway=self,
        )

    async def originate(
        self, params: OutboundCallParams, session_params: GatewaySessionParams
    ) -> GatewaySession:
        """POST to the esl-poller; wait for the new channel to call back.

        The new channel ID is assigned by the worker (origination_uuid) so we
        can register a pending future before issuing the originate.
        """
        channel_uuid = str(uuid.uuid4())
        future: asyncio.Future[_FsGatewaySession] = asyncio.get_running_loop().create_future()
        self._pending_outbound[channel_uuid] = future

        try:
            await self._call_api(
                "POST",
                "/calls/originate",
                {
                    "destination": params.called_id,
                    "callerId": params.caller_id,
                    "callId": params.call_id,
                    "aplisayId": params.aplisay_id,
                    "channelUuid": channel_uuid,
                },
            )
        except Exception:
            self._pending_outbound.pop(channel_uuid, None)
            raise

        try:
            return await asyncio.wait_for(future, timeout=30.0)
        finally:
            self._pending_outbound.pop(channel_uuid, None)

    def register_inbound_session(
        self, *, channel_uuid: str, transport: BaseTransport, session_id: str
    ) -> _FsGatewaySession:
        """Called by the /freeswitch/audio WS handler when a channel opens.

        If the channel matches a pending outbound originate, also resolves the
        future from :meth:`originate`.
        """
        session = _FsGatewaySession(
            transport=transport,
            session_id=session_id,
            channel_uuid=channel_uuid,
            _gateway=self,
        )
        pending = self._pending_outbound.get(channel_uuid)
        if pending and not pending.done():
            pending.set_result(session)
        return session

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
        if self.token:
            headers["authorization"] = f"Bearer {self.token}"
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.request(method, url, headers=headers, json=body)
        if resp.status_code >= 400:
            msg = f"esl-poller {method} {path} -> {resp.status_code} {resp.text}"
            if raise_on_error:
                raise RuntimeError(msg)
            logger.warning(msg)
            return None
        if resp.headers.get("content-type", "").startswith("application/json"):
            return resp.json()
        return None


def _sip_cause_for(reason: str) -> str:
    """Map our disconnect reasons to SIP cause codes for uuid_kill."""
    mapping = {
        "Agent initiated hangup": "NORMAL_CLEARING",
        "Session timeout": "NO_ANSWER",
        "Session closed": "NORMAL_CLEARING",
    }
    return mapping.get(reason, "NORMAL_CLEARING")
