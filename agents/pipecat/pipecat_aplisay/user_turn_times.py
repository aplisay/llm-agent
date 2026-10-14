"""When the caller stopped speaking for the turn a ``user`` row carries.

During the call each final ``user`` row gets a best guess from
:class:`UserTurnClock`. On Ultravox the guess is reconciled just before the
call record ends, from Ultravox's own record of the call (each message's
``wallClockTimespan``), so batched rows and the end call hook carry the
reconciled time. Rows streamed during the call keep the provisional time on
the live socket. Mirrors the LiveKit worker's user-turn-clock.ts and
user-turn-corrections.ts.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timezone
from typing import Any, Optional

from loguru import logger

from .http_client import get_client

ULTRAVOX_API_BASE = "https://api.ultravox.ai/api"

#: How long after a reply or tool call starts its user transcript may still
#: arrive. Ultravox sends the caller's final transcript with its first output
#: (measured 0 to 0.7 s later); older reply starts belong to an earlier turn.
RESPONSE_TRANSCRIPT_WINDOW_S = 2.5

#: Slack for clock skew; Ultravox's clock and ours agreed to about 55 ms.
CORRECTION_SKEW_S = 0.25

#: Cap on fetching the call's messages; rows keep their guesses on timeout.
CORRECTION_TIMEOUT_S = 2.0

_CALL_ID_RE = re.compile(r"/calls/([0-9a-fA-F-]{36})/")


class UserTurnClock:
    """Every signal here comes after the caller stopped, so the earliest valid
    one is the closest. Times are wall-clock seconds (``time.time()``)."""

    def __init__(self) -> None:
        self._response_started_at: Optional[float] = None
        self._user_started_at: Optional[float] = None
        self._user_stopped_at: Optional[float] = None
        self._last_stamp = float("-inf")

    def note_response_started(self, at: Optional[float] = None) -> None:
        """The bot started speaking, or a function call started."""
        self._response_started_at = time.time() if at is None else at

    def note_user_started(self, at: Optional[float] = None) -> None:
        self._user_started_at = time.time() if at is None else at
        self._user_stopped_at = None

    def note_user_stopped(self, at: Optional[float] = None) -> None:
        # The VAD's stop (corrected by stop_secs) comes before the turn-level
        # stop for the same speech; keep the first since the caller last started.
        if self._user_stopped_at is None:
            self._user_stopped_at = time.time() if at is None else at

    def stamp(self, arrived_at: Optional[float] = None) -> datetime:
        arrived = time.time() if arrived_at is None else arrived_at
        candidates = []
        if self._user_stopped_at is not None:
            candidates.append(self._user_stopped_at)
        started = self._response_started_at
        if (
            started is not None
            and arrived - started <= RESPONSE_TRANSCRIPT_WINDOW_S
            and (self._user_started_at is None or started > self._user_started_at)
        ):
            candidates.append(started)
        valid = [t for t in candidates if self._last_stamp < t <= arrived]
        at = min(valid) if valid else arrived
        self._last_stamp = at
        self._response_started_at = None
        self._user_started_at = None
        self._user_stopped_at = None
        return datetime.fromtimestamp(at, timezone.utc)


def ultravox_call_id(join_url: str) -> Optional[str]:
    """The call id in an Ultravox join URL (``wss://…/calls/<id>/server_web_socket``)."""
    match = _CALL_ID_RE.search(join_url or "")
    return match.group(1) if match else None


def _normalise(text: str) -> str:
    lowered = (text or "").lower()
    return " ".join("".join(c if c.isalnum() else " " for c in lowered).split())


def _seconds(value: Any) -> Optional[float]:
    """Ultravox durations are decimal seconds with an ``s`` suffix, e.g. ``"12.07s"``."""
    if not isinstance(value, str) or not value.endswith("s"):
        return None
    try:
        return float(value[:-1])
    except ValueError:
        return None


def match_user_turn_ends(texts: list[str], messages: list[dict], joined: datetime) -> list[Optional[datetime]]:
    """For each row text, in order, the end of the Ultravox caller message with
    the same text, or None. Pairs in order, so repeated short replies line up."""
    users = [m for m in messages if m.get("role") == "MESSAGE_ROLE_USER" and isinstance(m.get("text"), str)]
    ends: list[Optional[datetime]] = []
    nxt = 0
    for text in texts:
        want = _normalise(text)
        found: Optional[datetime] = None
        if want:
            for i in range(nxt, len(users)):
                if _normalise(users[i]["text"]) != want:
                    continue
                nxt = i + 1
                end = _seconds((users[i].get("wallClockTimespan") or {}).get("end"))
                if end is not None:
                    found = datetime.fromtimestamp(joined.timestamp() + end, timezone.utc)
                break
        ends.append(found)
    return ends


async def fetch_ultravox_call(call_id: str, api_key: str) -> tuple[Optional[datetime], list[dict]]:
    """The call's ``joined`` time and its in-call messages."""
    client = await get_client("ultravox")
    headers = {"X-API-Key": api_key}
    resp = await client.get(f"{ULTRAVOX_API_BASE}/calls/{call_id}", headers=headers, timeout=CORRECTION_TIMEOUT_S)
    resp.raise_for_status()
    joined_raw = resp.json().get("joined")
    joined = datetime.fromisoformat(joined_raw.replace("Z", "+00:00")) if joined_raw else None
    messages: list[dict] = []
    url: Optional[str] = f"{ULTRAVOX_API_BASE}/calls/{call_id}/messages?mode=in_call&pageSize=200"
    for _ in range(20):
        if not url:
            break
        page = await client.get(url, headers=headers, timeout=CORRECTION_TIMEOUT_S)
        page.raise_for_status()
        body = page.json()
        messages.extend(body.get("results") or [])
        nxt = body.get("next")
        url = str(page.url.join(nxt)) if nxt else None
    return joined, messages


async def reconcile_user_rows(call: Any, rows: list[dict]) -> None:
    """Rewrite the batched entries, or queue corrections for the streamed rows,
    of ``call``'s tracked user rows from Ultravox's message timings. ``rows``
    are dicts with ``text``, ``guess``, ``ultravox_call_id``, ``api_key`` and
    either ``entry`` (batched) or ``id`` (streamed). Never raises."""
    by_call: dict[tuple[str, str], list[dict]] = {}
    for row in rows:
        if row.get("ultravox_call_id") and row.get("api_key"):
            by_call.setdefault((row["ultravox_call_id"], row["api_key"]), []).append(row)
    corrected = 0
    for (uv_call_id, api_key), uv_rows in by_call.items():
        try:
            joined, messages = await fetch_ultravox_call(uv_call_id, api_key)
        except Exception as e:  # noqa: BLE001
            logger.bind(call_id=call.id, ultravox_call_id=uv_call_id).warning(
                f"could not fetch Ultravox user turn timings: {e}"
            )
            continue
        if joined is None:
            continue
        ends = match_user_turn_ends([r["text"] for r in uv_rows], messages, joined)
        previous: Optional[datetime] = None
        for row, end in zip(uv_rows, ends):
            guess: datetime = row["guess"]
            at = guess
            if (
                end is not None
                and end.timestamp() <= guess.timestamp() + CORRECTION_SKEW_S
                and (previous is None or end > previous)
            ):
                at = end
            previous = at
            if at == guess:
                continue
            corrected += 1
            if row.get("entry") is not None:
                row["entry"]["createdAt"] = at
            elif row.get("id") is not None:
                call.transaction_log_corrections.append({"id": row["id"], "createdAt": at})
    logger.bind(call_id=call.id, rows=len(rows), corrected=corrected).debug("user turn times reconciled")
