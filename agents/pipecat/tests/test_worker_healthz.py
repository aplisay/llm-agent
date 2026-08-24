"""Tests for the worker's /healthz handler.

A bare TCP probe cannot see the worker's proven silent-failure mode: under
thread-spawn exhaustion, aiortc's per-received-track decoder thread fails to
start AFTER the sender is already up, so every new call carries outbound audio
while all inbound RTP is silently discarded (the receiver never registers with
the RTP router) — and HTTP keeps serving throughout. What is pinned here is
that /healthz goes 503 the moment threads cannot start, that runaway
session/peer-registry growth trips the watermarks, and that a healthy idle
process reports 200 with its counts.
"""

from __future__ import annotations

import asyncio
import json

import pytest

from pipecat_aplisay import worker


class _State:
    def __init__(self, live=None, peers=None):
        self.live_calls = live or {}
        self.webrtc_connections = peers or {}


class _App:
    def __init__(self, state):
        self.state = state


class _Request:
    def __init__(self, state):
        self.app = _App(state)


def _run(state):
    resp = asyncio.get_event_loop().run_until_complete(worker.healthz(_Request(state)))
    return resp.status_code, json.loads(resp.body)


@pytest.fixture()
def loop():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    yield loop
    loop.close()


def test_healthy_idle_process_reports_ok(loop):
    status, body = _run(_State())
    assert status == 200
    assert body["ok"] is True
    assert body["problems"] == []
    assert body["live_calls"] == 0
    assert body["webrtc_connections"] == 0
    assert body["threads"] >= 1


def test_peer_registry_runaway_trips_the_watermark(loop):
    peers = {f"pc-{i}": object() for i in range(worker.HEALTHZ_MAX_SESSIONS + 1)}
    status, body = _run(_State(peers=peers))
    assert status == 503
    assert body["ok"] is False
    assert any("webrtc_connections" in p for p in body["problems"])


def test_live_calls_runaway_trips_the_watermark(loop):
    live = {f"call-{i}": object() for i in range(worker.HEALTHZ_MAX_SESSIONS + 1)}
    status, body = _run(_State(live=live))
    assert status == 503
    assert any("live_calls" in p for p in body["problems"])


def test_thread_spawn_failure_is_a_hard_503(loop, monkeypatch):
    """The decisive canary: ``can't start new thread`` must flip the probe."""

    class _DeadThread:
        def __init__(self, *a, **k):
            pass

        def start(self):
            raise RuntimeError("can't start new thread")

    monkeypatch.setattr(worker.threading, "Thread", _DeadThread)
    status, body = _run(_State())
    assert status == 503
    assert any("cannot start threads" in p for p in body["problems"])
