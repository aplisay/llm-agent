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
- ``WS /voiceblender/agent/{session_id}`` — voiceblender opens this when a
  leg is being attached to a Pipecat agent (after ``POST /v1/legs/{id}/agent``
  on the voiceblender side). Wire format is stock Pipecat protobuf at
  16 kHz mono.

The worker remains gateway-agnostic above the ``sip_gateway`` indirection;
``SIP_GATEWAY=daily|freeswitch|voiceblender`` selects the implementation at
startup.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from loguru import logger
from pipecat.pipeline.runner import PipelineRunner
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.transports.websocket.fastapi import (
    FastAPIWebsocketParams,
    FastAPIWebsocketTransport,
)

from . import api_client
from .auth import require_dispatch_token, verify_join_token
from .call_session import (
    CallSession,
    TransferState,
    build_transfer_agent_dict,
    setup_consult_call,
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
    GatewaySessionParams,
    InboundCallContext,
    SipBridgeSipGateway,
    VoiceblenderSipGateway,
)
from pipecat.serializers.protobuf import ProtobufFrameSerializer


@asynccontextmanager
async def lifespan(app: FastAPI):
    # SIP gateway is selected at startup. SIP_GATEWAY=daily|freeswitch|voiceblender.
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
    elif gateway_name == "sipbridge":
        sb_gw = SipBridgeSipGateway()
        app.state.sip_gateway = sb_gw
        try:
            await sb_gw.start()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"sipbridge gateway start failed at boot: {e}")
    elif gateway_name == "voiceblender":
        vb_gw = VoiceblenderSipGateway()
        app.state.sip_gateway = vb_gw
        # The gateway needs two callbacks back into worker-level state:
        # (a) agent resolution from VSI ``leg.ringing`` events (mirrors the
        # FreeSWITCH inbound-WS lookup and the Daily dialin webhook), and
        # (b) session lookup so leg.transfer_* events can drive the
        # in-process transfer_state machine on the matching CallSession.
        vb_gw.set_agent_resolver(_voiceblender_resolve_agent)
        vb_gw.set_session_lookup(
            lambda sid: _voiceblender_session_lookup(app, sid)
        )
        try:
            await vb_gw.start()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"voiceblender gateway start failed at boot: {e}")
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
    # Stop the VSI subscriber cleanly if voiceblender is the active gateway.
    gw_obj = getattr(app.state, "sip_gateway", None)
    if isinstance(gw_obj, VoiceblenderSipGateway):
        try:
            await gw_obj.stop()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"voiceblender gateway stop failed: {e}")
    # sipbridge has no long-lived connections; stop() is a no-op but
    # called for symmetry / future-proofing.
    if isinstance(gw_obj, SipBridgeSipGateway):
        try:
            await gw_obj.stop()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"sipbridge gateway stop failed: {e}")


async def _voiceblender_resolve_agent(
    event: dict,
) -> Optional[tuple[dict, dict]]:
    """Agent lookup for an inbound voiceblender ``leg.ringing`` VSI event.

    Same lookup chain as Daily dial-in and FreeSWITCH inbound: phone
    registration → trunk+number → number. Returns ``(instance, agent)`` or
    ``None`` if no agent is configured for the dialled number.
    """
    headers = event.get("custom_headers") or {}
    to_number = event.get("to")
    aplisay_id = headers.get("X-Aplisay-Trunk")
    phone_registration = headers.get("X-Aplisay-PhoneRegistration")

    instance = None
    if phone_registration:
        endpoint = await api_client.get_phone_endpoint_by_id(phone_registration)
        if endpoint and endpoint.get("instanceId"):
            instance = await api_client.get_instance_by_id(endpoint["instanceId"])
    if not instance and to_number:
        endpoint = await api_client.get_phone_endpoint_by_number(
            to_number, aplisay_id
        )
        if endpoint and endpoint.get("instanceId"):
            instance = await api_client.get_instance_by_id(endpoint["instanceId"])
    if not instance and to_number:
        instance = await api_client.get_instance_by_number(to_number)
    if not instance:
        return None
    agent = instance.get("Agent")
    if not agent:
        return None
    return instance, agent


def _voiceblender_session_lookup(app: FastAPI, session_id: str):
    """Find the live ``CallSession`` matching a voiceblender ``session_id``.

    ``live_calls`` is keyed by call.id (which is *not* the session_id), so
    we walk the values; the set is small (single-digit count per worker in
    typical operation) and the lookup is rare (only fires on
    ``leg.transfer_*`` events).
    """
    for s in app.state.live_calls.values():
        if getattr(s, "session_id", None) == session_id:
            return s
    return None


