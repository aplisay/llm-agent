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
import logging
import os
import threading
import uuid
from urllib.parse import unquote

# The ``websockets`` library logs every frame it sends/receives as a hex dump
# (``> BINARY …`` / ``< BINARY …``) via its per-connection logger at DEBUG. With
# the protobuf audio transports (sipbridge / voiceblender legs) that floods the
# worker log with thousands of lines per call — drowning the actual signal. Pin
# the library's loggers to INFO so connection open/close/ping still show but the
# frame trace is gone. A logger with its own level set filters before any handler
# or root config, so this holds regardless of how DEBUG got enabled. Set
# ``WS_TRACE=1`` to restore the full per-frame dump for deep wire debugging.
if (os.environ.get("WS_TRACE") or "").lower() not in ("1", "true", "yes", "on"):
    for _ws_logger in ("websockets", "websockets.client", "websockets.server"):
        logging.getLogger(_ws_logger).setLevel(logging.INFO)
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Optional

import httpx
from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from aiortc.sdp import candidate_from_sdp
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
from .bridged_transfer import run_sipbridge_bta_watch
from .call_session import (
    CallSession,
    TransferState,
    build_transfer_agent_dict,
    setup_consult_call,
    setup_inbound_call,
    setup_outbound_call,
    setup_takeover_call,
)
from .constants import DISCONNECT_REASONS, PLATFORM
from .invocation_log import flush_invocation_logs, install_capture
from .output_cushion import install as install_output_cushion
from .output_underrun import install as install_underrun_stats
from .serializers import DtmfProtobufFrameSerializer, FreeSwitchAudioStreamSerializer
from .serializers.freeswitch_audio_stream import FreeSwitchAudioStreamStart
from .sip_gateway import (
    DailySipGateway,
    FreeswitchSipGateway,
    GatewaySessionParams,
    InboundCallContext,
    SipBridgeSipGateway,
    VoiceblenderSipGateway,
    collect_sip_headers,
    normalise_display_name,
)
from .webrtc_peers import forward_to_owner
from pipecat.serializers.protobuf import ProtobufFrameSerializer


