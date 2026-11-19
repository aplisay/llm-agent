"""A browser that vanishes ends its call after the limit; a live or reconnecting one never does."""

from __future__ import annotations

import asyncio
import base64
import datetime
import hashlib
import hmac
import json
import time
from types import SimpleNamespace

import pytest
from aiortc.stats import RTCInboundRtpStreamStats, RTCStatsReport, RTCTransportStats

from pipecat_aplisay import api_client, call_session, webrtc_client_watch, worker
from pipecat_aplisay.webrtc_client_watch import (
    close_when_client_gone,
    packets_received,
    watch_client_gone,
)

LIMIT = 20.0


def _report(transport_packets: int | None, rtp_packets: int = 0) -> RTCStatsReport:
    """A stats report built from aiortc's own classes, so a renamed field fails here."""
    at = datetime.datetime.now(datetime.UTC)
    report = RTCStatsReport()
    report.add(
        RTCInboundRtpStreamStats(
            timestamp=at,
            type="inbound-rtp",
            id="inbound-rtp_1",
            ssrc=1,
            kind="audio",
            transportId="transport_1",
            packetsReceived=rtp_packets,
            packetsLost=0,
            jitter=0,
        )
    )
    if transport_packets is not None:
        report.add(
            RTCTransportStats(
                timestamp=at,
                type="transport",
                id="transport_1",
                packetsSent=0,
                packetsReceived=transport_packets,
                bytesSent=0,
                bytesReceived=0,
                iceRole="controlled",
                dtlsState="connected",
            )
        )
    return report


class _Connection:
    """Stands in for SmallWebRTCConnection: only what the watch reads."""

    def __init__(self) -> None:
        self.pinging = True
        self.packets: int | None = 0
        self.stats_fail = False
        self.disconnects = 0
        self.pc = SimpleNamespace(connectionState="connected", getStats=self._get_stats)

    def is_connected(self) -> bool:
        return self.pinging

    async def _get_stats(self) -> RTCStatsReport:
        if self.stats_fail:
            raise RuntimeError("no stats")
        return _report(self.packets)

    async def disconnect(self) -> None:
        self.disconnects += 1


class _Horizon(Exception):
    """The fake clock ran past the end of the test."""


class _Clock:
    """Time that only moves when the watch sleeps. ``at`` maps a time to a change."""

    def __init__(self, horizon: float) -> None:
        self.t = 0.0
        self.horizon = horizon
        self.at: dict[float, object] = {}
        self.every_tick = None

    def now(self) -> float:
        return self.t

    async def sleep(self, secs: float) -> None:
        self.t += secs
        for due in sorted(k for k in self.at if k <= self.t):
            self.at.pop(due)()
        if self.every_tick:
            self.every_tick(self.t)
        if self.t > self.horizon:
            raise _Horizon()


def _watch(conn: _Connection, clock: _Clock) -> None:
    asyncio.run(watch_client_gone(conn, LIMIT, sleep=clock.sleep, now=clock.now))


def _stop_pings(conn: _Connection, clock: _Clock, last_ping_at: float) -> None:
    clock.at[last_ping_at + webrtc_client_watch.PING_STALE_SECS] = lambda: setattr(
        conn, "pinging", False
    )