async def _sipbridge_resolve_agent_from_headers(
    websocket: WebSocket,
) -> Optional[tuple[dict, dict, InboundCallContext]]:
    """Agent lookup for an inbound sipbridge WS.

    sipbridge passes SIP-derived metadata as request headers on the WS
    opening handshake (X-Sipbridge-Call-ID, X-Sipbridge-From,
    X-Sipbridge-To, plus the X-Aplisay-* contract from section 6 of
    docs/livekit-agent-architecture.md). We run the same agent lookup
    chain Daily dial-in and FreeSWITCH use, then return ``(instance,
    agent, ctx)`` with a fully-populated InboundCallContext.

    Returns ``None`` if no agent maps to the dialled number.
    """
    h = websocket.headers
    bridge_call_id = h.get("x-sipbridge-call-id") or h.get("X-Sipbridge-Call-ID")
    from_uri = h.get("x-sipbridge-from") or ""
    to_uri = h.get("x-sipbridge-to") or ""
    aplisay_id = h.get("x-aplisay-trunk")
    phone_registration = h.get("x-aplisay-phoneregistration")
    aplisay_call_id = h.get("x-aplisay-call-id")
    b2bua_ip = h.get("x-lk-realip")
    b2bua_transport = h.get("x-lk-transport")

    # Extract bare numbers from SIP URIs. sipgo gives us
    # "sip:+44...@host" form; strip to the user portion.
    def _user_of(uri: str) -> str:
        if not uri:
            return ""
        s = uri
        if s.startswith("<") and s.endswith(">"):
            s = s[1:-1]
        if s.lower().startswith("sip:"):
            s = s[4:]
        if "@" in s:
            s = s.split("@", 1)[0]
        return s

    from_number = _user_of(from_uri)
    to_number = _user_of(to_uri)

    instance = None
    if phone_registration:
        endpoint = await api_client.get_phone_endpoint_by_id(phone_registration)
        if endpoint and endpoint.get("instanceId"):
            instance = await api_client.get_instance_by_id(endpoint["instanceId"])
    if not instance and to_number:
        endpoint = await api_client.get_phone_endpoint_by_number(
            to_number, aplisay_id
        )
        if endpoint and endpoint.get("instanceId"):
            instance = await api_client.get_instance_by_id(endpoint["instanceId"])
    if not instance and to_number:
        instance = await api_client.get_instance_by_number(to_number)
    if not instance:
        return None
    agent = instance.get("Agent")
    if not agent:
        return None

    session_id = f"sb-{uuid.uuid4()}"
    ctx = InboundCallContext(
        session_id=session_id,
        called_id=to_number,
        caller_id=from_number,
        aplisay_id=aplisay_id,
        phone_registration=phone_registration,
        b2bua_gateway_ip=b2bua_ip,
        b2bua_gateway_transport=b2bua_transport,
        call_id=aplisay_call_id,
        raw={"bridge_call_id": bridge_call_id},
    )
    return instance, agent, ctx


app = FastAPI(lifespan=lifespan)

# CORS for the browser-facing /webrtc/offer route. The other endpoints on this
# worker are server-to-server (FreeSWITCH, esl-poller, llm-agent's JS handler,
# Daily) and don't need CORS, but middleware applies app-wide and they ignore
# the headers anyway.
#
# WEBRTC_ALLOWED_ORIGINS is a comma-separated list (e.g.
# "http://localhost:3000,https://playground.aplisay.example"). Defaults to "*"
# for dev convenience — that's safe because the offer endpoint is gated by an
# HMAC-signed time-limited token, not by cookies / Authorization headers, so a
# wildcard origin can't be abused via credentialed requests.
_allowed_origins = [
    o.strip()
    for o in os.environ.get("WEBRTC_ALLOWED_ORIGINS", "*").split(",")
    if o.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_credentials=False,
    allow_methods=["POST", "OPTIONS", "GET"],
    allow_headers=["*"],
)


