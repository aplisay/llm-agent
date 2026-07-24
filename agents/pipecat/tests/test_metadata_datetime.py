"""Live `aplisay.dateTime` from the pipecat `metadata` builtin + its helper.

Ground-truth date for date-reasoning agents (2026-07-24 incident: an Ultravox
agent called calendar_list_events with a 2025-06-18 range). Mirrors the node
guard in tests/function-handler-metadata.test.mjs so the two workers stay in
lockstep.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

from pipecat_aplisay.current_datetime import (
    current_datetime_string,
    is_datetime_metadata_key,
)
from pipecat_aplisay.function_handler import _builtin_metadata

_FORMAT = re.compile(r"^[A-Za-z]+ \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+$")


def test_helper_format_and_timezone():
    fixed = datetime(2026, 7, 24, 13, 5, tzinfo=timezone.utc)
    # 13:05 UTC is 14:05 BST in London on 2026-07-24.
    assert current_datetime_string(fixed, "Europe/London") == "Friday 2026-07-24 14:05 Europe/London"
    assert current_datetime_string(fixed, "UTC") == "Friday 2026-07-24 13:05 UTC"
    # An invalid zone falls back to UTC instead of raising mid-call.
    assert current_datetime_string(fixed, "Not/AZone").endswith("UTC")
    assert _FORMAT.match(current_datetime_string())


def test_key_matcher():
    assert is_datetime_metadata_key("aplisay.dateTime")
    assert is_datetime_metadata_key("dateTime")
    assert is_datetime_metadata_key("date_time")
    assert not is_datetime_metadata_key("aplisay.callerId")
    assert not is_datetime_metadata_key(None)


def test_builtin_returns_live_datetime_alongside_seeded_keys():
    metadata = {"aplisay": {"callerId": "+441632960001"}}
    out = _builtin_metadata({"keys": ["aplisay.callerId", "aplisay.dateTime"]}, metadata, {})
    assert out["aplisay.callerId"] == "+441632960001"
    assert _FORMAT.match(out["aplisay.dateTime"])
    assert out["aplisay.dateTime"] != "unknown"


def test_seeded_datetime_wins_over_computed():
    metadata = {"aplisay": {"dateTime": "Monday 2020-01-06 09:00 Europe/London"}}
    out = _builtin_metadata({"keys": ["dateTime", "aplisay.dateTime"]}, metadata, {})
    # bare `dateTime` (unseeded) is computed live…
    assert _FORMAT.match(out["dateTime"])
    # …a genuinely seeded `aplisay.dateTime` passes through untouched.
    assert out["aplisay.dateTime"] == "Monday 2020-01-06 09:00 Europe/London"


def test_toolscalls_guard_does_not_choke_on_a_non_string_key():
    # The toolsCalls guard now checks isinstance(key, str) first, so a non-string
    # key (e.g. keys=[None]) no longer raises AttributeError on .startswith.
    out = _builtin_metadata({"keys": [None]}, {"aplisay": {}}, {})
    assert None in out  # returned without raising
