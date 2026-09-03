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
import sys
import threading
from collections import deque
from typing import Any

from loguru import logger

from . import api_client

# Per-call buffers, keyed by callId. Guarded by a threading.Lock: the loguru
# sink runs synchronously in whatever thread emitted the log (possibly a worker
# thread, e.g. ``asyncio.to_thread``), while flush runs on the event loop.
#
# This used to be ONE process-wide list with a shared 20 000-entry cap and
# oldest-first eviction across the whole process (P1). On a busy node — tens of
# concurrent calls, a few hundred records a minute each, plus every pipecat line
# emitted while a callId is bound — that saturated within minutes, and what got
# evicted was the OLDEST entries of the still-running long calls: their setup and
# connect lines, which are exactly the ones you need when diagnosing a silent
# leg. Per-call deques give each call its own budget, make eviction a property of
# that call's own verbosity, and turn the drain from an O(N) rebuild under the
# lock (taken by every log call in every thread) into a dict pop.
_BUFFERS: dict[str, deque] = {}
_LOCK = threading.Lock()
_installed = False

# Per-call cap. A call that talks for an hour at INFO produces a few thousand
# records; 4 000 leaves headroom for a verbose one without letting any single
# call dominate. deque(maxlen=...) evicts oldest-first on append, within that
# call only.
_MAX_ENTRIES_PER_CALL = 4_000

# Ceiling on how many calls' buffers we hold. Every buffer is normally dropped
# by its own call's flush; this only bounds the pathological case where a call
# ends without one (a hard crash between segments). At the cap the
# least-recently-written call is dropped whole.
_MAX_CALLS = 500

# How many call buffers have been dropped un-flushed. Non-zero means
# calls are ending without their invocation log being persisted, which is
# worth knowing about; the sink cannot log it itself (see _capture_sink).
_dropped_call_buffers = 0


def dropped_call_buffers() -> int:
    """Count of call buffers evicted before they were ever flushed."""
    return _dropped_call_buffers


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
    key = entry.get("callId") or "system"
    evicted: str | None = None
    with _LOCK:
        buf = _BUFFERS.get(key)
        if buf is None:
            if len(_BUFFERS) >= _MAX_CALLS:
                # Insertion-ordered dict: the first key is the least
                # recently created buffer. Only reachable if calls are
                # ending without flushing.
                evicted = next(iter(_BUFFERS))
                del _BUFFERS[evicted]
            buf = _BUFFERS[key] = deque(maxlen=_MAX_ENTRIES_PER_CALL)
        buf.append(entry)
    # NOT ``logger`` — we are inside a loguru sink, and loguru is not
    # re-entrant: any log emitted from here trips its "deadlock avoided"
    # guard, which raises out of the sink, loses the message and turns
    # every eviction into a handler error on stderr. Moving it out of
    # the lock does not help; the guard is on the loguru handler, not on
    # our buffer. So: a counter (reported by ``dropped_call_buffers``)
    # plus a direct stderr line, neither of which re-enters logging.
    if evicted is not None:
        global _dropped_call_buffers
        _dropped_call_buffers += 1
        try:
            print(
                f"invocation log: dropped buffered records for {evicted} — "
                f"more than {_MAX_CALLS} unflushed calls",
                file=sys.stderr,
            )
        except Exception:  # noqa: BLE001 — logging must never raise
            pass


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
            batch: list[dict[str, Any]] = []
            for buf in _BUFFERS.values():
                batch.extend(buf)
            _BUFFERS.clear()
            return batch
        buf = _BUFFERS.pop(call_id, None)
        return list(buf) if buf else []


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