@app.post("/dispatch")
async def dispatch(request: Request, authorization: Optional[str] = Header(default=None)):
    require_dispatch_token(authorization)
    payload = await request.json()
    kind = payload.get("kind")
    logger.bind(kind=kind, payload=payload).info("dispatch received")

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
    logger.bind(body=body).info("daily dial-in webhook")

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
    # The token rides as a query-string param so the browser client can use
    # stock SmallWebRTCTransport without customising the request body. We
    # still accept it from the body as a fallback for older callers.
    token = request.query_params.get("token") or body.get("token")
    if not token:
        raise HTTPException(status_code=400, detail="missing token")
    payload = verify_join_token(token)

    try:
        instance = await api_client.get_instance_by_id(payload.instance_id)
    except api_client.ApiRequestError as e:
        # Surface the actual upstream error to the browser instead of a 500
        # traceback. Common case in dev: SERVICE_BASE_URI not set or pointed
        # at an unresolvable placeholder.
        raise HTTPException(status_code=e.status, detail=str(e))
    if not instance:
        raise HTTPException(status_code=404, detail="instance not found")
    agent = instance.get("Agent")
    if not agent:
        raise HTTPException(status_code=404, detail="instance has no agent")

    sdp = body.get("sdp")
    sdp_type = body.get("type")
    if not sdp or not sdp_type:
        raise HTTPException(status_code=400, detail="missing sdp / type")

    pc = SmallWebRTCConnection()
    await pc.initialize(sdp, sdp_type)
    answer = pc.get_answer()
    if not answer:
        raise HTTPException(status_code=500, detail="webrtc answer not ready")

    transport = SmallWebRTCTransport(
        params=TransportParams(audio_in_enabled=True, audio_out_enabled=True),
        webrtc_connection=pc,
    )

    # Create a real persisted Call record so transcripts flow through the
    # normal transaction-log path back to the frontend (via the listener's
    # WebSocket socket) and so end_call() works on cleanup. The architecture
    # doc treats browser sessions as first-class participants — the only
    # difference from a SIP call is the media transport.
    try:
        call = await api_client.create_call(
            {
                "userId": agent["userId"],
                "organisationId": agent["organisationId"],
                "instanceId": instance["id"],
                "agentId": agent["id"],
                "platform": "pipecat",
                "platformCallId": payload.session_id,
                "calledId": "WebRTC",
                "callerId": "WebRTC",
                "modelName": agent["modelName"],
                "options": agent.get("options") or {},
                "metadata": {
                    **(instance.get("metadata") or {}),
                    "aplisay": {
                        "callerId": "WebRTC",
                        "calledId": "WebRTC",
                        "model": agent["modelName"],
                    },
                },
            }
        )
        await api_client.start_call(call)
    except api_client.AgentConcurrencyLimitExceededBusyError as e:
        raise HTTPException(status_code=429, detail=str(e))
    except api_client.ApiRequestError as e:
        raise HTTPException(status_code=e.status, detail=str(e))

    # The browser session is owned by the same orchestration as a phone call.
    from .call_session import CallSession, TransferState
    from .sip_gateway.base import GatewaySession as _GW

    class _BrowserGatewaySession(_GW):
        """Wraps the SmallWebRTCTransport+Connection pair for the browser path.

        Pipecat's `SmallWebRTCTransport` has no `.stop()`; the way to tear a
        peer down is to call `disconnect()` on the underlying
        `SmallWebRTCConnection`. We hold that handle here so hangup/shutdown
        can do it.
        """

        def __init__(self, transport, connection, session_id):
            self.transport = transport
            self._connection = connection
            self.session_id = session_id

        async def hangup(self, reason: str) -> None:
            try:
                await self._connection.disconnect()
            except Exception as e:  # noqa: BLE001
                logger.warning(f"webrtc connection disconnect failed: {e}")

        async def transfer(self, _req) -> None:
            raise RuntimeError("transfer not supported in browser sessions")

        async def shutdown(self) -> None:
            await self.hangup("Session closed")

    session = CallSession(
        session_id=payload.session_id,
        agent=agent,
        instance=instance,
        sip_gateway=request.app.state.sip_gateway,
        gateway_session=_BrowserGatewaySession(transport, pc, payload.session_id),
        call=call,
    )

    # Preflight the voice-session build BEFORE answering the SDP. If a
    # provider config is wrong (missing API key, unsupported vendor, bad
    # voice ID, ...), the failure surfaces here as an HTTP 5xx with the
    # exception message in the body — the browser sees a real error and can
    # display it, instead of receiving a 200 SDP answer and stalling on a
    # silent worker-side crash.
    #
    # Connection-establishment failures (the LLM provider's WebSocket
    # dropping after the pipeline starts running) still happen asynchronously
    # and surface as a normal pipeline-end with `SESSION_CLOSED`; they're
    # rarer than config errors and need a different recovery path anyway.
    try:
        prepared_task, max_duration_secs = await session.prepare_run(
            agent, agent["modelName"], agent.get("prompt") or ""
        )
    except Exception as e:  # noqa: BLE001
        # `logger.exception(...)` includes the traceback in the log output;
        # `logger.bind(...).error(...)` alone hides it unless the formatter
        # explicitly renders bound fields, which is how the original "build
        # failed during preflight" message looked useless.
        logger.opt(exception=True).error(
            f"voice session build failed during /webrtc/offer preflight: "
            f"{type(e).__name__}: {e} (callId={call.id})",
        )
        # Undo everything we created before this point so the agent's
        # concurrency slot is released and the half-open peer is closed.
        try:
            await api_client.end_call(
                call, reason=f"build failed: {e}"
            )
        except Exception:  # noqa: BLE001
            pass
        try:
            await pc.disconnect()
        except Exception:  # noqa: BLE001
            pass
        # Include the exception type in the detail so the browser-side error
        # message tells the operator what kind of failure they're looking at
        # (KeyError, ImportError, ValueError, etc.) — not just the message.
        raise HTTPException(
            status_code=500,
            detail=f"session build failed: {type(e).__name__}: {e}",
        )

    request.app.state.live_calls[call.id] = session

    async def _run_browser_session():
        try:
            await session.run_prepared(prepared_task, max_duration_secs)
        except Exception as e:  # noqa: BLE001
            logger.error(f"browser session runner failed: {e}")
            try:
                await api_client.end_call(
                    session.call,
                    reason=DISCONNECT_REASONS["UNCAUGHT_ERROR_RUNNING_AGENT"],
                )
            except Exception:  # noqa: BLE001
                pass
        finally:
            request.app.state.live_calls.pop(call.id, None)
            try:
                await session.gateway_session.shutdown()
            except Exception as inner:  # noqa: BLE001
                logger.warning(f"gateway shutdown failed: {inner}")

    # Wait for the pipeline to *actually start* before answering the SDP,
    # so connection-establishment failures (Ultravox API rejection, OpenAI
    # Realtime WebSocket close, Gemini Live auth failure, etc.) propagate
    # back to the browser as an HTTP 500. ``prepare_run`` only constructs
    # the task — provider connection happens during ``StartFrame``
    # propagation once the runner kicks the pipeline. Without this wait,
    # the browser gets a 200 SDP answer and a stalled-spinner experience
    # because the worker-side pipeline died seconds later.
    #
    # The signal we watch: ``on_pipeline_started`` fires when StartFrame
    # reaches the sink (every processor has handled it without raising).
    # ``on_pipeline_error`` fires when any processor pushes a fatal
    # ErrorFrame upstream. Whichever fires first decides the outcome.
    started_event = asyncio.Event()
    error_event = asyncio.Event()
    startup_error: dict[str, Any] = {}

    @prepared_task.event_handler("on_pipeline_started")
    async def _startup_on_started(*_args, **_kwargs) -> None:
        started_event.set()

    @prepared_task.event_handler("on_pipeline_error")
    async def _startup_on_error(_task, error_frame) -> None:  # noqa: ANN001
        startup_error["error"] = getattr(error_frame, "error", "pipeline error")
        startup_error["exception"] = getattr(error_frame, "exception", None)
        error_event.set()

    session_task = asyncio.create_task(_run_browser_session())

    started_waiter = asyncio.create_task(started_event.wait())
    error_waiter = asyncio.create_task(error_event.wait())
    try:
        _done, pending = await asyncio.wait(
            [started_waiter, error_waiter],
            timeout=15.0,
            return_when=asyncio.FIRST_COMPLETED,
        )
        for p in pending:
            p.cancel()
    except Exception:  # noqa: BLE001
        # Defensive — wait() shouldn't raise but we'd rather surface a
        # tidy 500 than crash the request handler.
        pass

    if error_event.is_set() or not started_event.is_set():
        # Failure (or startup timeout). Cancel the running session, end
        # the persisted Call so the concurrency slot is released, tear
        # down the half-open WebRTC peer, and surface the cause to the
        # browser. ``error_event`` not set + ``started_event`` not set
        # means the 15-second wait elapsed without either signal — treat
        # as a startup hang.
        if not error_event.is_set():
            startup_error["error"] = "session startup timeout (15s)"
            startup_error["exception"] = None
        err_msg = startup_error.get("error") or "pipeline startup error"
        exc = startup_error.get("exception")
        detail = (
            f"{err_msg} ({type(exc).__name__}: {exc})"
            if exc is not None
            else err_msg
        )
        logger.opt(exception=exc).error(
            f"voice session startup failed: {detail} (callId={call.id})",
        )
        # Cancel the runner task and wait briefly so its `finally` block
        # gets a chance to run (end_call + gateway shutdown). Bound the
        # wait so a misbehaving runner can't stall the HTTP response.
        session_task.cancel()
        try:
            await asyncio.wait_for(session_task, timeout=2.0)
        except (asyncio.CancelledError, asyncio.TimeoutError):
            pass
        except Exception:  # noqa: BLE001
            pass
        # Defensive cleanup in case the runner's finally didn't fire.
        request.app.state.live_calls.pop(call.id, None)
        try:
            await api_client.end_call(call, reason=f"startup failed: {detail}")
        except Exception:  # noqa: BLE001
            pass
        try:
            await pc.disconnect()
        except Exception:  # noqa: BLE001
            pass
        raise HTTPException(
            status_code=500,
            detail=f"session startup failed: {detail}",
        )

    # Pipeline is up and running. Return the SDP answer so the browser
    # completes its end of the WebRTC handshake.
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

    # Consultative warm-transfer leg? (LiveKit-parity contract — see
    # ``docs/call-transfers.md``.) ``FreeswitchSipGateway._do_consultative``
    # uses ``channel_uuid`` as the session_id key, so we look it up
    # directly against the start event's channel uuid.
    consult_payload = sip_gateway.consult_payload(start.channel_uuid)
    if consult_payload is not None:
        from .transfer_prompts import substitute_parent_transcript

        parent = _voiceblender_session_lookup(
            websocket.app, consult_payload.parent_session_id
        )
        if parent is None:
            logger.bind(
                parent_session_id=consult_payload.parent_session_id,
                channel_uuid=start.channel_uuid,
            ).warning("freeswitch consult: parent session no longer live")
            await websocket.close(code=1011)
            sip_gateway.clear_consult_session(start.channel_uuid)
            return

        transfer_agent_prompt = substitute_parent_transcript(
            consult_payload.transfer_prompt_template,
            consult_payload.parent_transcript,
        )
        transfer_agent = build_transfer_agent_dict(
            parent_agent=parent.agent,
            transfer_agent_prompt=transfer_agent_prompt,
        )

        # State transition on the parent: third party has answered.
        parent.transfer_state = TransferState(
            "talking", "Speaking with transfer target..."
        )

        # The InboundCallContext for the consult uses the channel_uuid
        # as session_id so setup_inbound (gateway hook) and FreeSWITCH's
        # register_inbound_session find the right channel.
        ctx = InboundCallContext(
            session_id=start.channel_uuid,
            called_id=start.called_id,
            caller_id=parent.call.callerId,
            aplisay_id=None,
            phone_registration=None,
            b2bua_gateway_ip=None,
            b2bua_gateway_transport=None,
            call_id=None,
            raw={
                "transport": transport,
                "channel_uuid": start.channel_uuid,
                "consult_of": consult_payload.parent_session_id,
                "start_event": start.raw,
            },
        )

        try:
            consult_session = await setup_consult_call(
                sip_gateway,
                ctx,
                instance=parent.instance,
                transfer_agent=transfer_agent,
                parent=parent,
            )
        except Exception as e:  # noqa: BLE001
            logger.bind(channel_uuid=start.channel_uuid).error(
                f"freeswitch consult setup_consult_call failed: {e}"
            )
            parent.transfer_state = TransferState(
                "failed", f"Consult setup failed: {e}"
            )
            await websocket.close(code=1011)
            sip_gateway.clear_consult_session(start.channel_uuid)
            return
        websocket.app.state.live_calls[consult_session.call.id] = consult_session
        websocket.app.state.calls_by_channel[start.channel_uuid] = consult_session.call.id

        try:
            await _run_session(
                websocket.app, consult_session, consult_session.call.id
            )
        except WebSocketDisconnect:
            pass
        finally:
            if parent.transfer_state.state == "talking":
                parent.transfer_state = TransferState(
                    "rejected", "Transfer target disconnected"
                )
            sip_gateway.clear_consult_session(start.channel_uuid)
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
        logger.bind(start=start.raw).error("no instance for inbound freeswitch call")
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
        logger.bind(event=event, channel_uuid=channel_uuid).debug("event for unknown channel")
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


