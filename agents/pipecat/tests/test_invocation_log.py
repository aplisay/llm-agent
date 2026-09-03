"""Tests for invocation-log capture (loguru sink) + per-call flush."""

from __future__ import annotations

import asyncio
import datetime as dt
import types

import pytest

from pipecat_aplisay import invocation_log


def _msg(call_id, message="hi", level="INFO"):
    """A stand-in for a loguru Message (only ``.record`` is used by the sink)."""
    record = {
        "extra": {"callId": call_id} if call_id else {},
        "time": dt.datetime(2026, 7, 9, 0, 0, 0),
        "level": types.SimpleNamespace(name=level),
        "name": "pipecat_aplisay.test",
        "function": "f",
        "line": 1,
        "message": message,
        "exception": None,
    }
    return types.SimpleNamespace(record=record)


@pytest.fixture(autouse=True)
def _clear_buffer():
    with invocation_log._LOCK:
        invocation_log._BUFFERS.clear()
    yield
    with invocation_log._LOCK:
        invocation_log._BUFFERS.clear()


def _buffered() -> list:
    """Every buffered entry, in per-call insertion order."""
    return [e for buf in invocation_log._BUFFERS.values() for e in buf]


def test_sink_buffers_only_call_scoped():
    invocation_log._capture_sink(_msg("call-A", "a1"))
    invocation_log._capture_sink(_msg(None, "orphan"))  # no callId -> dropped
    invocation_log._capture_sink(_msg("call-A", "a2"))
    invocation_log._capture_sink(_msg("call-B", "b1"))
    assert [e["callId"] for e in _buffered()] == ["call-A", "call-A", "call-B"]


def test_entries_are_pino_shaped():
    invocation_log._capture_sink(_msg("call-A", "hello", level="WARNING"))
    e = _buffered()[0]
    assert isinstance(e["time"], int)  # epoch ms, for the UI timeline/playhead
    assert e["level"] == 40  # pino numeric: WARNING -> 40 (>=40 = notable)
    assert e["msg"] == "hello"
    assert e["levelName"] == "WARNING"


def test_flush_drains_only_that_call(monkeypatch):
    posted = []

    async def fake_save(payload):
        posted.append(payload)

    monkeypatch.setattr(invocation_log.api_client, "save_invocation_log", fake_save)
    for m in (_msg("call-A", "a1"), _msg("call-B", "b1"), _msg("call-A", "a2")):
        invocation_log._capture_sink(m)

    asyncio.run(
        invocation_log.flush_invocation_logs(call_id="call-A", user_id="U", org_id="O")
    )

    assert len(posted) == 1
    p = posted[0]
    assert p["callId"] == "call-A"
    assert p["userId"] == "U" and p["organisationId"] == "O"
    assert p["subsystem"] == "pipecat-agent"
    assert [e["msg"] for e in p["log"]] == ["a1", "a2"]
    # call-B's entry survives for its own flush
    assert [e["callId"] for e in _buffered()] == ["call-B"]


def test_flush_noop_when_no_entries_for_call(monkeypatch):
    posted = []

    async def fake_save(payload):
        posted.append(payload)

    monkeypatch.setattr(invocation_log.api_client, "save_invocation_log", fake_save)
    asyncio.run(
        invocation_log.flush_invocation_logs(call_id="absent", user_id="U", org_id="O")
    )
    assert posted == []


def test_shutdown_flush_groups_by_call(monkeypatch):
    posted = []

    async def fake_save(payload):
        posted.append(payload)

    monkeypatch.setattr(invocation_log.api_client, "save_invocation_log", fake_save)
    monkeypatch.setenv("WORKER_USER_ID", "envU")
    monkeypatch.setenv("WORKER_ORGANISATION_ID", "envO")
    for m in (_msg("call-A", "a1"), _msg("call-B", "b1"), _msg("call-A", "a2")):
        invocation_log._capture_sink(m)

    asyncio.run(invocation_log.flush_invocation_logs())  # no call_id -> drain all

    by_call = {p["callId"]: p for p in posted}
    assert set(by_call) == {"call-A", "call-B"}
    assert by_call["call-A"]["userId"] == "envU"
    assert [e["msg"] for e in by_call["call-A"]["log"]] == ["a1", "a2"]
    assert _buffered() == []


def test_max_entries_cap(monkeypatch):
    monkeypatch.setattr(invocation_log, "_MAX_ENTRIES_PER_CALL", 3)
    for i in range(5):
        invocation_log._capture_sink(_msg("call-A", f"m{i}"))
    # oldest dropped, newest kept
    assert [e["msg"] for e in _buffered()] == ["m2", "m3", "m4"]


def test_one_calls_verbosity_cannot_evict_another_calls_records():
    """The cap is per call, not process-wide.

    With one shared buffer, a busy node's chatty calls evicted the OLDEST
    entries across the whole process — which were the setup and connect
    lines of the still-running long calls, exactly the records needed to
    diagnose a silent leg.
    """
    invocation_log._MAX_ENTRIES_PER_CALL  # documents the knob under test
    invocation_log._capture_sink(_msg("quiet-call", "the-line-that-matters"))
    for i in range(invocation_log._MAX_ENTRIES_PER_CALL + 50):
        invocation_log._capture_sink(_msg("chatty-call", f"noise{i}"))

    quiet = list(invocation_log._BUFFERS["quiet-call"])
    assert [e["msg"] for e in quiet] == ["the-line-that-matters"]
    # and the chatty call is capped on its own budget
    assert (
        len(invocation_log._BUFFERS["chatty-call"])
        == invocation_log._MAX_ENTRIES_PER_CALL
    )


def test_unflushed_call_buffers_are_bounded(monkeypatch):
    """Buffers are normally dropped by their own call's flush; the call
    ceiling only bounds calls that end without one."""
    monkeypatch.setattr(invocation_log, "_MAX_CALLS", 3)
    for i in range(6):
        invocation_log._capture_sink(_msg(f"call-{i}", "x"))
    assert len(invocation_log._BUFFERS) <= 3
    # the most recent calls are the ones kept
    assert "call-5" in invocation_log._BUFFERS


def test_drain_removes_only_that_calls_buffer():
    invocation_log._capture_sink(_msg("call-A", "a1"))
    invocation_log._capture_sink(_msg("call-B", "b1"))
    assert [e["msg"] for e in invocation_log._drain("call-A")] == ["a1"]
    assert "call-A" not in invocation_log._BUFFERS
    assert [e["msg"] for e in invocation_log._BUFFERS["call-B"]] == ["b1"]
