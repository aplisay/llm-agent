"""Deliver a WebRTC signalling request to whichever node owns the peer.

WHY THIS EXISTS (measured on staging, 2026-08-25)
-------------------------------------------------
A browser's SDP offer is stateless — any node can answer it — but the aiortc
peer that answering creates lives on ONE node, in that process's
``app.state.webrtc_connections`` under its ``pc_id``. Everything the browser
sends afterwards (trickle candidates via ``PATCH``, renegotiation and ICE
restart via ``POST`` with a ``pc_id``) is load-balanced independently of the
original ``POST``, so it reaches the owning node only by luck. Over a 20-hour
sample on staging, **five of six browser sessions had every trickle candidate
404'd on the wrong node** — the client logs it and limps on with peer-reflexive
discovery, which happens to work because the nodes have public IPs, and which
leaves ICE restart dead.

``sessionAffinity: ClientIP`` on the Service cannot fix that. With
``externalTrafficPolicy: Local`` and one pod per node, the pod is decided by
which NODE the cloud load balancer picked, and kube-proxy's affinity table is
per-node — it can never move a request between nodes. DigitalOcean's only
stickiness mode is a cookie, and this is a cross-origin ``fetch`` that neither
asks for credentials nor should be allowed to send them: the offer endpoint is
deliberately credential-free, gated by an HMAC-signed time-limited token, which
is exactly why it can safely allow a wildcard origin.

So the routing is fixed here, where the state actually is: a node that does not
hold ``pc_id`` asks its siblings and returns the first real answer. Peers come
from the HEADLESS Service ``pipecat-worker-peers``, whose DNS A records are
precisely the ready pods — no Kubernetes API, no RBAC, no service account.
(``dnsPolicy: ClusterFirstWithHostNet`` on the DaemonSet is what makes cluster
DNS reachable at all from these host-network pods.)

Every forwarded request carries ``x-aplisay-trickle-forwarded``, and a request
arriving with that header is never forwarded again. One hop, no loops, whatever
the cluster does with the next packet.

Set ``WEBRTC_PEER_HOST=""`` to disable forwarding entirely (single-replica
deploys, or local dev where there are no siblings to ask).
"""

from __future__ import annotations

import asyncio
import os
import socket
import time
from typing import Any, Optional

import httpx
from loguru import logger

#: Marks a request we generated. Its presence means "do not forward again".
FORWARDED_HEADER = "x-aplisay-trickle-forwarded"

_DEFAULT_HOST = "pipecat-worker-peers"

# (resolved_at_monotonic, ips). Module-level so a burst of candidates from one
# browser costs one DNS lookup rather than one per candidate.
_peer_cache: tuple[float, list[str]] = (0.0, [])


def _env(name: str, default: str) -> str:
    return os.environ.get(name, default).strip()


def reset_peer_cache() -> None:
    """Drop the resolved-peer cache (tests, and after a known topology change)."""
    global _peer_cache
    _peer_cache = (0.0, [])


async def peer_addresses() -> list[str]:
    """Ready sibling nodes, by IP, excluding ourselves.

    Resolution is cached for ``WEBRTC_PEER_DNS_TTL_S`` because a single browser
    emits a burst of candidates and each one would otherwise re-resolve.
    """
    global _peer_cache
    host = _env("WEBRTC_PEER_HOST", _DEFAULT_HOST)
    if not host:
        return []

    ttl = float(_env("WEBRTC_PEER_DNS_TTL_S", "10"))
    resolved_at, cached = _peer_cache
    now = time.monotonic()
    if cached and now - resolved_at < ttl:
        return cached

    port = int(_env("WEBRTC_PEER_PORT", "8082"))
    try:
        loop = asyncio.get_running_loop()
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except (OSError, ValueError) as e:
        # No siblings reachable is a degraded state, not a broken one: the
        # request still 404s exactly as it did before this module existed.
        logger.warning(f"trickle forward: cannot resolve peer service {host!r}: {e}")
        _peer_cache = (now, [])
        return []

    # hostNetwork pods advertise the node IP, which is also what podIP reports,
    # so this is a like-for-like comparison.
    mine = _env("PIPECAT_SELF_IP", "")
    ips = sorted({info[4][0] for info in infos} - {mine})
    _peer_cache = (now, ips)
    return ips


async def forward_to_owner(
    *,
    method: str,
    token: str,
    body: dict[str, Any],
    headers: Any,
) -> Optional[dict[str, Any]]:
    """Ask the siblings to service this request; return the owner's reply.

    ``None`` means nobody owned it (or there was nobody to ask), and the caller
    should raise its own 404 exactly as before.

    All peers are asked concurrently. Only the owner can act on the ``pc_id``;
    the rest 404 harmlessly, so a broadcast is idempotent and costs one small
    request per node.
    """
    if headers is not None and headers.get(FORWARDED_HEADER):
        return None                       # already a forward — never loop

    peers = await peer_addresses()
    if not peers:
        return None

    port = int(_env("WEBRTC_PEER_PORT", "8082"))
    timeout = float(_env("WEBRTC_PEER_TIMEOUT_S", "1.5"))

    async def ask(client: httpx.AsyncClient, ip: str) -> Optional[dict[str, Any]]:
        try:
            r = await client.request(
                method,
                f"http://{ip}:{port}/webrtc/offer",
                params={"token": token},
                json=body,
                headers={FORWARDED_HEADER: "1"},
            )
        except httpx.HTTPError as e:
            logger.warning(f"trickle forward to {ip} failed: {e}")
            return None
        if r.status_code == 404:
            return None                   # this node simply isn't the owner
        if r.status_code >= 400:
            logger.warning(f"trickle forward to {ip}: {r.status_code} {r.text[:200]}")
            return None
        try:
            return r.json()
        except ValueError:
            return {"status": "success"}

    async with httpx.AsyncClient(timeout=timeout) as client:
        results = await asyncio.gather(
            *(ask(client, ip) for ip in peers), return_exceptions=True
        )

    for ip, result in zip(peers, results):
        if isinstance(result, BaseException):
            logger.warning(f"trickle forward to {ip} raised: {result}")
            continue
        if result is not None:
            logger.info(f"{method} /webrtc/offer forwarded to the owning node {ip}")
            return result
    return None
