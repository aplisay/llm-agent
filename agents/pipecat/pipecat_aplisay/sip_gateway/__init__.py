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
    collect_sip_headers,
)
try:
    from .daily_gateway import DailySipGateway
except ImportError as exc:
    # Keep a placeholder type when Daily is excluded so isinstance checks remain valid and other gateways can boot. See
    # PR #193.
    from loguru import logger

    _daily_import_error = exc
    logger.info(f"daily gateway unavailable in this build: {exc}")

    class DailySipGateway:  # type: ignore[no-redef]
        """Placeholder for images built without the daily transport."""

        def __init__(self, *args: object, **kwargs: object) -> None:
            raise RuntimeError(
                "SIP_GATEWAY=daily requested but the daily transport is not "
                "installed in this image (built with ONLY_TRANSPORTS "
                f"excluding 'daily'): {_daily_import_error}"
            )


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
    "collect_sip_headers",
]
