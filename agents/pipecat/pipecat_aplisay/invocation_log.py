"""Invocation-log capture — the per-call "debug log" surfaced in the UI.

A loguru sink (installed by :func:`install_capture`) buffers every *call-scoped*
log record — one emitted while ``callId`` is bound into loguru's context via
``logger.contextualize(callId=...)`` in :class:`CallSession` — keyed by that
callId. At the end of each call segment the session drains its own entries and
POSTs them to ``POST /api/agent-db/invocation-log`` (see
:func:`flush_invocation_logs`), mirroring how the LiveKit agent persists an
InvocationLog at job shutdown (``agents/livekit/lib/voice-agent-runtime.ts``).

Only call-scoped records are buffered, so on a long-running worker the buffer
stays bounded to the logs of in-flight calls — idle/system logging is dropped
rather than accumulated forever.
"""

from __future__ import annotations

import os
import threading
from typing import Any

from loguru import logger

from . import api_client

# Process-wide, callId-tagged. Guarded by a threading.Lock: the loguru sink runs
# synchronously in whatever thread emitted the log (possibly a worker thread,
# e.g. ``asyncio.to_thread``), while flush runs on the event loop.
_BUFFER: list[dict[str, Any]] = []
_LOCK = threading.Lock()
_installed = False

# Soft cap so a pathologically long / verbose call can't grow the buffer without
# bound; when exceeded we drop the oldest entry (the server prunes anyway).
_MAX_ENTRIES = 20_000


# loguru level name -> pino numeric level. The Calls UI (polite-ai
# ``dashboard.calls.tsx`` / ``api.call-diagnostics.tsx``) was built for the
# LiveKit agent's pino logs, so it keys off pino fields: ``time`` (epoch ms —
# projected onto the recording timeline so the playhead follows each entry),
# numeric ``level`` (>=40 = warn/error) and ``msg``. pino ladder:
# trace10 debug20 info30 warn40 error50 fatal60.
_PINO_LEVELS = {
    "TRACE": 10,
    "DEBUG": 20,
    "INFO": 30,
    "SUCCESS": 30,
    "WARNING": 40,
    "ERROR": 50,
    "CRITICAL": 60,
}


def _record_to_entry(record: dict) -> dict[str, Any]:
    """Serialise a loguru record as a **pino-shaped** entry, so pipecat and
    LiveKit invocation logs render identically in the UI. ``time`` is epoch
    milliseconds via ``datetime.timestamp()`` — an absolute (UTC) instant
    regardless of the record's tzinfo, which is what the timeline maths expects.
    """
    extra = dict(record.get("extra") or {})
    call_id = extra.pop("callId", None)
    level_name = record["level"].name
    entry: dict[str, Any] = {
        "callId": call_id,  # internal: groups/drains per call (the UI ignores it)
        "time": int(record["time"].timestamp() * 1000),
        "level": _PINO_LEVELS.get(level_name.upper(), 30),
        "levelName": level_name,
        "msg": record["message"],
        "logger": record["name"],
        "function": record["function"],
        "line": record["line"],
    }
    if extra:
        entry["extra"] = extra
    exc = record.get("exception")
    if exc is not None:
        value = getattr(exc, "value", None)
        entry["err"] = {"message": str(value) if value is not None else repr(exc)}
    return entry


def _capture_sink(message) -> None:
    """loguru sink: buffer call-scoped records (those with a bound ``callId``)."""
    record = message.record
    if not (record.get("extra") or {}).get("callId"):
        return  # only capture logs emitted within a call's context
    try:
        entry = _record_to_entry(record)
    except Exception:  # noqa: BLE001 — logging must never raise
        return
    with _LOCK:
        _BUFFER.append(entry)
        if len(_BUFFER) > _MAX_ENTRIES:
            del _BUFFER[0]


def install_capture(level: str | None = None) -> None:
    """Register the buffering sink on the shared loguru logger (idempotent).

    Call once at worker startup, after all imports, so nothing later resets the
    handler set out from under us. Adds a handler; the existing stderr sink is
    left untouched, so console output is unchanged.
    """
    global _installed
    if _installed:
        return
    logger.add(
        _capture_sink,
        level=(level or os.environ.get("LOGLEVEL", "INFO")).upper(),
        enqueue=False,
        backtrace=False,
        diagnose=False,
    )
    _installed = True


def _drain(call_id: str | None) -> list[dict[str, Any]]:
    """Remove and return buffered entries — one call's, or all when ``call_id`` is None."""
    with _LOCK:
        if call_id is None:
            batch = list(_BUFFER)
            _BUFFER.clear()
            return batch
        keep: list[dict[str, Any]] = []
        batch: list[dict[str, Any]] = []
        for entry in _BUFFER:
            (batch if (entry.get("callId") or "system") == call_id else keep).append(entry)
        if batch:
            _BUFFER[:] = keep
        return batch


async def _post(
    call_id: str, entries: list[dict], user_id: str, org_id: str, subsystem: str
) -> None:
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


async def flush_invocation_logs(
    call_id: str | None = None,
    user_id: str | None = None,
    org_id: str | None = None,
    subsystem: str = "pipecat-agent",
) -> None:
    """Drain buffered logs and POST them to llm-agent.

    With ``call_id`` (the per-call path — ``CallSession`` at segment end): drain
    only that call's entries and attribute them to the call's own ``user_id`` /
    ``org_id``. Without ``call_id`` (the shutdown safety net): drain everything,
    grouped by callId, falling back to the worker's env identity for stragglers.
    """
    batch = _drain(call_id)
    if not batch:
        return

    if call_id is not None:
        await _post(
            call_id,
            batch,
            user_id or os.environ.get("WORKER_USER_ID", ""),
            org_id or os.environ.get("WORKER_ORGANISATION_ID", ""),
            subsystem,
        )
        return

    env_user = os.environ.get("WORKER_USER_ID", "")
    env_org = os.environ.get("WORKER_ORGANISATION_ID", "")
    by_call: dict[str, list[dict]] = {}
    for entry in batch:
        by_call.setdefault(entry.get("callId") or "system", []).append(entry)
    for cid, entries in by_call.items():
        await _post(cid, entries, env_user, env_org, subsystem)
