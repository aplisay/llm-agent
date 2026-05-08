"""Pipecat worker entry — FastAPI service implementing the worker tier.

Endpoints:

- ``POST /dispatch`` — called by ``lib/handlers/pipecat.js`` to start an
  outbound call. Bearer-authenticated with ``PIPECAT_DISPATCH_TOKEN``.
- ``POST /webrtc/offer`` — browser join entry. Validates a join token minted by
  ``Handler.join`` and negotiates a peer-to-peer WebRTC session via
  ``SmallWebRTCTransport``. Independent of the SIP gateway.
- ``POST /daily/dialin`` — Daily's pinless dial-in webhook. Looks up the
  PhoneEndpoint from llm-agent, builds an :class:`InboundCallContext`, and
  spawns a :class:`CallSession`.

The worker remains gateway-agnostic above the ``sip_gateway`` indirection;
swapping to FreeSWITCH or any other SIP termination is purely a question of
plugging in a different :class:`SipGateway` (and replacing the Daily webhook
with whatever the new gateway uses to signal a new INVITE).
"""

from __future__ import annotations

import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from loguru import logger
from pipecat.pipeline.runner import PipelineRunner
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.network.small_webrtc import SmallWebRTCTransport

from . import api_client
from .auth import require_dispatch_token, verify_join_token
from .call_session import (
    CallSession,
    setup_inbound_call,
    setup_outbound_call,
)
from .constants import DISCONNECT_REASONS
from .invocation_log import flush_invocation_logs
from .sip_gateway import DailySipGateway, InboundCallContext


@asynccontextmanager
async def lifespan(app: FastAPI):
    # SIP gateway is selected at startup. Default to Daily; swap by setting
    # SIP_GATEWAY=freeswitch (for example) once that implementation lands.
    gateway_name = os.environ.get("SIP_GATEWAY", "daily").lower()
    if gateway_name == "daily":
        app.state.sip_gateway = DailySipGateway()
    else:
        raise RuntimeError(f"unsupported SIP_GATEWAY={gateway_name!r}")
    app.state.live_calls: dict[str, CallSession] = {}
    yield
    # Best-effort flush on shutdown — section 8.4 of the architecture doc.
    try:
        await flush_invocation_logs()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"invocation log flush failed on shutdown: {e}")


app = FastAPI(lifespan=lifespan)


@app.post("/dispatch")
async def dispatch(request: Request, authorization: Optional[str] = Header(default=None)):
    require_dispatch_token(authorization)
    payload = await request.json()
    kind = payload.get("kind")
    logger.info({"kind": kind, "payload": payload}, "dispatch received")

    if kind == "outbound":
        return await _handle_outbound_dispatch(request.app, payload)

    raise HTTPException(status_code=400, detail=f"unknown dispatch kind {kind!r}")


async def _handle_outbound_dispatch(app: FastAPI, payload: dict) -> dict:
    instance = await api_client.get_instance_by_id(payload["instanceId"])
    if not instance:
        raise HTTPException(status_code=404, detail="instance not found")
    agent = instance.get("Agent")
    if not agent:
        raise HTTPException(status_code=404, detail="agent not found on instance")

    # Daily-specific: create the room + token before originating. For the
    # FreeSWITCH path this would be replaced with an RTC bridge target. The
    # session params carry the Daily room url/token through to the gateway.
    room_url, token = await _create_daily_room(dial_out=True)

    session = await setup_outbound_call(
        app.state.sip_gateway,
        session_id=payload["sessionId"],
        call_id=payload["callId"],
        instance=instance,
        agent=agent,
        caller_id=payload["callerId"],
        called_id=payload["calledId"],
        aplisay_id=payload.get("aplisayId"),
        extra_session_params={"room_url": room_url, "token": token},
    )
    app.state.live_calls[payload["callId"]] = session

    asyncio.create_task(_run_session(app, session, payload["callId"]))
    return {"ok": True, "callId": payload["callId"]}


