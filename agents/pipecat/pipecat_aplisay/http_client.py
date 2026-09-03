"""Process-wide pooled HTTP clients.

Every ``httpx.AsyncClient(...)`` constructed inside a request handler
builds a fresh ``ssl.SSLContext`` — a synchronous parse of the certifi
CA bundle, on the event loop, measured at ~5 ms here and 2–4x that on a
250m-CPU node — and then opens a connection that is thrown away when the
``async with`` exits.

That is affordable a handful of times per call. It is not affordable on
the transcript-streaming path: with ``instance.streamLog`` on, the
observer POSTs a row for every STT interim and every TTS/LLM text chunk,
10–30 times a second per call. Ten concurrent streaming calls put the
loop into permanent SSL-context construction, which every other call on
the node hears as output jitter. Kernel-side it is worse: each request
is a new connection, and a host-network node runs out of ephemeral ports
(28k / 60 s TIME_WAIT) at a few hundred connections a second, after which
every agent-db call fails — call setup, transfer authorisation, the lot.

So: one client per base URL for the life of the process, with a
connection pool and keep-alive. Per-request deadlines go on the request
(``client.request(..., timeout=...)``), never on the client, so a shared
client does not impose one call's timeout on another's.

Closed from the worker's lifespan shutdown via ``aclose_all()``.
"""

from __future__ import annotations

import asyncio
from typing import Dict

import httpx
from loguru import logger

# Pool sizing. max_connections bounds concurrent sockets to one host;
# 50 is comfortably above the busiest node's steady state (a few
# in-flight agent-db calls per live call) while staying well under any
# file-descriptor limit. Keep-alive connections are what actually removes
# the per-request handshake.
_LIMITS = httpx.Limits(max_connections=50, max_keepalive_connections=20)

# Fallback deadline for callers that pass none. Individual calls should
# still pass their own; this only stops a forgotten one hanging forever.
_DEFAULT_TIMEOUT = 30.0

_clients: Dict[str, httpx.AsyncClient] = {}
_lock = asyncio.Lock()


async def get_client(key: str = "default", *, base_url: str = "") -> httpx.AsyncClient:
    """Return the pooled client for ``key``, creating it on first use.

    ``key`` namespaces the pools (the agent-db API, the sipbridge REST
    surface, …) so they cannot exhaust each other's connection budget.
    """
    client = _clients.get(key)
    if client is not None and not client.is_closed:
        return client
    async with _lock:
        client = _clients.get(key)
        if client is not None and not client.is_closed:
            return client
        client = httpx.AsyncClient(
            base_url=base_url,
            limits=_LIMITS,
            timeout=_DEFAULT_TIMEOUT,
        )
        _clients[key] = client
        logger.bind(pool=key).debug("http: created shared client")
        return client


async def aclose_all() -> None:
    """Close every pooled client. Called from the worker's lifespan."""
    clients = list(_clients.items())
    _clients.clear()
    for key, client in clients:
        try:
            await client.aclose()
        except Exception as e:  # noqa: BLE001
            logger.bind(pool=key).warning(f"http: closing shared client failed: {e}")
