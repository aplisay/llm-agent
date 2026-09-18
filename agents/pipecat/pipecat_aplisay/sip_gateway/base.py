"""Gateway-agnostic interface for SIP termination + media bridging.

A SipGateway is responsible for:

- Accepting an inbound SIP INVITE (from an SBC, B2BUA, or carrier trunk) and
  exposing the media to the worker as a Pipecat transport.
- Originating an outbound SIP INVITE on demand and exposing the media as a
  transport, populating wire headers per the contract.
- Performing call-control operations the agent can request mid-call:
  blind transfer, blind-bridge transfer (waitUntilAnswered), hangup.

The architecture doc's wire-header contract (X-Aplisay-Trunk,
X-Aplisay-PhoneRegistration, X-Aplisay-Origin-Caller-Id, X-Aplisay-Call-Id, plus
the B2BUA path's X-Lk-RealIp and X-Lk-Transport) lives at this seam: the gateway
implementation either preserves it on the wire and surfaces what arrived in
:class:`InboundCallContext`, or — when the chosen gateway hides SIP details —
documents which fields it cannot honour.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

from pipecat.transports.base_transport import BaseTransport


@dataclass
class InboundCallContext:
    """What the gateway tells the worker about an inbound call.

    Fields map onto the wire-header contract from sections 6.2 / 6.3 of the
    architecture doc. Any field the gateway can't surface is left None and the
    worker degrades gracefully (e.g. defaulting canRefer=false, falling back to
    direct number lookup).
    """

    # Always populated.
    session_id: str
    called_id: Optional[str]  # the dialled number (E.164, normalised)
    caller_id: Optional[str]  # the caller's number (E.164, normalised)

    # Trunk path (SBC).
    aplisay_id: Optional[str] = None  # X-Aplisay-Trunk

    # Registration path (B2BUA).
    phone_registration: Optional[str] = None  # X-Aplisay-PhoneRegistration
    b2bua_gateway_ip: Optional[str] = None    # X-Lk-RealIp
    b2bua_gateway_transport: Optional[str] = None  # X-Lk-Transport

    # True when the call originated through a registration endpoint (B2BUA
    # path) rather than a SIP trunk. Drives the transfer-mode default:
    # registration → REFER, trunk → bridged. See ``docs/call-transfers.md``.
    registration_originated: bool = False

    # Resolved origin transfer-mode overrides, read from the phone endpoint's
    # options (registration) or trunk flags (number) at inbound lookup time.
    #   - force_refer_transfer: trunk option to default this trunk to REFER.
    #   - force_bridged_transfer: registration option to default to bridged.
    # Per-transfer params still take precedence over these. ``None`` means the
    # gateway couldn't determine the option (degrade to origin default).
    force_refer_transfer: Optional[bool] = None
    force_bridged_transfer: Optional[bool] = None

    # Registration trunk username (e.g. "8092"), captured from the phone
    # endpoint at inbound lookup. Used as the calling number presented toward
    # the gateway on transfer legs (mirrors LiveKit's registrationUsername /
    # fromNumber). ``None`` for non-registration (trunk) calls.
    registration_username: Optional[str] = None

    # Pre-existing platform call UUID if the gateway can stamp one through.
    call_id: Optional[str] = None  # X-Aplisay-Call-Id

    # All X- headers from the inbound SIP INVITE, lowercased, as
    # ``{"x-header-name": value}``. Only the sipbridge and voiceblender gateways
    # populate this — they carry the raw INVITE headers (sipbridge on the WS
    # handshake, voiceblender in the ``leg.ringing`` custom_headers). It stays
    # ``None`` for the Daily / FreeSWITCH ingress, which don't surface arbitrary
    # inbound headers. Surfaced to the agent as ``metadata.aplisay.sipHeaders``
    # (see ``call_session.setup_inbound_call``).
    sip_headers: Optional[dict] = None

    # Free-form gateway-specific bag (e.g. Daily room metadata, raw SIP headers).
    raw: dict = field(default_factory=dict)


def collect_sip_headers(
    pairs,
    *,
    exclude: frozenset = frozenset(),
    exclude_prefixes: tuple = (),
) -> dict:
    """Build a ``metadata.aplisay.sipHeaders`` map from ``(name, value)`` header
    pairs (INVITE X- headers).

    Keeps only ``x-*`` entries, lowercases the header names, and drops any name
    in ``exclude`` or matching one of ``exclude_prefixes`` — used to filter out a
    gateway's own transport / handshake headers that didn't come from the
    INVITE. ``None`` values are skipped; later duplicates win. Shared by the
    sipbridge (WS handshake headers) and voiceblender (``leg.ringing``
    custom_headers) inbound paths.
    """
    out: dict = {}
    for name, value in pairs:
        if value is None:
            continue
        lname = str(name).lower()
        if not lname.startswith("x-"):
            continue
        if lname in exclude or any(lname.startswith(p) for p in exclude_prefixes):
            continue
        out[lname] = value
    return out


@dataclass
class OutboundCallParams:
    """Inputs to originate an outbound call.

    `caller_id` and `called_id` are E.164. `aplisay_id` identifies the trunk to
    use for SBC outbound; the gateway implementation is responsible for stamping
    X-Aplisay-Trunk per section 6.4.
    """

    caller_id: str
    called_id: str
    call_id: str
    aplisay_id: Optional[str] = None
    # Set when originating through a registration endpoint (B2BUA path,
    # section 6.5).
    registration_endpoint_id: Optional[str] = None
    b2bua_gateway_ip: Optional[str] = None
    b2bua_gateway_transport: Optional[str] = None
    # Trunk media-security contract (``Trunk.flags.srtp`` in llm-agent). None
    # means "unchanged": offer SRTP and let the sipbridge downgrade on a
    # 415/488/606. False suppresses the offer outright, which is the only thing
    # that works for a carrier that ADVERTISES RTP/SAVP and then sends plain
    # RTP — nothing rejects the offer, so the downgrade never fires, and every
    # inbound packet is then dropped on its auth tag until the media timeout
    # kills the call. Stamped onto the leg as ``X-Aplisay-Srtp: off``.
    srtp: Optional[bool] = None


@dataclass
class GatewaySessionParams:
    """Knobs for setting up a media session at the gateway."""

    session_id: str
    # If set, the gateway should record audio in the format it natively supports;
    # the worker handles encryption + upload separately (see recording.py).
    enable_recording: bool = False


@dataclass
class TransferRequest:
    """Inputs to a mid-call transfer.

    Matches the operation taxonomy documented in ``docs/call-transfers.md``:

      - ``blind``        — direct REFER (or bridged fallback when REFER
                           isn't available, or when ``force_bridged`` is
                           set).
      - ``consultative`` — warm transfer: a separate TransferAgent runs
                           on a fresh leg to the third party and decides
                           whether to bridge.

    Older internal callers may still pass ``operation="bridged"`` —
    gateway implementations should treat that as ``blind`` +
    ``force_bridged=True`` for backwards compatibility.
    """

    destination: str  # number or SIP URI
    operation: str  # "blind" or "consultative" — see docstring
    caller_id_override: Optional[str] = None
    # The genuine originating caller (the inbound A-leg's caller). The From
    # toward the gateway may be rewritten to the trunk username for call
    # admission, so we additionally surface the real origin as
    # X-Aplisay-Origin-Caller-Id on the transfer leg; the B2BUA turns it into a
    # P-Asserted-Identity. Mirrors LiveKit's X-Aplisay-Origin-Caller-Id header.
    origin_caller_id: Optional[str] = None
    can_refer: bool = False  # if False, force blind-bridge per section 6.7
    force_bridged: bool = False
    # Egress trunk's media-security contract, same meaning and provenance as
    # ``OutboundCallParams.srtp`` — a transfer leg dials out over a trunk just
    # as an originate does, so a carrier that cannot really do SRTP must be
    # honoured here too.
    srtp: Optional[bool] = None

    # Egress routing for the legs the gateway *originates* (dial_bridge and
    # the consultative consult leg). Same tuple as OutboundCallParams, for the
    # same reason: the bridge has no outbound proxy, so a bare-number
    # destination must be resolved to a routable URI — registration origin →
    # the registration's B2BUA gateway, trunk origin → the global outbound
    # SBC — and the upstream SBC picks the carrier route off
    # X-Aplisay-Trunk / X-Aplisay-PhoneRegistration. Populated by the call
    # session from the origin call's context; all-None falls through to the
    # outbound-SBC default with no trunk header (IP-gated SBCs).
    aplisay_id: Optional[str] = None
    registration_endpoint_id: Optional[str] = None
    b2bua_gateway_ip: Optional[str] = None
    b2bua_gateway_transport: Optional[str] = None

    # Force the final hop to be completed via SIP REFER (with ?Replaces for
    # the consultative finalize) regardless of the origin default. Takes
    # precedence over ``force_bridged`` when both are set. Mirrors the
    # LiveKit ``forceRefer`` transfer arg — see ``docs/call-transfers.md``.
    force_refer: bool = False

    # Consultative-transfer fields. Populated by the call session when
    # ``operation == "consultative"``; ignored otherwise. Mirrors the
    # LiveKit transfer-handler contract — see ``docs/call-transfers.md``
    # and ``transfer_prompts.py``.
    #
    # ``transfer_prompt_template`` is the already-resolved template
    # (precedence: args.transferPrompt → agent.options.transferPrompt →
    # ``DEFAULT_TRANSFER_PROMPT_TEMPLATE``) as a single string.
    # ``${parentTranscript}`` placeholders are NOT yet substituted; the
    # gateway / consult flow does that just before building the
    # TransferAgent's system prompt so the transcript is as fresh as
    # possible.
    transfer_prompt_template: Optional[str] = None
    parent_transcript: Optional[str] = None

    # Human-to-agent transfers (``options.bridgedTransferToAgent``): ask the
    # gateway to keep watching the transfer-target leg for DTMF after the
    # bridge is installed, so the worker can drop the target and hand the
    # caller to another agent. Only meaningful on the bridged paths — the
    # caller session forces ``force_bridged`` when the option is set. See
    # ``bridged_transfer.py`` and ``docs/call-transfers.md``.
    monitor_dtmf: bool = False

    # Bridged-segment transcription (``options.bridgedTransferTranscribe``):
    # ask the gateway to keep a transcription path over the bridge. On
    # sipbridge this streams a stereo audio tap on the kept-open monitor WS;
    # on voiceblender the worker starts the container's native per-leg STT
    # instead (this flag still forces the bridged path + monitoring WS/
    # record lifecycle). See ``bridge_transcript.py``.
    tap_audio: bool = False


class GatewaySession(Protocol):
    """A live media session owned by the gateway.

    Hands out a Pipecat transport for the agent to drive, plus call-control
    primitives. Concrete implementations decide how the underlying SIP / media
    plumbing is wired.
    """

    transport: BaseTransport
    session_id: str

    async def hangup(self, reason: str) -> None: ...

    async def transfer(self, req: TransferRequest) -> None: ...

    async def shutdown(self) -> None: ...

    async def bridge_with(
        self, other: "GatewaySession", *, monitor_dtmf: bool = False, tap_audio: bool = False
    ) -> None:
        """Install media relay between this session and ``other``.

        Used to finalise consultative transfers — when the TransferAgent
        on the consult leg calls ``accept_transfer``, the parent leg
        and the consult leg get bridged together (bot WSes close, A and
        C talk directly through the gateway until either BYEs).

        ``monitor_dtmf`` (human-to-agent transfers,
        ``options.bridgedTransferToAgent``) asks the gateway to keep
        surfacing transfer-target DTMF to the worker after the bridge is
        installed — see ``bridged_transfer.py``.

        Default implementation raises ``NotImplementedError`` —
        gateways that support consultative transfer override this with
        gateway-specific primitives (REST bridge, ESL uuid_bridge, etc.).
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not support bridge_with "
            f"(consultative transfer); operation=\"consultative\" should be "
            f"rejected upstream by ``transfer()``."
        )

    async def attended_refer_with(self, other: "GatewaySession") -> None:
        """Finalise a consultative transfer via attended SIP REFER.

        Instead of installing a media bridge (``bridge_with``), send the
        parent leg a ``REFER`` whose ``Refer-To`` embeds a
        ``?Replaces=<consult-dialog>`` pointing at ``other`` (the consult
        leg). The transferee's UA then re-INVITEs the consult target
        directly, replacing the consult dialog, and both bot legs drop out
        of the media path. See RFC 3891 and ``docs/call-transfers.md``.

        Default implementation raises ``NotImplementedError`` — gateways
        that can't drive a raw REFER fall back to ``bridge_with``.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not support attended_refer_with; "
            f"fall back to bridge_with."
        )

    async def send_dtmf(self, digits: str) -> None:
        """Play ``digits`` to the remote party as out-of-band RFC 4733
        (telephone-event) DTMF over the SIP leg.

        Drives the ``send_dtmf`` builtin platform function. The gateway is
        responsible for putting genuine telephone-event onto the wire —
        sipbridge encodes it in its own RTP layer; voiceblender asks the
        external media platform to. ``digits`` is pre-validated by the caller
        to the alphabet 0-9, * and #.

        Default implementation raises ``NotImplementedError`` — gateways whose
        media plane can't synthesise out-of-band DTMF (e.g. Daily, FreeSWITCH)
        inherit this, and the call session surfaces it to the LLM as a clean
        "not supported on this gateway" tool result.
        """
        raise NotImplementedError(
            f"{type(self).__name__} does not support send_dtmf "
            f"(out-of-band RFC 4733 DTMF)."
        )


@dataclass
class ConsultPayload:
    """The warm-transfer state stashed on the gateway between the
    parent CallSession requesting ``transfer(consultative)`` and the
    consult leg's media WebSocket arriving at the worker.

    LiveKit-parity contract — see ``docs/call-transfers.md`` and
    ``pipecat_aplisay/transfer_prompts.py``:

      - ``parent_session_id`` lets the worker's WS handler find the
        parent CallSession in ``app.state.live_calls`` (so the
        TransferAgent's accept/reject builtins can drive its
        transfer_state).
      - ``transfer_prompt_template`` is the already-resolved template
        (precedence: args.transferPrompt → agent.options.transferPrompt
        → DEFAULT_TRANSFER_PROMPT_TEMPLATE). Still contains
        ``${parentTranscript}`` — the WS handler substitutes that just
        before passing the prompt to the TransferAgent's CallSession.
      - ``parent_transcript`` is the snapshot of the parent's chat
        history at the moment ``transfer(consultative)`` was called,
        rendered as ``> caller:`` / ``> agent:`` lines.

    The same dataclass is reused across the FreeSWITCH, sipbridge, and
    voiceblender gateways. Each gateway's ``_do_consultative`` calls
    ``register_consult_session`` to stash it and the worker's per-
    gateway WS handler reads it via ``consult_payload``.

    ``destination`` is the transfer target as requested (pre URI
    normalisation) — the consult call record's ``calledId``. Gateways
    whose WS arrival carries the dialled number natively (FreeSWITCH
    ``start.called_id``, voiceblender's pending inbound ctx) may leave
    it empty; sipbridge has nothing else to read it from (the bridge
    dials us back with only the session id in the URL), and the
    agent-db API rejects a null calledId outright.
    """

    parent_session_id: str
    transfer_prompt_template: str
    parent_transcript: str
    destination: str = ""


class ConsultStateMixin:
    """Shared state machine for warm-transfer (consultative) flows.

    Adds three small maps to a gateway:

      * ``_consult_payloads``  — pending consult-session payloads keyed
        by ``consult_session_id``.
      * ``_consult_call_ids``  — per-parent-session, the bridge call
        id of the consult leg (so accept_transfer can target it for
        the bridged-relay finalisation).
      * (gateway-specific) per-WS bookkeeping is kept on the gateway
        itself.

    Inheriting gateways must call ``_init_consult_state()`` from their
    constructor (Python doesn't run mixin ``__init__`` automatically
    unless we use a strict cooperative-multiple-inheritance pattern).
    """

    def _init_consult_state(self) -> None:
        self._consult_payloads: dict[str, ConsultPayload] = {}
        self._consult_call_ids: dict[str, str] = {}
        # Human-to-agent takeovers (``options.bridgedTransferToAgent``):
        # pending payloads keyed by the fresh agent-WS session id chosen at
        # DTMF-match time. The per-gateway WS handler reads these to build the
        # incoming agent's CallSession — mirrors the consult stash above. The
        # values are ``bridged_transfer.TakeoverPayload`` instances (kept
        # untyped here to avoid a circular import).
        self._takeover_payloads: dict[str, Any] = {}

    def register_takeover_session(self, session_id: str, payload: Any) -> None:
        self._takeover_payloads[session_id] = payload

    def takeover_payload(self, session_id: str) -> Optional[Any]:
        return self._takeover_payloads.get(session_id)

    def clear_takeover_session(self, session_id: str) -> None:
        self._takeover_payloads.pop(session_id, None)

    def register_consult_session(
        self,
        *,
        consult_session_id: str,
        parent_session_id: str,
        transfer_prompt_template: str,
        parent_transcript: str,
        destination: str = "",
    ) -> None:
        self._consult_payloads[consult_session_id] = ConsultPayload(
            parent_session_id=parent_session_id,
            transfer_prompt_template=transfer_prompt_template,
            parent_transcript=parent_transcript,
            destination=destination,
        )

    def consult_payload(self, session_id: str) -> Optional[ConsultPayload]:
        return self._consult_payloads.get(session_id)

    def consult_parent(self, session_id: str) -> Optional[str]:
        p = self._consult_payloads.get(session_id)
        return p.parent_session_id if p else None

    def clear_consult_session(self, consult_session_id: str) -> None:
        self._consult_payloads.pop(consult_session_id, None)

    def set_consult_call_id(self, session_id: str, consult_call_id: str) -> None:
        self._consult_call_ids[session_id] = consult_call_id

    def get_consult_call_id(self, session_id: str) -> Optional[str]:
        return self._consult_call_ids.get(session_id)

    def clear_consult_call_id(self, session_id: str) -> None:
        self._consult_call_ids.pop(session_id, None)


class SipGateway(Protocol):
    """Pluggable SIP gateway. One implementation per backing technology."""

    name: str

    async def setup_inbound(
        self, ctx: InboundCallContext, params: GatewaySessionParams
    ) -> GatewaySession:
        """Bridge an already-arrived inbound call into a live media session."""
        ...

    async def originate(
        self, params: OutboundCallParams, session_params: GatewaySessionParams
    ) -> GatewaySession:
        """Originate an outbound call and return the live media session."""
        ...