async def _run_session(app: FastAPI, session: CallSession, key: str) -> None:
    try:
        await session.run(system_prompt=session.agent.get("prompt") or "")
    except api_client.AgentConcurrencyLimitExceededBusyError as e:
        logger.warning(f"call rejected by concurrency: {e}")
    except Exception as e:  # noqa: BLE001
        logger.error(f"call session failed: {e}")
        try:
            await api_client.end_call(session.call, reason=DISCONNECT_REASONS["UNCAUGHT_ERROR_RUNNING_AGENT"])
        except Exception as inner:  # noqa: BLE001
            logger.error(f"end_call after failure failed: {inner}")
    finally:
        app.state.live_calls.pop(key, None)
        try:
            await session.gateway_session.shutdown()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"gateway shutdown failed: {e}")


# ---- Daily inbound webhook ----


@app.post("/daily/dialin")
async def daily_dialin(request: Request) -> dict:
    """Daily's pinless dial-in webhook entry.

    Daily sends ``dialin_settings`` (``call_id`` + ``call_domain``), the caller's
    ``From`` and ``To`` numbers, and other identifiers. We map those to an
    :class:`InboundCallContext`, look up the agent via the lookup chain in
    section 6.2 / 6.3, and bring up a session.
    """
    body = await request.json()
    logger.info({"body": body}, "daily dial-in webhook")

    dialin = body.get("dialin_settings") or {}
    from_number = body.get("From") or body.get("from")
    to_number = body.get("To") or body.get("to")

    # SIP custom headers, if Daily surfaces them. The keys here mirror the
    # contract; degrade gracefully when missing.
    headers = body.get("sip_headers") or {}
    aplisay_id = headers.get("X-Aplisay-Trunk")
    phone_registration = headers.get("X-Aplisay-PhoneRegistration")

    if not to_number:
        raise HTTPException(status_code=400, detail="missing destination number")

    # Lookup chain — section 6.2 / 6.3.
    instance = None
    if phone_registration:
        endpoint = await api_client.get_phone_endpoint_by_id(phone_registration)
        if endpoint and endpoint.get("instanceId"):
            instance = await api_client.get_instance_by_id(endpoint["instanceId"])
    if not instance:
        endpoint = await api_client.get_phone_endpoint_by_number(to_number, aplisay_id)
        if endpoint and endpoint.get("instanceId"):
            instance = await api_client.get_instance_by_id(endpoint["instanceId"])
    if not instance:
        instance = await api_client.get_instance_by_number(to_number)
    if not instance:
        raise HTTPException(status_code=404, detail="no instance found for number")

    agent = instance.get("Agent")
    if not agent:
        raise HTTPException(status_code=404, detail="instance has no agent")

    room_url, token = await _create_daily_room(dial_in=True)
    session_id = f"inbound-{uuid.uuid4()}"

    ctx = InboundCallContext(
        session_id=session_id,
        called_id=to_number,
        caller_id=from_number,
        aplisay_id=aplisay_id,
        phone_registration=phone_registration,
        b2bua_gateway_ip=headers.get("X-Lk-RealIp"),
        b2bua_gateway_transport=headers.get("X-Lk-Transport"),
        call_id=headers.get("X-Aplisay-Call-Id"),
        raw={"dialin_settings": dialin, "room_url": room_url, "token": token},
    )

    session = await setup_inbound_call(
        request.app.state.sip_gateway, ctx, instance=instance, agent=agent
    )
    request.app.state.live_calls[session.call.id] = session

    asyncio.create_task(_run_session(request.app, session, session.call.id))

    # Respond with the Daily room so Daily can pinlessCallUpdate the caller in.
    return {"room_url": room_url, "sip_endpoint": dialin.get("sip_endpoint")}


# ---- WebRTC offer (browser join — independent of SIP gateway) ----


