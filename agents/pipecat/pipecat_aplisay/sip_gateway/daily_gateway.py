"""Daily SIP gateway implementation.

Daily here is a *pure SIP gateway*: it terminates SIP and bridges audio into a
Daily room which the worker joins via DailyTransport. Daily's WebRTC role is
incidental — the room is just where the media meets the agent. Number ownership,
trunk routing, and outbound trunk selection are external to this gateway and
the worker can rebind to a different :class:`SipGateway` (e.g. FreeSWITCH +
DailyTransport replaced with something else) without changes elsewhere.

Known contract gaps relative to docs/livekit-agent-architecture.md (sections 6
and 7 of that doc are written assuming you operate the SBC):

- Custom inbound SIP headers (``X-Aplisay-Trunk``,
  ``X-Aplisay-PhoneRegistration``, ``X-Lk-RealIp``, ``X-Lk-Transport``) cannot be
  read directly from Daily's transport. Inbound dispatch encodes the
  trunk/registration identity in the ``InboundCallContext`` constructed by the
  Daily webhook handler in worker.py — that handler is the one component that
  needs to talk to Daily's REST API to look up the SIP details.
- Outbound stamping of ``X-Aplisay-Origin-Caller-Id`` and ``X-Aplisay-Call-Id``
  on the wire requires Daily's ``sipHeaders`` parameter on the dial-out call
  client API; we set it where the SDK exposes it and document the gap where it
  doesn't.
- Transfer is blind only via ``sip_call_transfer``; consultative transfer is
  emulated with a separate dial-out leg. REFER vs blind-bridge selection per
  6.7 still applies but always lands on Daily's blind-bridge mechanics today.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any, Optional

from loguru import logger
from pipecat.transports.base_transport import BaseTransport
from pipecat.transports.daily.transport import (
    DailyDialinSettings,
    DailyParams,
    DailyTransport,
)

from .base import (
    GatewaySession,
    GatewaySessionParams,
    InboundCallContext,
    OutboundCallParams,
    SipGateway,
    TransferRequest,
)


@dataclass
class _DailyGatewaySession(GatewaySession):
    transport: DailyTransport
    session_id: str
    _gateway: "DailySipGateway"

    async def hangup(self, reason: str) -> None:
        # Daily's transport closes the room when the bot leaves. The room
        # cleanup itself is fire-and-forget; the gateway's caller drives
        # disconnect-reason logging via the call lifecycle layer.
        logger.info({"session_id": self.session_id, "reason": reason}, "daily session hangup")
        try:
            await self.transport.stop()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"daily transport stop failed: {e}")

    async def transfer(self, req: TransferRequest) -> None:
        # Daily exposes blind transfer via SIP REFER under the hood; consultative
        # acceptance currently lands on blind-bridge per section 6.10. Caller-ID
        # override and X-Aplisay-Call-Id stamping require Daily's `headers`
        # parameter on the transfer settings — pass through what the SDK accepts.
        settings: dict[str, Any] = {"toEndPoint": req.destination}
        if req.caller_id_override:
            settings["displayName"] = req.caller_id_override
        err = await self.transport.sip_call_transfer(settings)  # type: ignore[arg-type]
        if err is not None:
            raise RuntimeError(f"sip_call_transfer failed: {err}")

    async def shutdown(self) -> None:
        try:
            await self.transport.stop()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"daily transport shutdown failed: {e}")


class DailySipGateway(SipGateway):
    name = "daily"

    def __init__(self) -> None:
        self.api_key = os.environ.get("DAILY_API_KEY")
        self.api_url = os.environ.get("DAILY_API_URL", "https://api.daily.co/v1")
        if not self.api_key:
            raise RuntimeError("DAILY_API_KEY is required for the Daily SIP gateway")

    async def setup_inbound(
        self, ctx: InboundCallContext, params: GatewaySessionParams
    ) -> GatewaySession:
        # Inbound expects the caller to have arrived on a Daily-provisioned SIP
        # endpoint via the pinless dial-in webhook (see worker.py's
        # /daily/dialin handler). The webhook layer creates the room and passes
        # the call_id / call_domain in via raw["dialin_settings"].
        dialin = ctx.raw.get("dialin_settings")
        room_url = ctx.raw.get("room_url")
        token = ctx.raw.get("token")
        if not dialin or not room_url or not token:
            raise RuntimeError(
                "Daily inbound context missing dialin_settings/room_url/token"
            )

        transport = DailyTransport(
            room_url,
            token,
            "Aplisay Bot",
            DailyParams(
                api_key=self.api_key,
                api_url=self.api_url,
                dialin_settings=DailyDialinSettings(**dialin),
                audio_in_enabled=True,
                audio_out_enabled=True,
            ),
        )
        return _DailyGatewaySession(transport=transport, session_id=params.session_id, _gateway=self)

    async def originate(
        self, params: OutboundCallParams, session_params: GatewaySessionParams
    ) -> GatewaySession:
        # Caller is responsible for creating the Daily room with dial-out
        # enabled and providing the room_url / token via the worker dispatch
        # path. We accept those inputs here from session_params via attribute
        # extension for now; in the full implementation room creation moves
        # into this gateway and we surface the URL+token internally.
        room_url = getattr(session_params, "room_url", None)
        token = getattr(session_params, "token", None)
        if not room_url or not token:
            raise RuntimeError(
                "Daily outbound: room_url/token must be supplied via session_params"
            )

        transport = DailyTransport(
            room_url,
            token,
            "Aplisay Bot",
            DailyParams(
                api_key=self.api_key,
                api_url=self.api_url,
                audio_in_enabled=True,
                audio_out_enabled=True,
            ),
        )

        # start_dialout accepts either a phone number (Daily PSTN) or a SIP URI
        # (BYOC trunk). Section 6.4/6.5 wire-header stamping happens in the
        # `headers` field of dial-out settings where Daily exposes it.
        await transport.start_dialout(
            {
                "phoneNumber": params.called_id,
                "displayName": params.caller_id,
                # Daily passes through these as SIP headers on the outbound INVITE.
                "sipHeaders": {
                    "X-Aplisay-Trunk": params.aplisay_id or "",
                    "X-Aplisay-Origin-Caller-Id": params.caller_id,
                    "X-Aplisay-Call-Id": params.call_id,
                },
            }
        )
        return _DailyGatewaySession(transport=transport, session_id=session_params.session_id, _gateway=self)
