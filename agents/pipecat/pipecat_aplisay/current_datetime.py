"""The call's "current date/time" for the ``metadata`` builtin (get_metadata).

Python twin of ``lib/current-datetime.js`` — keep the format identical so
``aplisay.dateTime`` reads the same across the node/livekit and pipecat workers.

Voice/text models have no clock: on a 2026-07-24 staging call an Ultravox agent
called ``calendar_list_events`` with a 2025-06-18 range (over a year in the
past). Exposing the current date/time under the metadata key ``aplisay.dateTime``
gives an agent that reasons about dates ("today", "next Tuesday", calendar
ranges) ground truth via ``get_metadata(["aplisay.dateTime"])``. Computed live at
call time (not seeded) so it is always current and needs no change to the
scattered call-metadata composition sites. Timezone defaults to Europe/London,
overridable per-deployment with ``AGENT_TIMEZONE``.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

_DATETIME_KEY_RE = re.compile(r"^(aplisay\.)?date_?time$", re.IGNORECASE)


def is_datetime_metadata_key(key: object) -> bool:
    """True for the metadata keys that resolve to the live current date/time."""
    return isinstance(key, str) and bool(_DATETIME_KEY_RE.match(key.strip()))


def agent_timezone() -> str:
    """IANA timezone the date/time is rendered in (AGENT_TIMEZONE, else Europe/London)."""
    return (os.environ.get("AGENT_TIMEZONE") or "").strip() or "Europe/London"


def current_datetime_string(now: datetime | None = None, tz: str | None = None) -> str:
    """A human- and model-readable current date/time, e.g.
    ``Thursday 2026-07-24 14:05 Europe/London``: weekday (for "next Tuesday"
    reasoning), ISO-8601 date (usable directly in calendar ranges), 24h local
    time and zone. ``now``/``tz`` are injectable for tests.
    """
    zone_name = tz or agent_timezone()
    try:
        zone = ZoneInfo(zone_name)
    except (ZoneInfoNotFoundError, ValueError, OSError):
        # Invalid AGENT_TIMEZONE — fall back to UTC rather than raising mid-call.
        zone_name, zone = "UTC", timezone.utc
    moment = (now or datetime.now(timezone.utc)).astimezone(zone)
    return f"{moment:%A} {moment:%Y-%m-%d} {moment:%H:%M} {zone_name}"