# ---- Voiceblender WebSocket (Pipecat protobuf transport) ----


@app.websocket("/voiceblender/agent/{session_id}")
async def voiceblender_agent(websocket: WebSocket, session_id: str) -> None:
    """WebSocket the voiceblender process opens after ``POST /v1/legs/{id}/agent``.

    Wire format is stock Pipecat protobuf at 16 kHz mono, so we use the
    upstream :class:`ProtobufFrameSerializer` (no custom serializer to write
    — voiceblender speaks the same ``pipecat.Frame`` proto its own
    ``examples/pipecat-agent/bot.py`` does, just from Go instead of Python).

    Inbound vs outbound branch on the pre-registered :class:`PendingAttach`:

    - **Inbound** (``leg.ringing`` -> agent resolved by VSI subscriber, then
      ``POST /v1/legs/{id}/answer`` + ``POST /v1/legs/{id}/agent``): we own
      the call lifecycle. Build a CallSession via :func:`setup_inbound_call`
      and run the pipeline in this handler, matching the FreeSWITCH inbound
      flow exactly except the serializer differs.

    - **Outbound** (``POST /dispatch`` -> ``gateway.originate()`` -> we POST
      ``/v1/legs`` to voiceblender -> voiceblender dials us): the dispatch
      task owns the call lifecycle. We just need to register the
      ``_VbGatewaySession`` so ``originate()`` returns, then hold the
      WebSocket open until voiceblender signals ``leg.disconnected`` via
      VSI.
    """
    await websocket.accept()
    sip_gateway = websocket.app.state.sip_gateway
    if not isinstance(sip_gateway, VoiceblenderSipGateway):
        logger.warning("/voiceblender/agent invoked but SIP_GATEWAY != voiceblender")
        await websocket.close(code=1011)
        return

    pending = sip_gateway.pending_attaches.get(session_id)
    if pending is None:
        logger.bind(session_id=session_id).warning(
            "voiceblender WS connected with no pending attach — rejecting"
        )
        await websocket.close(code=1011)
        return

    serializer = ProtobufFrameSerializer()
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
        ),
    )

    # Stamp transport + leg_id onto the inbound ctx so setup_inbound (called
    # from setup_inbound_call below, or directly for the outbound path) has
    # what it needs to build the _VbGatewaySession.
    pending.inbound_ctx.raw["transport"] = transport
    pending.inbound_ctx.raw["leg_id"] = pending.leg_id
    sip_gateway.pending_attaches.pop(session_id, None)

    is_inbound = bool(pending.agent)

    # Consultative warm-transfer leg? (LiveKit-parity contract — see
    # ``docs/call-transfers.md``.) ``_do_consultative`` populates BOTH
    # the consult payload AND a regular pending-attach with empty
    # agent, so the existing inbound/outbound discriminator falls
    # through to the outbound path naturally. We check before either
    # branch so the TransferAgent CallSession gets built.
    consult_payload = sip_gateway.consult_payload(session_id)

    if is_inbound:
        # Inbound: create the CallSession ourselves and drive the runner.
        try:
            session = await setup_inbound_call(
                sip_gateway,
                pending.inbound_ctx,
                instance=pending.instance,
                agent=pending.agent,
            )
        except Exception as e:  # noqa: BLE001
            logger.bind(session_id=session_id).error(
                f"voiceblender setup_inbound_call failed: {e}"
            )
            await websocket.close(code=1011)
            return
        websocket.app.state.live_calls[session.call.id] = session
        try:
            await _run_session(websocket.app, session, session.call.id)
        except WebSocketDisconnect:
            pass
        return

    if consult_payload is not None:
        # Consultative warm-transfer leg. Spawn a TransferAgent
        # CallSession bound to the parent's agent's LLM provider but
        # with a bespoke prompt + accept/reject tool surface. Mirrors
        # the sipbridge consult flow exactly — only the gateway
        # underneath differs.
        from .transfer_prompts import substitute_parent_transcript

        parent = _voiceblender_session_lookup(
            websocket.app, consult_payload.parent_session_id
        )
        if parent is None:
            logger.bind(
                parent_session_id=consult_payload.parent_session_id,
                session_id=session_id,
            ).warning("voiceblender consult: parent session no longer live")
            await websocket.close(code=1011)
            sip_gateway.clear_consult_session(session_id)
            return

        transfer_agent_prompt = substitute_parent_transcript(
            consult_payload.transfer_prompt_template,
            consult_payload.parent_transcript,
        )
        transfer_agent = build_transfer_agent_dict(
            parent_agent=parent.agent,
            transfer_agent_prompt=transfer_agent_prompt,
        )

        # State transition: dialling → talking on the parent (the WS
        # arrival means the third party has answered).
        parent.transfer_state = TransferState(
            "talking", "Speaking with transfer target..."
        )

        try:
            consult_session = await setup_consult_call(
                sip_gateway,
                pending.inbound_ctx,
                instance=parent.instance,
                transfer_agent=transfer_agent,
                parent=parent,
            )
        except Exception as e:  # noqa: BLE001
            logger.bind(session_id=session_id).error(
                f"voiceblender consult setup_consult_call failed: {e}"
            )
            parent.transfer_state = TransferState(
                "failed", f"Consult setup failed: {e}"
            )
            await websocket.close(code=1011)
            sip_gateway.clear_consult_session(session_id)
            return
        websocket.app.state.live_calls[consult_session.call.id] = consult_session
        try:
            await _run_session(
                websocket.app, consult_session, consult_session.call.id
            )
        except WebSocketDisconnect:
            pass
        finally:
            # No explicit accept/reject → parent stays in `talking` → bump
            # to `rejected` so transfer_status surfaces meaningful state.
            if parent.transfer_state.state == "talking":
                parent.transfer_state = TransferState(
                    "rejected", "Transfer target disconnected"
                )
            sip_gateway.clear_consult_session(session_id)
        return

    # Outbound path. Register the gateway session so the originate() future
    # in the dispatch task resolves; then block until voiceblender reports
    # the leg gone, holding the WebSocket open while the dispatch task's
    # PipelineRunner drives this transport.
    from .sip_gateway import GatewaySessionParams

    try:
        await sip_gateway.setup_inbound(
            pending.inbound_ctx, GatewaySessionParams(session_id=session_id)
        )
    except Exception as e:  # noqa: BLE001
        logger.bind(session_id=session_id).error(
            f"voiceblender outbound setup_inbound failed: {e}"
        )
        await websocket.close(code=1011)
        return

    done_event = sip_gateway.wait_for_leg_done(session_id)
    try:
        await done_event.wait()
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        # FastAPI cancels the handler when the WS closes — propagate.
        raise
    finally:
        sip_gateway.release_leg_done(session_id)


