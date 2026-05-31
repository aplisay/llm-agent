"""SIP gateway abstraction.

The worker treats SIP termination as a swappable component. Anything implementing
:class:`SipGateway` can stand in: Daily today, FreeSWITCH/Asterisk later, a wholesale
trunk provider, etc. The abstraction is deliberately narrow — it does media bridging
and out-of-band call control (transfer, hangup); everything above it (call lifecycle,
tool dispatch, transfer state, recording) is gateway-agnostic.

See section 6 of docs/livekit-agent-architecture.md for the wire-header contract this
abstraction must preserve to the extent the chosen gateway exposes it.
"""

from .base import (
    SipGateway,
    InboundCallContext,
    OutboundCallParams,
    GatewaySession,
    GatewaySessionParams,
)
from .daily_gateway import DailySipGateway
from .freeswitch_gateway import FreeswitchSipGateway
from .sipbridge_gateway import SipBridgeSipGateway
from .voiceblender_gateway import VoiceblenderSipGateway

__all__ = [
    "SipGateway",
    "InboundCallContext",
    "OutboundCallParams",
    "GatewaySession",
    "GatewaySessionParams",
    "DailySipGateway",
    "FreeswitchSipGateway",
    "SipBridgeSipGateway",
    "VoiceblenderSipGateway",
]