class TestWatch:
    def test_ends_the_limit_after_the_last_ping(self) -> None:
        conn, clock = _Connection(), _Clock(horizon=200)
        _stop_pings(conn, clock, last_ping_at=10)
        _watch(conn, clock)
        assert clock.t == 10 + LIMIT

    def test_a_client_that_never_stops_pinging_is_left_alone(self) -> None:
        conn, clock = _Connection(), _Clock(horizon=600)
        with pytest.raises(_Horizon):
            _watch(conn, clock)

    def test_not_armed_before_the_pipeline_connects(self) -> None:
        # is_connected() is false until the transport calls connect(), while
        # aiortc may already report "connected".
        conn, clock = _Connection(), _Clock(horizon=600)
        conn.pinging = False
        with pytest.raises(_Horizon):
            _watch(conn, clock)

    def test_packets_keep_a_silent_client_alive(self) -> None:
        conn, clock = _Connection(), _Clock(horizon=600)
        _stop_pings(conn, clock, last_ping_at=10)
        media_until = 100

        def media(t: float) -> None:
            if t <= media_until:
                conn.packets = int(t * 50)

        clock.every_tick = media
        _watch(conn, clock)
        assert media_until + LIMIT <= clock.t <= media_until + 2 * LIMIT

    def test_a_reconnect_starts_the_count_again(self) -> None:
        conn, clock = _Connection(), _Clock(horizon=600)
        _stop_pings(conn, clock, last_ping_at=10)
        # restart_pc: a new peer is still connecting when the limit passes, then pings again.
        clock.at[25] = lambda: setattr(conn.pc, "connectionState", "connecting")

        def reconnected() -> None:
            conn.pc.connectionState = "connected"
            conn.pinging = True

        clock.at[35] = reconnected
        _stop_pings(conn, clock, last_ping_at=50)
        _watch(conn, clock)
        assert clock.t == 50 + LIMIT

    def test_a_closed_peer_is_not_closed_again(self) -> None:
        conn, clock = _Connection(), _Clock(horizon=600)
        _stop_pings(conn, clock, last_ping_at=10)
        clock.at[15] = lambda: setattr(conn.pc, "connectionState", "closed")
        with pytest.raises(_Horizon):
            _watch(conn, clock)

    def test_unreadable_stats_leave_the_call_alone(self) -> None:
        conn, clock = _Connection(), _Clock(horizon=600)
        conn.stats_fail = True
        _stop_pings(conn, clock, last_ping_at=10)
        with pytest.raises(_Horizon):
            _watch(conn, clock)


class TestPacketsReceived:
    def test_counts_the_transport_not_the_rtp_stream(self) -> None:
        # The RTP stream count stops while pipecat has the receiver disabled.
        conn = SimpleNamespace(pc=SimpleNamespace(getStats=None))

        async def get_stats() -> RTCStatsReport:
            return _report(transport_packets=7, rtp_packets=3)

        conn.pc.getStats = get_stats
        assert asyncio.run(packets_received(conn)) == 7

    def test_no_transport_entry_is_unknown(self) -> None:
        async def get_stats() -> RTCStatsReport:
            return _report(transport_packets=None)

        conn = SimpleNamespace(pc=SimpleNamespace(getStats=get_stats))
        assert asyncio.run(packets_received(conn)) is None


class TestCloseWhenGone:
    def test_marks_fired_then_closes_the_peer(self, monkeypatch: pytest.MonkeyPatch) -> None:
        conn = _Connection()
        seen: list[bool] = []

        async def gone(_connection, _limit) -> None:
            return None

        async def disconnect() -> None:
            seen.append(fired.is_set())

        monkeypatch.setattr(webrtc_client_watch, "watch_client_gone", gone)
        conn.disconnect = disconnect  # type: ignore[method-assign]
        fired = asyncio.Event()
        asyncio.run(close_when_client_gone(conn, LIMIT, fired, "call-1"))
        assert seen == [True]

    def test_a_failing_watch_does_not_raise(self, monkeypatch: pytest.MonkeyPatch) -> None:
        async def broken(_connection, _limit) -> None:
            raise RuntimeError("boom")

        monkeypatch.setattr(webrtc_client_watch, "watch_client_gone", broken)
        conn, fired = _Connection(), asyncio.Event()
        asyncio.run(close_when_client_gone(conn, LIMIT, fired, "call-1"))
        assert not fired.is_set()
        assert conn.disconnects == 0


# ---- /webrtc/offer wiring ----

SECRET = "0123456789abcdef0123456789abcdef"
INSTANCE_ID = "inst-1"


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def _join_token() -> str:
    payload = {
        "instanceId": INSTANCE_ID,
        "sessionId": f"join-{INSTANCE_ID}-1",
        "expiresAt": int(time.time()) + 300,
    }
    raw = json.dumps(payload).encode()
    return f"{_b64(raw)}.{_b64(hmac.new(SECRET.encode(), raw, hashlib.sha256).digest())}"


class _Request:
    def __init__(self) -> None:
        self.query_params = {"token": _join_token()}
        self.headers: dict = {}
        self.app = SimpleNamespace(
            state=SimpleNamespace(live_calls={}, webrtc_connections={}, tasks=set(), sip_gateway=None)
        )

    async def json(self) -> dict:
        return {"sdp": "v=0", "type": "offer"}


