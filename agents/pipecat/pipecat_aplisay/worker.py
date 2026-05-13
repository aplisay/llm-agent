"""Pipecat worker entry — FastAPI service implementing the worker tier.

Endpoints:

- ``POST /dispatch`` — called by ``lib/handlers/pipecat.js`` to start an
  outbound call. Bearer-authenticated with ``PIPECAT_DISPATCH_TOKEN``.
- ``POST /webrtc/offer`` — browser join entry. Validates a join token minted by
  ``Handler.join`` and negotiates a peer-to-peer WebRTC session via
  ``SmallWebRTCTransport``. Independent of the SIP gateway.
- ``POST /daily/dialin`` — Daily's pinless dial-in webhook (Daily gateway only).
- ``WS /freeswitch/audio`` — FreeSWITCH ``mod_audio_stream`` connects here on
  every call. The start event metadata drives inbound dispatch.
- ``POST /freeswitch/events`` — esl-poller webhook for channel-level events
  (CHANNEL_HANGUP, CHANNEL_BRIDGE, CHANNEL_ANSWER).

The worker remains gateway-agnostic above the ``sip_gateway`` indirection;
``SIP_GATEWAY=daily|freeswitch`` selects the implementation at startup.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from loguru import logger
from pipecat.pipeline.runner import PipelineRunner
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.network.small_webrtc import SmallWebRTCTransport
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)

from . import api_client
from .auth import require_dispatch_token, verify_join_token
from .call_session import (
    CallSession,
    setup_inbound_call,
    setup_outbound_call,
)
from .constants import DISCONNECT_REASONS
from .invocation_log import flush_invocation_logs
from .serializers import FreeSwitchAudioStreamSerializer
from .serializers.freeswitch_audio_stream import FreeSwitchAudioStreamStart
from .sip_gateway import (
    DailySipGateway,
    FreeswitchSipGateway,
    InboundCallContext,
)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # SIP gateway is selected at startup. SIP_GATEWAY=daily|freeswitch.
    gateway_name = os.environ.get("SIP_GATEWAY", "freeswitch").lower()
    if gateway_name == "daily":
        app.state.sip_gateway = DailySipGateway()
    elif gateway_name == "freeswitch":
        gw = FreeswitchSipGateway()
        app.state.sip_gateway = gw
        try:
            await gw.start()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"freeswitch gateway start failed at boot: {e}")
    else:
        raise RuntimeError(f"unsupported SIP_GATEWAY={gateway_name!r}")
    app.state.live_calls: dict[str, CallSession] = {}
    app.state.calls_by_channel: dict[str, str] = {}
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

    sip_gateway = app.state.sip_gateway
    extra_session_params: dict[str, Any] = {}
    if isinstance(sip_gateway, DailySipGateway):
        # Daily: provision a room with dial-out enabled before originating;
        # carry the URL + token through to the gateway via session params.
        room_url, token = await _create_daily_room(dial_out=True)
        extra_session_params = {"room_url": room_url, "token": token}
    # FreeSWITCH path needs no pre-provisioning — esl-poller will originate
    # and the new channel's mod_audio_stream calls back into /freeswitch/audio,
    # where register_inbound_session() resolves the originate future.

    session = await setup_outbound_call(
        sip_gateway,
        session_id=payload["sessionId"],
        call_id=payload["callId"],
        instance=instance,
        agent=agent,
        caller_id=payload["callerId"],
        called_id=payload["calledId"],
        aplisay_id=payload.get("aplisayId"),
        extra_session_params=extra_session_params or None,
    )
    app.state.live_calls[payload["callId"]] = session
    # Track the channel-to-call mapping so /freeswitch/events can find the
    # session.
    fs_session = getattr(session, "gateway_session", None)
    channel_uuid = getattr(fs_session, "channel_uuid", None)
    if channel_uuid:
        app.state.calls_by_channel[channel_uuid] = payload["callId"]

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


# ---- FreeSWITCH WebSocket (mod_audio_stream) ----


@app.websocket("/freeswitch/audio")
async def freeswitch_audio(websocket: WebSocket) -> None:
    """Long-lived WebSocket for one call.

    FreeSWITCH's ``mod_audio_stream`` opens this socket on every answered call
    (the dialplan kicks it off with ``execute_on_answer=audio_stream start
    ${pipecat_ws_url} mono 16k``). The first text frame is the ``start`` event
    carrying our channel variables; from there we look up the agent, build a
    FastAPI WebSocket transport with the FreeSwitchAudioStreamSerializer, and
    spawn the call session.
    """
    await websocket.accept()

    sip_gateway = websocket.app.state.sip_gateway
    if not isinstance(sip_gateway, FreeswitchSipGateway):
        logger.warning("/freeswitch/audio invoked but SIP_GATEWAY != freeswitch")
        await websocket.close(code=1011)
        return

    start_future: asyncio.Future[FreeSwitchAudioStreamStart] = (
        asyncio.get_running_loop().create_future()
    )

    async def on_start(payload: FreeSwitchAudioStreamStart) -> None:
        if not start_future.done():
            start_future.set_result(payload)

    serializer = FreeSwitchAudioStreamSerializer(on_start=on_start)
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
        ),
    )

    # Wait for the start metadata before we can dispatch — mod_audio_stream
    # sends it within a few hundred ms of the WS open.
    try:
        start = await asyncio.wait_for(start_future, timeout=10.0)
    except asyncio.TimeoutError:
        logger.error("freeswitch audio_stream start event never arrived")
        await websocket.close(code=1011)
        return

    # Lookup chain — section 6.2 / 6.3.
    instance = None
    if start.aplisay_phone_registration:
        endpoint = await api_client.get_phone_endpoint_by_id(start.aplisay_phone_registration)
        if endpoint and endpoint.get("instanceId"):
            instance = await api_client.get_instance_by_id(endpoint["instanceId"])
    if not instance and start.called_id:
        endpoint = await api_client.get_phone_endpoint_by_number(
            start.called_id, start.aplisay_trunk
        )
        if endpoint and endpoint.get("instanceId"):
            instance = await api_client.get_instance_by_id(endpoint["instanceId"])
    if not instance and start.called_id:
        instance = await api_client.get_instance_by_number(start.called_id)
    if not instance:
        logger.error({"start": start.raw}, "no instance for inbound freeswitch call")
        await websocket.close(code=1011)
        return

    agent = instance.get("Agent")
    if not agent:
        logger.error("instance has no agent")
        await websocket.close(code=1011)
        return

    session_id = f"fs-{uuid.uuid4()}"
    ctx = InboundCallContext(
        session_id=session_id,
        called_id=start.called_id,
        caller_id=start.caller_id,
        aplisay_id=start.aplisay_trunk,
        phone_registration=start.aplisay_phone_registration,
        b2bua_gateway_ip=start.aplisay_b2bua_ip,
        b2bua_gateway_transport=start.aplisay_b2bua_transport,
        call_id=start.aplisay_call_id,
        raw={
            "transport": transport,
            "channel_uuid": start.channel_uuid,
            "start_event": start.raw,
        },
    )

    session = await setup_inbound_call(
        sip_gateway, ctx, instance=instance, agent=agent
    )
    websocket.app.state.live_calls[session.call.id] = session
    websocket.app.state.calls_by_channel[start.channel_uuid] = session.call.id

    # Resolve any pending outbound originate waiting on this channel.
    sip_gateway.register_inbound_session(
        channel_uuid=start.channel_uuid, transport=transport, session_id=session_id
    )

    # Run the call. The PipelineRunner returns when the transport closes
    # (i.e. when FreeSWITCH closes the WS or the call ends).
    try:
        await _run_session(websocket.app, session, session.call.id)
    except WebSocketDisconnect:
        pass


# ---- FreeSWITCH channel-event webhook (from esl-poller) ----


@app.post("/freeswitch/events")
async def freeswitch_events(
    request: Request,
    authorization: Optional[str] = Header(default=None),
) -> dict:
    expected = os.environ.get("WORKER_EVENT_TOKEN") or os.environ.get("CALL_API_TOKEN")
    if expected:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise HTTPException(status_code=401, detail="missing bearer token")
        if authorization.split(" ", 1)[1].strip() != expected:
            raise HTTPException(status_code=401, detail="invalid bearer token")

    payload = await request.json()
    event = payload.get("event")
    channel_uuid = payload.get("channelUuid")
    if not channel_uuid:
        return {"ok": True}

    call_id = request.app.state.calls_by_channel.get(channel_uuid)
    if not call_id:
        logger.debug({"event": event, "channel_uuid": channel_uuid}, "event for unknown channel")
        return {"ok": True}

    session: CallSession = request.app.state.live_calls.get(call_id)
    if not session:
        return {"ok": True}

    if event == "CHANNEL_HANGUP":
        # Reason mapping: which side hung up? We don't carry that distinction
        # here yet — default to original participant unless a transfer state
        # tells us otherwise.
        reason = DISCONNECT_REASONS["ORIGINAL_PARTICIPANT"]
        await api_client.end_call(session.call, reason=reason)
        await session.gateway_session.shutdown()

    return {"ok": True}


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
