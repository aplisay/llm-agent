"""Aplisay Pipecat agent worker.

Implements the worker-tier contract from docs/livekit-agent-architecture.md
against Pipecat. Independent of LiveKit. Uses Daily as a pure SIP gateway
(swappable via the sip_gateway abstraction); SmallWebRTCTransport for browser
clients.
"""

__all__ = []
