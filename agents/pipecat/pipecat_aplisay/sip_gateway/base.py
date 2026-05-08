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

    # Pre-existing platform call UUID if the gateway can stamp one through.
    call_id: Optional[str] = None  # X-Aplisay-Call-Id

    # Free-form gateway-specific bag (e.g. Daily room metadata, raw SIP headers).
    raw: dict = field(default_factory=dict)


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


@dataclass
class GatewaySessionParams:
    """Knobs for setting up a media session at the gateway."""

    session_id: str
    # If set, the gateway should record audio in the format it natively supports;
    # the worker handles encryption + upload separately (see recording.py).
    enable_recording: bool = False


@dataclass
class TransferRequest:
    """Inputs to a mid-call transfer."""

    destination: str  # number or SIP URI
    operation: str  # "blind" or "bridged" or "consult"
    caller_id_override: Optional[str] = None
    can_refer: bool = False  # if False, force blind-bridge per section 6.7
    force_bridged: bool = False


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