# WebRTC (browser) ICE servers for the SmallWebRTC transport. Defaults to
# Google's public STUN so the worker gathers a server-reflexive candidate (the
# node's public IP:port). Required on clouds that 1:1-NAT the public IP off the
# NIC (GCP/AWS, where the host candidate would otherwise be a private IP);
# harmless on DigitalOcean, where the public IP is already on the interface.
# Comma-separated STUN/TURN URLs; set WEBRTC_ICE_SERVERS="" to disable. No TURN
# by default — browser media goes direct to the node's public IP, so the WebRTC
# UDP media ports must be reachable (see deploy/k8s firewall notes).
WEBRTC_ICE_SERVERS = [
    s.strip()
    for s in os.environ.get(
        "WEBRTC_ICE_SERVERS",
        "stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302",
    ).split(",")
    if s.strip()
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Capture call-scoped logs into the InvocationLog buffer. Installed here (at
    # runtime, after all imports) so nothing resets loguru's handlers on us.
    install_capture()

    # Count how often the WebRTC output track runs dry and, crucially, how LATE
    # the audio was when it came back — the number that says whether an output
    # cushion could have covered the gap or whether the audio was never coming.
    # See output_underrun for the measurements this exists to settle.
    install_underrun_stats()
    # ...and let the queue those stats measure actually hold something. Layered
    # after the instrumentation so the cushioned class inherits it.
    install_output_cushion()

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
    # Live browser WebRTC peers keyed by pc_id, so trickle-ICE PATCHes and
    # renegotiation can find the connection a prior /webrtc/offer created.
    app.state.webrtc_connections: dict[str, SmallWebRTCConnection] = {}
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


async def _ws_deny(websocket: WebSocket, status: int, body: bytes = b"") -> None:
    """Reject a WebSocket upgrade with a specific HTTP status code.

    Uses the ASGI WebSocket Denial Response extension (uvicorn 0.20+ /
    Starlette 0.19+) — both confirmed present in this repo's lockfile.
    sipbridge captures the response via a wrapped HTTPClient transport
    and maps the HTTP status onto a SIP response code (404 → 404,
    503 → 503, etc.), so the upstream B2BUA / carrier sees a meaningful
    failure reason instead of a generic 500 Server Error.

    Falls back to ``accept() + close(code=1011)`` if the ASGI server
    doesn't advertise the extension; that loses the precise status but
    at least closes the WS cleanly.
    """
    # ASGI advertises the extension by including the key in scope[
    # "extensions"] with an empty dict value (``{"websocket.http.response":
    # {}}``). bool({}) is False, so the previous ``bool(...)`` check made
    # this branch unreachable even when uvicorn fully supported denial
    # responses. Use ``is not None`` to mean "present" without truthiness.
    has_denial = (
        websocket.scope.get("extensions", {}).get("websocket.http.response")
        is not None
    )
    logger.debug(
        f"sipbridge WS: denying upgrade with HTTP {status}, "
        f"denial_extension_supported={has_denial}"
    )
    if has_denial:
        await websocket.send({
            "type": "websocket.http.response.start",
            "status": status,
            "headers": [(b"content-type", b"text/plain; charset=utf-8")],
        })
        await websocket.send({
            "type": "websocket.http.response.body",
            "body": body,
        })
        return
    # Fallback — accept then close with a WS close code in the private-
    # use range (4xxx) that encodes the SIP status: ``close_code =
    # 4000 + sip_status``. sipbridge's call manager detects an early
    # close-with-4xxx-code and remaps it to the original SIP status, so
    # this path still yields a correct SIP response code on the wire —
    # just at the cost of a ~few-ms WS round trip vs the direct denial
    # response above.
    await websocket.accept()
    await websocket.close(code=4000 + status)


@dataclass
class _InboundOrigin:
    """Origin / transfer-mode context resolved during inbound lookup.

    Threaded into :class:`InboundCallContext` so the call session can
    resolve REFER-vs-bridge at transfer time (registration → REFER default,
    trunk → bridged default). ``force_*`` are ``None`` when the endpoint
    didn't carry the option (fall through to origin default).
    """

    registration_originated: bool = False
    force_refer_transfer: Optional[bool] = None
    force_bridged_transfer: Optional[bool] = None
    # Registration trunk username (e.g. "8092" — the A-leg's To-user / SIP
    # extension). Presented as the calling number toward the gateway on
    # transfer legs so PBXs that reject an unknown calling number (e.g. Wildix
    # -> 603 Decline) accept the call. Mirrors LiveKit's registrationUsername.
    registration_username: Optional[str] = None


async def _lookup_instance_for_inbound(
    *,
    phone_registration: Optional[str],
    to_number: Optional[str],
    aplisay_id: Optional[str],
) -> tuple[Optional[dict], _InboundOrigin]:
    """Run the inbound-call instance lookup chain, absorbing 404s.

    All three inbound paths (voiceblender VSI event, sipbridge WS headers,
    FreeSWITCH /inbound-dispatch) need the same lookup ladder:
    phone_registration → trunk+number. There is deliberately no bare-number
    rung after that: an inbound call resolves by (number, trunk) or not at
    all, so a number that failed the trunk check, or has no agent, is "no
    instance" rather than "try again without the trunk". Each step can return
    404 from the REST API; that's a "this step found nothing", not an
    error — we want to continue to the next step (and ultimately tell the
    SIP / gateway layer "no agent for this call"), not let an
    ``ApiRequestError(404)`` escape into the WS / event handler as a
    500-class crash. Other API errors (5xx, transport failures) are
    re-raised so the caller can map them to non-404 SIP statuses.

    Returns ``(instance, origin)`` where ``instance`` is ``None`` if no
    step in the chain yielded one. ``origin`` carries the transfer-mode
    context derived from the resolving endpoint (registration options /
    trunk flags). The caller is responsible for the further check that
    ``instance.get("Agent")`` is present.
    """

    async def _maybe(coro):
        try:
            return await coro
        except api_client.ApiRequestError as e:
            if e.status == 404:
                return None
            raise

    instance: Optional[dict] = None
    origin = _InboundOrigin()
    if phone_registration:
        endpoint = await _maybe(api_client.get_phone_endpoint_by_id(phone_registration))
        if endpoint and endpoint.get("instanceId"):
            instance = await _maybe(api_client.get_instance_by_id(endpoint["instanceId"]))
            if instance:
                origin.registration_originated = True
                # Trunk username (= the A-leg's To-user / SIP extension), used
                # as the calling number presented toward the gateway on
                # transfers. Mirrors LiveKit's regInfo.username capture.
                origin.registration_username = endpoint.get("username")
                opts = endpoint.get("options") or {}
                if "bridged_transfer" in opts:
                    origin.force_bridged_transfer = bool(opts.get("bridged_transfer"))
    if not instance and to_number:
        endpoint = await _maybe(api_client.get_phone_endpoint_by_number(to_number, aplisay_id))
        if endpoint and endpoint.get("instanceId"):
            instance = await _maybe(api_client.get_instance_by_id(endpoint["instanceId"]))
            if instance:
                flags = ((endpoint.get("trunk") or {}).get("flags")) or {}
                if "forceReferTransfer" in flags:
                    origin.force_refer_transfer = bool(flags.get("forceReferTransfer"))
                elif flags.get("canRefer") is True:
                    origin.force_refer_transfer = True
    return instance, origin


async def _voiceblender_resolve_agent(
    event: dict,
) -> Optional[tuple[dict, dict, _InboundOrigin]]:
    """Agent lookup for an inbound voiceblender ``leg.ringing`` VSI event.

    Same lookup chain as Daily dial-in and FreeSWITCH inbound: phone
    registration → trunk+number → number. Returns ``(instance, agent, origin)``
    or ``None`` if no agent is configured for the dialled number. ``origin``
    carries the registration/trunk transfer-mode context, threaded onto the
    inbound ctx by the gateway (mirrors the sipbridge resolver).

    The routing headers ride in the ``leg.ringing`` event's ``sip_headers``
    field (voiceblender ``LegRingingData.SIPHeaders``), the same field
    ``_on_leg_ringing`` reads to build the ctx.
    """
    headers = event.get("sip_headers") or {}
    to_number = headers.get("X-Aplisay-Called") or event.get("to")
    aplisay_id = headers.get("X-Aplisay-Trunk")
    phone_registration = headers.get("X-Aplisay-PhoneRegistration")

    instance, origin = await _lookup_instance_for_inbound(
        phone_registration=phone_registration,
        to_number=to_number,
        aplisay_id=aplisay_id,
    )
    if not instance:
        return None
    agent = instance.get("Agent")
    if not agent:
        return None
    return instance, agent, origin


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


def _aplisay_caller_id(call: api_client.CallRecord) -> Optional[str]:
    """Origin caller id as seeded at ``metadata.aplisay.callerId``.

    ``CallRecord`` deliberately has no top-level ``callerId`` field — the
    number lives only in the aplisay metadata blob (see the create_call
    payloads), and attribute access on the pydantic model raises
    AttributeError. Beta 2026-08-05: the sipbridge consult arm did exactly
    that, killing the TransferAgent WS the moment the transfer target
    answered — they heard silence while the bridge held the leg open.
    """
    meta = call.metadata if isinstance(call.metadata, dict) else {}
    return (meta.get("aplisay") or {}).get("callerId")


# X- headers on the sipbridge WS handshake that are sipbridge's own transport
# metadata, NOT part of the inbound INVITE — excluded from aplisay.sipHeaders.
# (``x-forwarded-*`` is a defensive guard against any future reverse proxy; today
# sipbridge dials the worker Service directly.) Everything else starting with
# ``x-`` on the handshake came through from the INVITE: the X-Aplisay-*/X-Lk-*
# routing contract plus any arbitrary carrier X- headers, which the sipbridge Go
# layer forwards verbatim (see sipbridge internal/call/manager.go).
_SIPBRIDGE_NON_INVITE_HEADERS = frozenset(
    {
        "x-sipbridge-call-id",
        "x-sipbridge-from",
        "x-sipbridge-from-name",
        "x-sipbridge-to",
    }
)


def _sipbridge_from_name(headers) -> Optional[str]:
    """The From header's display-name from the sipbridge WS handshake.

    sipbridge forwards it as ``X-Sipbridge-From-Name``, percent-encoded (RFC
    3986) so a non-ASCII name survives the HTTP header — Starlette decodes
    header bytes as latin-1, which would otherwise mangle UTF-8. Unquoted here
    and normalised (quotes / backslash quoted-pairs / whitespace) for
    ``metadata.aplisay.callerIdName``; ``None`` when the INVITE's From carried
    no display-name (sipbridge omits the header).
    """
    raw = headers.get("x-sipbridge-from-name")
    if not raw:
        return None
    return normalise_display_name(unquote(raw))


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

    # Extract bare numbers from SIP / SIPS / tel URIs. sipgo gives us
    # "sip:+44...@host" or — once we switched to TLS — "sips:+44...@host";
    # carriers occasionally hand off "tel:+44..." too (RFC 3966). We
    # need just the user portion ("+44...") so it matches the bare
    # number stored against the phone endpoint in the REST DB. We also
    # strip user-part parameters like ";user=phone" that some SBCs add.
    def _user_of(uri: str) -> str:
        if not uri:
            return ""
        s = uri.strip()
        if s.startswith("<") and s.endswith(">"):
            s = s[1:-1]
        # Strip URI scheme (RFC 3261 + RFC 3966). Case-insensitive
        # comparison; only one scheme present at a time.
        for scheme in ("sips:", "sip:", "tel:"):
            if s.lower().startswith(scheme):
                s = s[len(scheme):]
                break
        # SIP request-URIs are user@host[:port][;params]; tel: URIs are
        # user[;params]. Cut at @ for SIP, then drop the host. The same
        # split also handles "user@host:port;params" form.
        if "@" in s:
            s = s.split("@", 1)[0]
        # Strip user-part parameters (";user=phone", ";phone-context=...").
        if ";" in s:
            s = s.split(";", 1)[0]
        return s

    from_number = _user_of(from_uri)
    from_name = _sipbridge_from_name(h)
    # A registration trunk's B2BUA puts the dialled number in X-Aplisay-Called
    # as well as the Request-URI; the header wins when present.
    to_number = h.get("x-aplisay-called") or _user_of(to_uri)

    instance, origin = await _lookup_instance_for_inbound(
        phone_registration=phone_registration,
        to_number=to_number,
        aplisay_id=aplisay_id,
    )
    if not instance:
        return None
    agent = instance.get("Agent")
    if not agent:
        return None

    # Surface every INVITE X- header as metadata.aplisay.sipHeaders (see
    # collect_sip_headers). All handshake x-* headers except sipbridge's own
    # transport metadata came through from the INVITE.
    sip_headers = collect_sip_headers(
        h.items(),
        exclude=_SIPBRIDGE_NON_INVITE_HEADERS,
        exclude_prefixes=("x-forwarded-",),
    )

    session_id = f"sb-{uuid.uuid4()}"
    ctx = InboundCallContext(
        session_id=session_id,
        called_id=to_number,
        caller_id=from_number,
        aplisay_id=aplisay_id,
        phone_registration=phone_registration,
        b2bua_gateway_ip=b2bua_ip,
        b2bua_gateway_transport=b2bua_transport,
        registration_originated=origin.registration_originated,
        force_refer_transfer=origin.force_refer_transfer,
        force_bridged_transfer=origin.force_bridged_transfer,
        registration_username=origin.registration_username,
        call_id=aplisay_call_id,
        sip_headers=sip_headers,
        caller_id_name=from_name,
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
    # PATCH is the pipecat SmallWebRTC client's trickle-ICE + renegotiation
    # verb (see /webrtc/offer PATCH handler). Without it the browser preflight
    # gets a 400 "Disallowed CORS method" and trickle silently fails.
    allow_methods=["POST", "PATCH", "OPTIONS", "GET"],
    allow_headers=["*"],
)


# Watermarks for /healthz, env-overridable. The canary below is the decisive
# check; these catch runaway accumulation before it starves the process (the
# healthy baseline on a SIP node is ~1-2 concurrent sessions and ~25 threads).
HEALTHZ_MAX_SESSIONS = int(os.environ.get("HEALTHZ_MAX_SESSIONS", "64"))
HEALTHZ_MAX_THREADS = int(os.environ.get("HEALTHZ_MAX_THREADS", "400"))


@app.get("/healthz")
async def healthz(request: Request) -> JSONResponse:
    """Liveness/readiness that actually detects a worker unable to run calls.

    The decisive check is the THREAD-SPAWN CANARY. aiortc starts one decoder
    thread per received track inside RTCPeerConnection's connect sequence —
    AFTER the sender side is already up. When ``Thread.start()`` raises under
    process resource exhaustion, every new call connects with working outbound
    audio and no inbound audio at all: the receiver never registers with the
    RTP router, inbound RTP is silently dropped, and the only in-log trace is a
    deferred "Task exception was never retrieved". A bare TCP probe stays green
    through all of that (HTTP keeps serving); this endpoint goes 503 the moment
    the process can no longer start a thread.

    Session/peer-registry and thread-count watermarks ride along as early
    warning for the accumulation that produces the exhaustion.
    """
    problems: list[str] = []
    try:
        canary = threading.Thread(target=lambda: None, name="healthz-canary", daemon=True)
        canary.start()
        canary.join(1.0)
        if canary.is_alive():
            problems.append("thread canary did not complete within 1s")
    except Exception as e:  # noqa: BLE001 — this is precisely the failure probed for
        problems.append(f"cannot start threads: {type(e).__name__}: {e}")
    live_calls = len(getattr(request.app.state, "live_calls", {}) or {})
    peers = len(getattr(request.app.state, "webrtc_connections", {}) or {})
    try:
        threads = len(os.listdir("/proc/self/task"))
    except OSError:  # non-Linux dev hosts
        threads = threading.active_count()
    if live_calls > HEALTHZ_MAX_SESSIONS:
        problems.append(f"live_calls={live_calls} above {HEALTHZ_MAX_SESSIONS}")
    if peers > HEALTHZ_MAX_SESSIONS:
        problems.append(f"webrtc_connections={peers} above {HEALTHZ_MAX_SESSIONS}")
    if threads > HEALTHZ_MAX_THREADS:
        problems.append(f"threads={threads} above {HEALTHZ_MAX_THREADS}")
    return JSONResponse(
        {
            "ok": not problems,
            "live_calls": live_calls,
            "webrtc_connections": peers,
            "threads": threads,
            "problems": problems,
        },
        status_code=200 if not problems else 503,
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
        # Absent = unchanged (offer SRTP, downgrade if the carrier rejects it);
        # only an explicit false suppresses the offer. See OutboundCallParams.
        srtp=payload.get("srtp"),
        # A number on a registration trunk: the JS side resolved the trunk's
        # registration and its B2BUA, so the leg dials that rather than the
        # SBC, presenting the number.
        registration_endpoint_id=payload.get("registrationEndpointId"),
        b2bua_gateway_ip=payload.get("b2buaGatewayIp"),
        b2bua_gateway_transport=payload.get("b2buaGatewayTransport"),
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
    to_number = headers.get("X-Aplisay-Called") or to_number
    aplisay_id = headers.get("X-Aplisay-Trunk")
    phone_registration = headers.get("X-Aplisay-PhoneRegistration")

    if not to_number:
        raise HTTPException(status_code=400, detail="missing destination number")

    # Lookup chain — section 6.2 / 6.3.
    instance, origin = await _lookup_instance_for_inbound(
        phone_registration=phone_registration,
        to_number=to_number,
        aplisay_id=aplisay_id,
    )
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
        registration_originated=origin.registration_originated,
        force_refer_transfer=origin.force_refer_transfer,
        force_bridged_transfer=origin.force_bridged_transfer,
        registration_username=origin.registration_username,
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

    sdp = body.get("sdp")
    sdp_type = body.get("type")
    if not sdp or not sdp_type:
        raise HTTPException(status_code=400, detail="missing sdp / type")

    # Renegotiation / ICE-restart on an already-established peer. The pipecat
    # SmallWebRTC client re-POSTs to the same endpoint carrying the pc_id we
    # handed back in the original answer (restart_pc=true for an ICE restart).
    # Reuse the live connection and its running pipeline rather than standing up
    # a whole new session. Like the PATCH handler, this must reach the worker
    # that owns the pc_id, so hand it on if that is not us.
    pc_id = body.get("pc_id")
    if pc_id:
        existing = request.app.state.webrtc_connections.get(pc_id)
        if existing is None:
            owner = await forward_to_owner(
                method="POST", token=token, body=body, headers=request.headers
            )
            if owner is not None:
                return JSONResponse(owner)
            raise HTTPException(status_code=404, detail="unknown pc_id")
        await existing.renegotiate(
            sdp=sdp, type=sdp_type, restart_pc=bool(body.get("restart_pc"))
        )
        # A restart_pc renegotiation mints a FRESH pc_id: the upstream wrapper
        # strips the old aiortc peer's listeners before closing it (so no
        # "closed" event ever fires for the old identity) and _initialize()
        # assigns a new id, which the answer below hands to the browser. Re-key
        # the registry to the current id, or (a) the browser's follow-up
        # trickle PATCH — sent with the NEW id — 404s on the very pod that owns
        # the peer, forcing reconnects to limp through peer-reflexive ICE, and
        # (b) the entry under the old id can never be popped and leaks for the
        # life of the process (one leaked entry per reconnect attempt).
        if existing.pc_id != pc_id:
            request.app.state.webrtc_connections.pop(pc_id, None)
            request.app.state.webrtc_connections[existing.pc_id] = existing
        answer = existing.get_answer()
        if not answer:
            raise HTTPException(
                status_code=500, detail="webrtc renegotiation produced no answer"
            )
        return JSONResponse(answer)

    # New browser session: resolve the agent, create the Call, build + start the
    # pipeline, then answer.
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

    pc = SmallWebRTCConnection(ice_servers=WEBRTC_ICE_SERVERS)
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
        # Browser origin: a WebRTC caller has no SIP leg, so a transfer to a
        # telephony endpoint is bridged in-worker via media_relay rather than
        # natively inside a SIP gateway. This flags _on_transfer to route to
        # the worker-side relay path and makes prepare_run splice in a relay
        # endpoint. See docs/call-transfers.md.
        is_webrtc_origin=True,
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
    # Register the peer alongside the session (both are torn down together in the
    # runner's finally). Now that the session is fully built we know we'll return
    # an answer, so the browser can trickle ICE candidates (PATCH) and renegotiate
    # against this pc_id. Drop it when the peer closes.
    request.app.state.webrtc_connections[answer["pc_id"]] = pc

    @pc.event_handler("closed")
    async def _drop_webrtc_connection(conn):
        request.app.state.webrtc_connections.pop(conn.pc_id, None)

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
            # Safety net: the "closed" event handler normally drops this, but
            # aiortc has no "disconnected" state, so a vanished browser might
            # never fire it — pop here too so the map can't leak.
            request.app.state.webrtc_connections.pop(pc.pc_id, None)
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

    # Pipeline is up and running. Return the SDP answer — including pc_id, so
    # the browser can address trickle-ICE PATCHes and any later renegotiation to
    # this exact peer — and complete its end of the WebRTC handshake.
    return JSONResponse(answer)


@app.patch("/webrtc/offer")
async def webrtc_ice_candidate(request: Request) -> JSONResponse:
    """Trickle-ICE candidate delivery for an in-flight browser peer.

    The pipecat SmallWebRTC client sends its SDP offer with no ICE candidates
    (``a=ice-options:trickle``) and PATCHes them here as they're gathered,
    keyed by the ``pc_id`` we returned in the offer answer. Each is handed to
    the matching aiortc peer. Without this route the browser's candidates never
    reach the worker and the call limps along on aiortc peer-reflexive discovery
    alone — which only happens to work because the node has a public IP, and
    leaves ICE restart / reconnect (restart_pc) dead.

    SESSION AFFINITY: the offer is stateless (self-contained token, any node
    answers — see deploy/k8s README), but a peer lives on ONE node once created,
    and a PATCH is load-balanced independently of the POST that created it. On a
    two-node staging pool that put five of six sessions' candidates on the wrong
    node. Rather than depend on load-balancer stickiness — which cannot work
    here; see webrtc_peers for why — a node that does not hold this pc_id asks
    its siblings and returns their answer.
    """
    body = await request.json()
    token = request.query_params.get("token") or body.get("token")
    if not token:
        raise HTTPException(status_code=400, detail="missing token")
    # Validate signature/expiry; the unguessable pc_id is the routing key.
    verify_join_token(token)

    pc_id = body.get("pc_id")
    pc = request.app.state.webrtc_connections.get(pc_id) if pc_id else None
    if pc is None:
        owner = await forward_to_owner(
            method="PATCH", token=token, body=body, headers=request.headers
        )
        if owner is not None:
            return JSONResponse(owner)
        raise HTTPException(status_code=404, detail="unknown pc_id")

    for c in body.get("candidates") or []:
        raw = c.get("candidate")
        if not raw:
            continue  # empty string = end-of-candidates sentinel, nothing to add
        try:
            candidate = candidate_from_sdp(raw)
            candidate.sdpMid = c.get("sdp_mid")
            candidate.sdpMLineIndex = c.get("sdp_mline_index")
            await pc.add_ice_candidate(candidate)
        except Exception as e:  # noqa: BLE001
            # One malformed candidate shouldn't drop the rest of the batch.
            logger.warning(f"skipping unparseable ICE candidate {raw!r}: {e}")

    return JSONResponse({"status": "success"})


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

    # Outbound-originated leg (regular outbound OR WebRTC consult). These connect
    # with ``?uuid=<channel uuid>`` — the worker already generated that uuid in
    # ``originate()`` and pinned it as origination_uuid, so we correlate on the
    # query param directly. (mod_audio_stream only emits a start event when given
    # metadata, and its arg parser mangles JSON, so the outbound path deliberately
    # does NOT depend on a start event.) The originating coroutine owns and drives
    # the session; we just keep this WebSocket open until it tears down.
    outbound_uuid = websocket.query_params.get("uuid")
    if outbound_uuid and sip_gateway.has_pending_outbound(outbound_uuid):
        gw_session = sip_gateway.register_inbound_session(
            channel_uuid=outbound_uuid,
            transport=transport,
            session_id=outbound_uuid,
        )
        logger.bind(channel_uuid=outbound_uuid).info(
            "freeswitch outbound leg connected; handed transport to originator"
        )
        try:
            await gw_session.wait_finished()
        except WebSocketDisconnect:
            pass
        return

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
            caller_id=_aplisay_caller_id(parent.call),
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
    upstream :class:`ProtobufFrameSerializer` — voiceblender speaks the same
    ``pipecat.Frame`` proto its own ``examples/pipecat-agent/bot.py`` does,
    just from Go instead of Python, and (unlike sipbridge) only ever sends
    Audio and Text frames over this socket.

    DTMF is *not* carried on this audio WebSocket: voiceblender decodes
    RFC 4733 tones in its pion media layer and publishes them on its VSI
    event stream as ``dtmf.received``. The gateway's VSI subscriber handles
    that event and injects an ``InputDTMFFrame`` into the running pipeline —
    see :meth:`VoiceblenderSipGateway._on_leg_dtmf` and
    :meth:`CallSession.inject_dtmf`.

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

    # Human-to-agent takeover leg (``options.bridgedTransferToAgent``): a
    # DTMF match on a bridged call dropped the transfer target and re-
    # attached a Pipecat agent to the caller leg under a fresh session id.
    # Everything the incoming agent needs was stashed at match time — see
    # ``bridged_transfer.py``.
    takeover = sip_gateway.takeover_payload(session_id)
    if takeover is not None:
        transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                add_wav_header=False,
                serializer=ProtobufFrameSerializer(),
            ),
        )
        aplisay_meta = (
            takeover.call.metadata.get("aplisay", {})
            if isinstance(takeover.call.metadata, dict)
            else {}
        )
        ctx = InboundCallContext(
            session_id=session_id,
            called_id=aplisay_meta.get("calledId"),
            caller_id=aplisay_meta.get("callerId"),
            raw={"transport": transport, "leg_id": takeover.extra.get("leg_id")},
        )
        try:
            session = await setup_takeover_call(sip_gateway, ctx, payload=takeover)
        except Exception as e:  # noqa: BLE001
            logger.bind(session_id=session_id).error(
                f"voiceblender takeover setup failed: {e}"
            )
            await websocket.close(code=1011)
            sip_gateway.clear_takeover_session(session_id)
            return
        websocket.app.state.live_calls[session.call.id] = session
        try:
            await _run_session(websocket.app, session, session.call.id)
        except WebSocketDisconnect:
            pass
        finally:
            sip_gateway.clear_takeover_session(session_id)
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
    # NB: the serializer just above is the plain ProtobufFrameSerializer, not
    # DtmfProtobufFrameSerializer — voiceblender delivers DTMF via VSI, not
    # this socket (see the handler docstring).

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
    at 16 kHz mono via :class:`DtmfProtobufFrameSerializer`, which decodes
    the bridge's ``{"type":"dtmf",...}`` transport messages into
    ``InputDTMFFrame``s). The difference
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
    # Warm-transfer consult leg (``transfer(operation="consultative")``):
    # ``_do_consultative`` registered this session id in the gateway's
    # consult map — NOT ``_pending_outbound`` — before POSTing /consult,
    # and the bridge dials us back on it once the third party answers. It
    # must route into the outbound-family flow below: falling through to
    # the inbound resolver would 404-deny the WS (worker-initiated legs
    # carry no ``x-sipbridge-to`` header), tearing down the consult leg
    # the moment the transfer target picks up.
    parent_session_id = sip_gateway.consult_parent(session_id)
    bridge_call_id = (
        websocket.headers.get("x-sipbridge-call-id")
        or websocket.headers.get("X-Sipbridge-Call-ID")
        or ""
    )

    # Human-to-agent takeover leg (``options.bridgedTransferToAgent``): a
    # DTMF match on a monitored bridge POSTed /unbridge, and the bridge has
    # re-dialled the surviving caller leg to us under a fresh session id.
    # Everything the incoming agent needs was stashed at match time — see
    # ``bridged_transfer.py``.
    takeover = sip_gateway.takeover_payload(session_id)
    if takeover is not None:
        await websocket.accept()
        transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                add_wav_header=False,
                serializer=DtmfProtobufFrameSerializer(),
                audio_in_sample_rate=16000,
                audio_out_sample_rate=16000,
            ),
        )
        ctx = InboundCallContext(
            session_id=session_id,
            called_id=takeover.call.metadata.get("aplisay", {}).get("calledId")
            if isinstance(takeover.call.metadata, dict) else None,
            caller_id=takeover.call.metadata.get("aplisay", {}).get("callerId")
            if isinstance(takeover.call.metadata, dict) else None,
            raw={"transport": transport, "bridge_call_id": bridge_call_id},
        )
        try:
            session = await setup_takeover_call(sip_gateway, ctx, payload=takeover)
        except Exception as e:  # noqa: BLE001
            logger.bind(session_id=session_id).error(
                f"sipbridge takeover setup failed: {e}"
            )
            await websocket.close(code=1011)
            sip_gateway.clear_takeover_session(session_id)
            return
        sip_gateway.register_inbound_session(
            session_id=session_id,
            bridge_call_id=bridge_call_id,
            transport=transport,
        )
        websocket.app.state.live_calls[session.call.id] = session
        try:
            await _run_session(websocket.app, session, session.call.id)
        except WebSocketDisconnect:
            pass
        finally:
            sip_gateway.clear_takeover_session(session_id)
            sip_gateway.unregister_session(session_id)
        return

    if is_outbound or parent_session_id:
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
        #       recorded a parent_session_id for this consult session id
        #       (that's what routed us here); we build a fresh
        #       CallSession using the parent's agent + instance and run
        #       a second pipeline here in the handler (same shape as
        #       inbound).
        await websocket.accept()
        serializer = DtmfProtobufFrameSerializer()
        transport = FastAPIWebsocketTransport(
            websocket=websocket,
            params=FastAPIWebsocketParams(
                audio_in_enabled=True,
                audio_out_enabled=True,
                add_wav_header=False,
                serializer=serializer,
                # The bridge speaks PCM16LE mono at 16 kHz over the WS in both
                # directions (it up/downsamples to 8 kHz G.711 on the RTP wire).
                # Pin the transport rates so Pipecat's resamplers converge on 16
                # kHz before frames hit the WS — without this, outbound legs
                # (agent originate AND WebRTC-transfer relay legs) leak the LLM's
                # native rate (e.g. 24 kHz) onto the wire and the bridge warns /
                # distorts. Mirrors the inbound path below.
                audio_in_sample_rate=16000,
                audio_out_sample_rate=16000,
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
                # The consult record's calledId/callerId must be real strings
                # — the agent-db API 400s a null (beta 2026-08-05: calledId=
                # None failed every consult-record POST, so the TransferAgent
                # never spawned and the answered target heard silence).
                # calledId = the transfer destination, stashed on the
                # ConsultPayload at _do_consultative time; callerId = the
                # origin caller from the parent's aplisay metadata.
                called_id=payload.destination or "unknown",
                caller_id=_aplisay_caller_id(consult_parent.call) or "unknown",
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

        # Plain outbound — wait for done. The leg-done event also fires when
        # a bridged transfer-to-agent watch is armed mid-call
        # (``signal_bta_armed``); in that case the WS is still open and we
        # take over reading it for transfer-target DTMF.
        done_event = sip_gateway.wait_for_leg_done(session_id)
        try:
            await done_event.wait()
            gw_session = sip_gateway.live_session(session_id)
            bta_ctx = getattr(gw_session, "bta_context", None) if gw_session else None
            if bta_ctx is not None:
                await run_sipbridge_bta_watch(
                    websocket, sip_gateway, gw_session, bta_ctx, platform=PLATFORM
                )
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
    # On lookup failure we reject the upgrade with an HTTP status that
    # sipbridge maps onto a SIP response code (404 → SIP 404 Not Found,
    # 503 → SIP 503, etc.). Without this the SIP transaction sees a
    # generic 500 Server Error for every reason a call can't be placed,
    # which is useless to the upstream B2BUA / carrier.
    try:
        resolved = await _sipbridge_resolve_agent_from_headers(websocket)
    except api_client.ApiRequestError as e:
        # Non-404 from the REST API (transport error, 5xx, 401…). 404
        # is already absorbed inside the lookup helper.
        logger.warning(
            "sipbridge WS: REST lookup failed "
            f"(status={e.status}, to={websocket.headers.get('x-sipbridge-to')!r})"
        )
        # 401/403 → leave as-is so the carrier sees a meaningful auth
        # failure; otherwise map to 503 (we couldn't reach our own
        # control plane, the call isn't going through).
        sip_class = e.status if e.status in (401, 403) else 503
        await _ws_deny(websocket, sip_class, b"agent-db lookup failed")
        return
    if resolved is None:
        logger.info(
            "sipbridge WS: no agent for inbound call "
            f"(to={websocket.headers.get('x-sipbridge-to')!r})"
        )
        await _ws_deny(websocket, 404, b"no agent for dialled number")
        return
    instance, agent, ctx = resolved

    await websocket.accept()

    serializer = DtmfProtobufFrameSerializer()
    transport = FastAPIWebsocketTransport(
        websocket=websocket,
        params=FastAPIWebsocketParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            add_wav_header=False,
            serializer=serializer,
            # The bridge speaks PCM16LE mono at 16 kHz over the WS in
            # both directions — its codec layer up/downsamples between
            # 16 kHz on the WS and 8 kHz on the RTP wire (G.711 PCMU/A).
            # Pin the transport rates so Pipecat's internal resamplers
            # converge on 16 kHz before frames hit the WS, no matter
            # what the LLM service emits natively (Ultravox is 24 kHz,
            # OpenAI Realtime is 24 kHz, others vary). Without this
            # we'd let the LLM's native rate leak through and the
            # bridge would mis-interpret it as 16 kHz → pitch-shifted
            # / distorted audio at both ends.
            audio_in_sample_rate=16000,
            audio_out_sample_rate=16000,
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
        # Human-to-agent transfers: when a monitored bridge was installed,
        # the bridge kept this WS open as a control channel and the
        # CallSession stashed the watch context on the gateway session.
        # Keep reading the socket for transfer-target DTMF until the
        # bridge ends (or an unbridge takeover replaces this WS).
        bta_ctx = getattr(session.gateway_session, "bta_context", None)
        if bta_ctx is not None:
            await run_sipbridge_bta_watch(
                websocket,
                sip_gateway,
                session.gateway_session,
                bta_ctx,
                platform=PLATFORM,
            )
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
