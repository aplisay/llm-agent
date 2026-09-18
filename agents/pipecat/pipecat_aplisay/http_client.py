"""Reuse clients to avoid synchronous TLS setup and connection churn on streaming paths; keep deadlines per request.
Close pools at worker shutdown with aclose_all(); see PR #285."""

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