@app.post("/webrtc/offer")
async def webrtc_offer(request: Request) -> JSONResponse:
    body = await request.json()
    token = body.get("token")
    if not token:
        raise HTTPException(status_code=400, detail="missing token")
    payload = verify_join_token(token)

    instance = await api_client.get_instance_by_id(payload.instance_id)
    if not instance:
        raise HTTPException(status_code=404, detail="instance not found")
    agent = instance.get("Agent")
    if not agent:
        raise HTTPException(status_code=404, detail="instance has no agent")

    # Create the WebRTC connection per the SmallWebRTCTransport handshake.
    from pipecat.transports.network.webrtc_connection import (
        SmallWebRTCConnection,
    )

    sdp = body.get("sdp")
    sdp_type = body.get("type")
    if not sdp or not sdp_type:
        raise HTTPException(status_code=400, detail="missing sdp / type")

    pc = SmallWebRTCConnection()
    answer = await pc.create_answer({"sdp": sdp, "type": sdp_type})

    transport = SmallWebRTCTransport(
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
        webrtc_connection=pc,
    )

    # Use a stub call record for browser sessions — they don't go through the
    # full call/start REST flow, but we still log to llm-agent via the sendMessage
    # path. A non-persistent CallRecord is enough.
    call = api_client.CallRecord(
        id=str(uuid.uuid4()),
        userId=agent["userId"],
        organisationId=agent["organisationId"],
        instanceId=instance["id"],
        agentId=agent["id"],
        metadata={
            "aplisay": {
                "callerId": "WebRTC",
                "calledId": "WebRTC",
                "model": agent["modelName"],
            },
        },
    )

    # The browser session is owned by the same orchestration as a phone call.
    from .call_session import CallSession, TransferState
    from .sip_gateway.base import GatewaySession as _GW

    class _BrowserGatewaySession(_GW):
        def __init__(self, transport, session_id):
            self.transport = transport
            self.session_id = session_id

        async def hangup(self, reason: str) -> None:
            await self.transport.stop()

        async def transfer(self, _req) -> None:
            raise RuntimeError("transfer not supported in browser sessions")

        async def shutdown(self) -> None:
            await self.transport.stop()

    session = CallSession(
        session_id=payload.session_id,
        agent=agent,
        instance=instance,
        sip_gateway=request.app.state.sip_gateway,
        gateway_session=_BrowserGatewaySession(transport, payload.session_id),
        call=call,
    )
    request.app.state.live_calls[call.id] = session
    asyncio.create_task(_run_session(request.app, session, call.id))

    return JSONResponse({"sdp": answer["sdp"], "type": answer["type"]})


# ---- Daily REST helper ----


async def _create_daily_room(*, dial_in: bool = False, dial_out: bool = False) -> tuple[str, str]:
    """Provision a Daily room with SIP capabilities and mint a bot token.

    The room is short-lived and torn down by Daily once the bot leaves. Daily
    REST API base URL and key come from DAILY_API_URL / DAILY_API_KEY.
    """
    api_key = os.environ["DAILY_API_KEY"]
    api_url = os.environ.get("DAILY_API_URL", "https://api.daily.co/v1")

    properties: dict[str, Any] = {"exp": int(asyncio.get_event_loop().time()) + 3600}
    if dial_in or dial_out:
        properties["sip"] = {"sip_mode": "dial-in" if dial_in else "dial-out", "num_endpoints": 1}
    if dial_out:
        properties["enable_dialout"] = True

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            f"{api_url}/rooms",
            json={"properties": properties},
            headers={"Authorization": f"Bearer {api_key}"},
        )
        resp.raise_for_status()
        room = resp.json()

        token_resp = await client.post(
            f"{api_url}/meeting-tokens",
            json={"properties": {"room_name": room["name"], "is_owner": True}},
            headers={"Authorization": f"Bearer {api_key}"},
        )
        token_resp.raise_for_status()
        token = token_resp.json()["token"]

    return room["url"], token
