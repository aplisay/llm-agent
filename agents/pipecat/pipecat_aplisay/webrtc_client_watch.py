"""Notice a browser that vanished from a SmallWebRTC call.

A tab that closes with no hang-up sends no DTLS shutdown, and aiortc has no
"disconnected" state, so the peer only closes when ICE consent expires (about
30 s). Pipecat tracks the client's one-per-second data-channel ping in
``SmallWebRTCConnection.is_connected()`` but never acts on losing it.
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from typing import Any

from loguru import logger

# is_connected() turns false this long after the last ping (hard-coded upstream).
PING_STALE_SECS = 3.0


async def packets_received(connection: Any) -> int | None:
    """Datagrams received from the peer so far, or None when it cannot be read."""
    try:
        report = await connection.pc.getStats()
        counts = [
            s.packetsReceived for s in report.values() if getattr(s, "type", None) == "transport"
        ]
    except Exception as e:  # noqa: BLE001
        logger.debug(f"webrtc client watch: cannot read transport stats: {e}")
        return None
    return sum(counts) if counts else None


async def watch_client_gone(
    connection: Any,
    limit_secs: float,
    *,
    poll_secs: float = 1.0,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
    now: Callable[[], float] = time.monotonic,
) -> None:
    """Return once the client has sent no ping and no packet for ``limit_secs``.

    Never returns for a client that does not ping, nor when the packet count
    cannot be read: both keep the ICE consent behaviour.
    """
    was_connected = False
    stale_since: float | None = None
    packets_then: int | None = None
    while True:
        await sleep(poll_secs)
        if connection.is_connected():
            was_connected = True
            stale_since = None
            continue
        # is_connected() is also false before the pipeline connects and while a
        # restart_pc renegotiation brings up a new peer. Neither is a lost ping.
        if not was_connected or connection.pc.connectionState != "connected":
            stale_since = None
            continue
        if stale_since is None:
            stale_since = now() - PING_STALE_SECS
            packets_then = await packets_received(connection)
            continue
        if now() - stale_since < limit_secs:
            continue
        packets_now = await packets_received(connection)
        if packets_then is not None and packets_now is not None and packets_now <= packets_then:
            return
        # Packets still arrive (a page with frozen timers but live media), or
        # the count is unreadable. Start a new window.
        stale_since = now()
        packets_then = packets_now


async def close_when_client_gone(
    connection: Any, limit_secs: float, fired: asyncio.Event, call_id: str
) -> None:
    """Close the peer once the client is gone. ``fired`` is set before the close starts."""
    try:
        await watch_client_gone(connection, limit_secs)
        fired.set()
        logger.warning(
            f"webrtc client gone: no ping or packet for {limit_secs:g}s, "
            f"closing peer (callId={call_id})"
        )
        await connection.disconnect()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"webrtc client watch failed: {e}")
