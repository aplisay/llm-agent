"""A WebRTC signalling request finds the node that owns the peer.

Background: the SDP offer is stateless and any node answers it, but the aiortc
peer it creates lives on ONE node. Trickle candidates and renegotiation are
load-balanced independently of that offer, so on staging five of six sessions
had every candidate 404'd on the wrong node. Load-balancer stickiness cannot fix
it (see the module docstring), so the worker asks its siblings instead.

What these tests pin is the part that can go badly wrong: exactly one hop, never
a loop; a peer that is down or slow must not take the batch with it; and a
request that nobody owns must still 404 exactly as it did before.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import httpx
import pytest

from pipecat_aplisay import webrtc_peers
from pipecat_aplisay.webrtc_peers import (
    FORWARDED_HEADER,
    forward_to_owner,
    peer_addresses,
    reset_peer_cache,
)


@pytest.fixture(autouse=True)
def _clean(monkeypatch: pytest.MonkeyPatch) -> None:
    reset_peer_cache()
    monkeypatch.setenv("WEBRTC_PEER_HOST", "peers.test")
    monkeypatch.delenv("PIPECAT_SELF_IP", raising=False)
    yield
    reset_peer_cache()


class _Resolver:
    """Stands in for the event loop's getaddrinfo, and counts lookups."""

    def __init__(self, ips: list[str]) -> None:
        self.ips = ips
        self.calls = 0

    def install(self) -> None:
        loop = asyncio.get_running_loop()

        async def getaddrinfo(host, port, **kw):  # noqa: ANN001, ANN003
            self.calls += 1
            return [(None, None, None, "", (ip, port)) for ip in self.ips]

        loop.getaddrinfo = getaddrinfo  # type: ignore[method-assign]


def _fake_httpx(handler) -> SimpleNamespace:  # noqa: ANN001
    """webrtc_peers.httpx, with AsyncClient wired to a MockTransport."""

    def AsyncClient(**kw):  # noqa: ANN003, N802
        kw.pop("transport", None)
        return httpx.AsyncClient(transport=httpx.MockTransport(handler), **kw)

    return SimpleNamespace(AsyncClient=AsyncClient, HTTPError=httpx.HTTPError)


class TestPeerDiscovery:
    def test_self_is_excluded(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("PIPECAT_SELF_IP", "10.0.0.1")

        async def run() -> None:
            _Resolver(["10.0.0.1", "10.0.0.2", "10.0.0.3"]).install()
            assert await peer_addresses() == ["10.0.0.2", "10.0.0.3"]

        asyncio.run(run())

    def test_disabled_by_an_empty_host(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """Single-replica deploys and local dev have no siblings to ask."""
        monkeypatch.setenv("WEBRTC_PEER_HOST", "")

        async def run() -> None:
            r = _Resolver(["10.0.0.2"])
            r.install()
            assert await peer_addresses() == []
            assert r.calls == 0

        asyncio.run(run())

    def test_dns_is_cached_for_the_ttl(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """One browser emits a burst of candidates; that must not be a burst of
        DNS lookups."""
        monkeypatch.setenv("WEBRTC_PEER_DNS_TTL_S", "60")

        async def run() -> None:
            r = _Resolver(["10.0.0.2"])
            r.install()
            for _ in range(5):
                assert await peer_addresses() == ["10.0.0.2"]
            assert r.calls == 1

        asyncio.run(run())

    def test_an_unresolvable_service_is_degraded_not_fatal(self) -> None:
        async def run() -> None:
            loop = asyncio.get_running_loop()

            async def boom(*a, **kw):  # noqa: ANN002, ANN003
                raise OSError("Name or service not known")

            loop.getaddrinfo = boom  # type: ignore[method-assign]
            assert await peer_addresses() == []

        asyncio.run(run())


class TestForwarding:
    def test_a_forwarded_request_is_never_forwarded_again(self) -> None:
        """The loop guard. Without it, two nodes that both lack the pc_id would
        bounce the same candidate between them until something gave out."""

        async def run() -> None:
            r = _Resolver(["10.0.0.2"])
            r.install()
            got = await forward_to_owner(
                method="PATCH",
                token="t",
                body={"pc_id": "x"},
                headers={FORWARDED_HEADER: "1"},
            )
            assert got is None
            assert r.calls == 0, "a forwarded request must not even look for peers"

        asyncio.run(run())

    def test_the_owner_answers_and_its_reply_is_returned(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        seen: list[tuple[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            seen.append((str(request.url.host), request.headers.get(FORWARDED_HEADER, "")))
            if request.url.host == "10.0.0.3":
                return httpx.Response(200, json={"status": "success"})
            return httpx.Response(404, json={"detail": "unknown pc_id"})

        monkeypatch.setattr(webrtc_peers, "httpx", _fake_httpx(handler))

        async def run() -> None:
            _Resolver(["10.0.0.2", "10.0.0.3"]).install()
            got = await forward_to_owner(
                method="PATCH", token="t", body={"pc_id": "x"}, headers={}
            )
            assert got == {"status": "success"}
            # every hop must carry the marker, or the guard above is unreachable
            assert {h for _, h in seen} == {"1"}
            assert {host for host, _ in seen} == {"10.0.0.2", "10.0.0.3"}

        asyncio.run(run())

    def test_nobody_owns_it_means_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """The caller then raises its own 404 — behaviour unchanged from before
        this module existed."""
        monkeypatch.setattr(
            webrtc_peers,
            "httpx",
            _fake_httpx(lambda request: httpx.Response(404, json={"detail": "unknown pc_id"})),
        )

        async def run() -> None:
            _Resolver(["10.0.0.2", "10.0.0.3"]).install()
            assert (
                await forward_to_owner(
                    method="PATCH", token="t", body={"pc_id": "x"}, headers={}
                )
                is None
            )

        asyncio.run(run())

    def test_a_dead_peer_does_not_sink_the_batch(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A node mid-restart is exactly when this matters most."""

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "10.0.0.2":
                raise httpx.ConnectError("connection refused", request=request)
            return httpx.Response(200, json={"status": "success"})

        monkeypatch.setattr(webrtc_peers, "httpx", _fake_httpx(handler))

        async def run() -> None:
            _Resolver(["10.0.0.2", "10.0.0.3"]).install()
            got = await forward_to_owner(
                method="PATCH", token="t", body={"pc_id": "x"}, headers={}
            )
            assert got == {"status": "success"}

        asyncio.run(run())

    def test_renegotiation_forwards_the_post_and_returns_the_sdp(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The POST path carries an SDP answer back, not just a status."""
        answer = {"sdp": "v=0\\r\\n", "type": "answer", "pc_id": "abc"}

        def handler(request: httpx.Request) -> httpx.Response:
            assert request.method == "POST"
            return httpx.Response(200, json=answer)

        monkeypatch.setattr(webrtc_peers, "httpx", _fake_httpx(handler))

        async def run() -> None:
            _Resolver(["10.0.0.2"]).install()
            got = await forward_to_owner(
                method="POST",
                token="t",
                body={"pc_id": "abc", "sdp": "...", "type": "offer"},
                headers={},
            )
            assert got == answer

        asyncio.run(run())

    def test_a_peer_error_response_is_not_mistaken_for_an_answer(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            webrtc_peers,
            "httpx",
            _fake_httpx(lambda request: httpx.Response(500, text="boom")),
        )

        async def run() -> None:
            _Resolver(["10.0.0.2"]).install()
            assert (
                await forward_to_owner(
                    method="PATCH", token="t", body={"pc_id": "x"}, headers={}
                )
                is None
            )

        asyncio.run(run())