# ---- sipbridge WebSocket (Pipecat protobuf transport) ----


@app.websocket("/sipbridge/agent/{session_id}")
async def sipbridge_agent(websocket: WebSocket, session_id: str) -> None:
    """WebSocket the sipbridge container opens after accepting a SIP
    INVITE.

    Same wire format as the voiceblender path (stock Pipecat protobuf
    at 16 kHz mono via :class:`ProtobufFrameSerializer`). The difference
    is how dispatch metadata reaches us: sipbridge attaches the SIP-side
    From/To/X-Aplisay-* headers as HTTP request headers on the opening
    handshake — there is no separate event channel.

    ``session_id`` in the URL is a token the bridge generated from the
    SIP Call-ID (or X-Aplisay-Call-Id if the upstream B2BUA stamped
    one); we treat it as opaque and use it as the worker-side
    ``session_id`` for the CallSession.
    """
    sip_gateway = websocket.app.state.sip_gateway
    if not isinstance(sip_gateway, SipBridgeSipGateway):
        # 1011 = server unable to fulfil — accept-then-close is the only
        # way to surface a reason on the WS layer. (HTTP-status WS
        # rejects aren't well-supported by clients in practice.)
        await websocket.accept()
        logger.warning("/sipbridge/agent invoked but SIP_GATEWAY != sipbridge")
        await websocket.close(code=1011)
        return

    is_outbound = sip_gateway.is_outbound(session_id)
    bridge_call_id = (
        websocket.headers.get("x-sipbridge-call-id")
        or websocket.headers.get("X-Sipbridge-Call-ID")
        or ""
    )

    if is_outbound:
        # Two sub-flows here:
        #
        #   (a) Plain outbound originate (POST /dispatch → setup_outbound_call):
        #       dispatch already owns the CallSession + runner, waiting
        #       on the originate() future. We just register the
        #       gateway session (which resolves the future) and hold
        #       the WS alive while dispatch's runner drives it.
        #
        #   (b) Warm-transfer consult (Phase C): bot_A initiated a
        #       consult via transfer(operation="consult"). The gateway
        #       has recorded a parent_session_id for this consult; we
        #       build a fresh CallSession using the parent's agent +
        #       instance and run a second pipeline here in the
        #       handler (same shape as inbound).
        parent_session_id = sip_gateway.consult_parent(session_id)

        await websocket.accept()
        serializer = ProtobufFrameSerializer()
        transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                add_wav_header=False,
                serializer=serializer,
            ),
        )
        try:
            sip_gateway.register_inbound_session(
                session_id=session_id,
                bridge_call_id=bridge_call_id,
                transport=transport,
            )
        except Exception as e:  # noqa: BLE001
            logger.bind(session_id=session_id).error(
                f"sipbridge outbound register_inbound_session failed: {e}"
            )
            await websocket.close(code=1011)
            return

        if parent_session_id:
            # LiveKit-parity warm-transfer consultation. The consult
            # bot is NOT a clone of the parent — it's a purpose-built
            # TransferAgent with:
            #   - a bespoke system prompt resolved per the LiveKit
            #     precedence chain (args → agent options → default
            #     template), with ``${parentTranscript}`` substituted
            #     for the parent's running chat history at the moment
            #     the transfer was requested;
            #   - a restricted tool surface (accept_transfer /
            #     reject_transfer only — no nested transfers, no
            #     hangup);
            #   - the parent CallSession recorded on the consult
            #     session so the accept/reject builtins can drive
            #     the parent's transfer_state.
            #
            # See ``docs/call-transfers.md``, ``transfer_prompts.py``,
            # and ``call_session.py:_builtin_consult_accept/reject``.
            from .transfer_prompts import substitute_parent_transcript

            parent = _voiceblender_session_lookup(websocket.app, parent_session_id)
            consult_parent = parent
            if consult_parent is None:
                logger.bind(
                    parent_session_id=parent_session_id,
                    session_id=session_id,
                ).warning("sipbridge consult: parent session no longer live")
                await websocket.close(code=1011)
                sip_gateway.unregister_session(session_id)
                sip_gateway.clear_consult_session(session_id)
                return

            payload = sip_gateway.consult_payload(session_id)
            if payload is None:
                logger.bind(session_id=session_id).error(
                    "sipbridge consult: payload missing on WS arrival"
                )
                await websocket.close(code=1011)
                sip_gateway.unregister_session(session_id)
                return

            # Build the TransferAgent's effective system prompt by
            # substituting ${parentTranscript} now (the latest possible
            # moment before the consult bot reads its prompt — matches
            # LiveKit transfer-handler.ts:634-637). The agent-dict
            # assembly is gateway-agnostic and shared with the
            # voiceblender + freeswitch consult arms.
            transfer_agent_prompt = substitute_parent_transcript(
                payload.transfer_prompt_template,
                payload.parent_transcript,
            )
            transfer_agent = build_transfer_agent_dict(
                parent_agent=consult_parent.agent,
                transfer_agent_prompt=transfer_agent_prompt,
            )

            ctx = InboundCallContext(
                session_id=session_id,
                called_id=None,
                caller_id=consult_parent.call.callerId,
                aplisay_id=None,
                phone_registration=None,
                b2bua_gateway_ip=None,
                b2bua_gateway_transport=None,
                call_id=None,
                raw={
                    "transport": transport,
                    "bridge_call_id": bridge_call_id,
                    "consult_of": parent_session_id,
                },
            )

            # State transition: dialling → talking (the WS arriving
            # means the third party has answered and our bot is now
            # speaking with them). Matches LiveKit
            # transfer-handler.ts:767.
            consult_parent.transfer_state = TransferState(
                "talking", "Speaking with transfer target..."
            )

            try:
                consult_session = await setup_consult_call(
                    sip_gateway,
                    ctx,
                    instance=consult_parent.instance,
                    transfer_agent=transfer_agent,
                    parent=consult_parent,
                )
            except Exception as e:  # noqa: BLE001
                logger.bind(session_id=session_id).error(
                    f"sipbridge consult setup failed: {e}"
                )
                consult_parent.transfer_state = TransferState(
                    "failed", f"Consult setup failed: {e}"
                )
                await websocket.close(code=1011)
                sip_gateway.unregister_session(session_id)
                sip_gateway.clear_consult_session(session_id)
                return
            websocket.app.state.live_calls[consult_session.call.id] = consult_session
            try:
                await _run_session(
                    websocket.app, consult_session, consult_session.call.id
                )
            except WebSocketDisconnect:
                pass
            finally:
                # If the consult bot's WS closes without an explicit
                # accept/reject (e.g. the third party hung up), record
                # a generic rejection on the parent so transfer_status
                # surfaces something meaningful. Matches LiveKit
                # transfer-handler.ts:796-801.
                if consult_parent.transfer_state.state == "talking":
                    consult_parent.transfer_state = TransferState(
                        "rejected", "Transfer target disconnected"
                    )
                sip_gateway.unregister_session(session_id)
                sip_gateway.clear_consult_session(session_id)
            return

        # Plain outbound — just wait for done.
        done_event = sip_gateway.wait_for_leg_done(session_id)
        try:
            await done_event.wait()
        except WebSocketDisconnect:
            pass
        except asyncio.CancelledError:
            raise
        finally:
            sip_gateway.release_leg_done(session_id)
            sip_gateway.unregister_session(session_id)
        return

    # Inbound flow.
    # Resolve the agent BEFORE accepting the WS so we can fail clean.
    resolved = await _sipbridge_resolve_agent_from_headers(websocket)
    if resolved is None:
        await websocket.accept()
        logger.warning(
            "sipbridge WS: no agent for inbound call "
            f"(to={websocket.headers.get('x-sipbridge-to')!r})"
        )
        await websocket.close(code=1011)
        return
    instance, agent, ctx = resolved

    await websocket.accept()

    serializer = ProtobufFrameSerializer()
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
        ),
    )

    # Stamp the transport + bridge_call_id onto the inbound ctx so
    # setup_inbound (which the gateway's register_inbound_session
    # effectively bypasses) wouldn't fail; setup_inbound_call calls
    # gateway.setup_inbound(...) which we still satisfy.
    ctx.raw["transport"] = transport

    # Build the CallSession via the normal inbound path.
    try:
        session = await setup_inbound_call(
            sip_gateway, ctx, instance=instance, agent=agent
        )
    except Exception as e:  # noqa: BLE001
        logger.bind(session_id=ctx.session_id).error(
            f"sipbridge setup_inbound_call failed: {e}"
        )
        await websocket.close(code=1011)
        return

    # Register the bridge_call_id → session mapping so REST hangup /
    # transfer targets the right bridge resource.
    sip_gateway.register_inbound_session(
        session_id=ctx.session_id,
        bridge_call_id=bridge_call_id,
        transport=transport,
    )
    websocket.app.state.live_calls[session.call.id] = session

    try:
        await _run_session(websocket.app, session, session.call.id)
    except WebSocketDisconnect:
        pass
    finally:
        sip_gateway.unregister_session(ctx.session_id)


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