class _Peer:
    """The connection /webrtc/offer builds. The first disconnect() waits to be released."""

    last: _Peer

    def __init__(self, **_kwargs) -> None:
        _Peer.last = self
        self.pc_id = "pc-1"
        self.release = asyncio.Event()
        self.disconnects: list[str] = []

    async def initialize(self, *_args) -> None:
        pass

    def get_answer(self) -> dict:
        return {"sdp": "v=0", "type": "answer", "pc_id": self.pc_id}

    def event_handler(self, _name: str):
        return lambda fn: fn

    async def disconnect(self) -> None:
        first = not self.disconnects
        self.disconnects.append("started")
        if first:
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.disconnects[0] = "cancelled"
                raise
            self.disconnects[0] = "finished"


class _Task:
    def __init__(self) -> None:
        self.handlers: dict = {}

    def event_handler(self, name: str):
        def register(fn):
            self.handlers[name] = fn
            return fn

        return register


class _Session:
    """CallSession for one browser call: runs until the test ends it."""

    last: _Session

    def __init__(self, **kwargs) -> None:
        _Session.last = self
        self.call = kwargs["call"]
        self.gateway_session = kwargs["gateway_session"]
        self.ended = asyncio.Event()

    async def prepare_run(self, *_args):
        return _Task(), None

    async def run_prepared(self, task: _Task, _max_secs) -> None:
        await task.handlers["on_pipeline_started"]()
        await self.ended.wait()


@pytest.fixture
def offer(monkeypatch: pytest.MonkeyPatch):
    """Start a browser call through /webrtc/offer with a watch the test controls."""
    monkeypatch.setenv("PIPECAT_JOIN_SECRET", SECRET)
    watch = SimpleNamespace(gone=None, started=0, cancelled=0)

    async def get_instance_by_id(_instance_id):
        return {
            "id": INSTANCE_ID,
            "metadata": None,
            "Agent": {
                "id": "agent-1",
                "userId": "user-1",
                "organisationId": "org-1",
                "modelName": "pipecat:test-model",
            },
        }

    async def create_call(_body):
        return SimpleNamespace(id="call-1")

    async def noop(*_args, **_kwargs) -> None:
        return None

    async def fake_watch(_connection, _limit) -> None:
        watch.started += 1
        try:
            await watch.gone.wait()
        except asyncio.CancelledError:
            watch.cancelled += 1
            raise

    monkeypatch.setattr(api_client, "get_instance_by_id", get_instance_by_id)
    monkeypatch.setattr(api_client, "create_call", create_call)
    monkeypatch.setattr(api_client, "start_call", noop)
    monkeypatch.setattr(api_client, "end_call", noop)
    monkeypatch.setattr(worker, "SmallWebRTCConnection", _Peer)
    monkeypatch.setattr(worker, "SmallWebRTCTransport", lambda **_kwargs: object())
    monkeypatch.setattr(call_session, "CallSession", _Session)
    monkeypatch.setattr(webrtc_client_watch, "watch_client_gone", fake_watch)

    async def start():
        watch.gone = asyncio.Event()
        request = _Request()
        await worker.webrtc_offer(request)
        await asyncio.sleep(0)
        return request, watch

    return start


async def _settle(request: _Request) -> None:
    tasks = list(request.app.state.tasks)
    if tasks:
        await asyncio.wait(tasks, timeout=5)
    assert not request.app.state.tasks


class TestOfferWiring:
    def test_the_watch_is_cancelled_when_the_call_ends_first(self, offer) -> None:
        async def run() -> None:
            request, watch = await offer()
            assert watch.started == 1
            _Peer.last.release.set()
            _Session.last.ended.set()
            await _settle(request)
            assert watch.cancelled == 1

        asyncio.run(run())

    def test_a_gone_client_closes_the_peer_and_the_close_is_not_cancelled(self, offer) -> None:
        async def run() -> None:
            request, watch = await offer()
            watch.gone.set()
            await asyncio.sleep(0.01)
            peer = _Peer.last
            assert peer.disconnects == ["started"]
            # The call unwinds while the watch is still inside disconnect().
            _Session.last.ended.set()
            await asyncio.sleep(0.01)
            assert peer.disconnects[0] == "started"
            peer.release.set()
            await _settle(request)
            assert peer.disconnects[0] == "finished"

        asyncio.run(run())

    def test_zero_turns_the_watch_off(self, offer, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(worker, "WEBRTC_CLIENT_GONE_SECS", 0.0)

        async def run() -> None:
            request, watch = await offer()
            assert watch.started == 0
            _Peer.last.release.set()
            _Session.last.ended.set()
            await _settle(request)

        asyncio.run(run())
