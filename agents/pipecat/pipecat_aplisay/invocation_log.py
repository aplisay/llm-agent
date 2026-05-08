"""Invocation-log buffer — section 9.3 of docs/livekit-agent-architecture.md.

Buffer is process-wide, callId-tagged. The contract is structured logging with a
flush at shutdown via ``POST /api/agent-db/invocation-log``. Specific log shapes
are implementation choice — we use loguru entries serialised as dicts.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from loguru import logger

from . import api_client

_BUFFER: list[dict[str, Any]] = []
_LOCK = asyncio.Lock()


async def append(entry: dict[str, Any]) -> None:
    async with _LOCK:
        _BUFFER.append(entry)


async def flush_invocation_logs(subsystem: str = "worker") -> None:
    """Drain the buffer and POST it to llm-agent."""
    async with _LOCK:
        batch = list(_BUFFER)
        _BUFFER.clear()

    if not batch:
        return

    user_id = os.environ.get("WORKER_USER_ID", "")
    org_id = os.environ.get("WORKER_ORGANISATION_ID", "")

    by_call: dict[str, list[dict]] = {}
    for entry in batch:
        call_id = entry.get("callId") or "system"
        by_call.setdefault(call_id, []).append(entry)

    for call_id, entries in by_call.items():
        try:
            await api_client.save_invocation_log(
                {
                    "userId": user_id,
                    "organisationId": org_id,
                    "callId": call_id,
                    "subsystem": subsystem,
                    "log": entries,
                }
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"invocation log POST failed for {call_id}: {e}")
