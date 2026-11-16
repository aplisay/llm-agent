"""The worker's WebSocket keepalive, by SIP gateway.

The VoiceBlender engine's agent socket never answers a ping. With uvicorn's
default keepalive the server then closes that socket, and the call with it.
"""

from __future__ import annotations

import asyncio
import base64
import os
import socket
import threading
import time

import pytest
import uvicorn

from pipecat_aplisay import __main__ as main_mod


@pytest.mark.parametrize("value", ["voiceblender", "VoiceBlender"])
def test_no_ping_for_the_voiceblender_gateway(monkeypatch, value):
    monkeypatch.setenv("SIP_GATEWAY", value)
    assert main_mod._ws_keepalive() == {"ws_ping_interval": None}


@pytest.mark.parametrize("value", [None, "freeswitch", "daily", "sipbridge"])
def test_uvicorn_defaults_for_every_other_gateway(monkeypatch, value):
    if value is None:
        monkeypatch.delenv("SIP_GATEWAY", raising=False)
    else:
        monkeypatch.setenv("SIP_GATEWAY", value)
    assert main_mod._ws_keepalive() == {}


def test_main_hands_the_setting_to_uvicorn(monkeypatch):
    seen = {}
    monkeypatch.setenv("SIP_GATEWAY", "voiceblender")
    monkeypatch.setattr(main_mod.secretenv, "load", lambda: None)
    monkeypatch.setattr(main_mod.uvicorn, "run", lambda *a, **kw: seen.update(kw))
    main_mod.main()
    assert "ws_ping_interval" in seen and seen["ws_ping_interval"] is None

    seen.clear()
    monkeypatch.setenv("SIP_GATEWAY", "freeswitch")
    main_mod.main()
    assert "ws_ping_interval" not in seen


async def _echo_app(scope, receive, send):
    if scope["type"] != "websocket":
        return
    await receive()
    await send({"type": "websocket.accept"})
    while True:
        message = await receive()
        if message["type"] == "websocket.disconnect":
            return


class _Server:
    """uvicorn on a free local port, in a thread."""

    def __init__(self, **ws_settings):
        config = uvicorn.Config(
            _echo_app, host="127.0.0.1", port=0, log_level="warning", **ws_settings
        )
        self.server = uvicorn.Server(config)
        self.thread = threading.Thread(target=lambda: asyncio.run(self.server.serve()))

    def __enter__(self) -> int:
        self.thread.start()
        deadline = time.monotonic() + 10
        while not self.server.started:
            assert time.monotonic() < deadline, "uvicorn did not start"
            time.sleep(0.02)
        return self.server.servers[0].sockets[0].getsockname()[1]

    def __exit__(self, *exc):
        self.server.should_exit = True
        self.thread.join(timeout=10)


def _frames_from_a_client_that_never_pongs(port: int, listen_for: float) -> list[int]:
    """Open a WebSocket by hand, answer nothing, return the opcodes received."""
    key = base64.b64encode(os.urandom(16)).decode()
    with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
        sock.sendall(
            (
                "GET /ws HTTP/1.1\r\n"
                f"Host: 127.0.0.1:{port}\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                "Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        data = b""
        while b"\r\n\r\n" not in data:
            data += sock.recv(4096)
        assert data.startswith(b"HTTP/1.1 101"), data[:60]
        data = data.split(b"\r\n\r\n", 1)[1]

        opcodes: list[int] = []
        deadline = time.monotonic() + listen_for
        while time.monotonic() < deadline:
            # A server frame is not masked. Control frames are under 126 bytes.
            while len(data) >= 2 and len(data) >= 2 + (data[1] & 0x7F):
                opcodes.append(data[0] & 0x0F)
                data = data[2 + (data[1] & 0x7F):]
            if 0x8 in opcodes:
                break
            sock.settimeout(max(0.01, deadline - time.monotonic()))
            try:
                chunk = sock.recv(4096)
            except TimeoutError:
                break
            if not chunk:
                break
            data += chunk
        return opcodes


PING, CLOSE = 0x9, 0x8


def test_default_keepalive_closes_a_client_that_never_pongs():
    # The fault, with short timers in place of uvicorn's 20 s and 20 s.
    with _Server(ws_ping_interval=0.2, ws_ping_timeout=0.2) as port:
        opcodes = _frames_from_a_client_that_never_pongs(port, listen_for=3.0)
    assert opcodes == [PING, CLOSE]


def test_the_voiceblender_setting_keeps_such_a_client(monkeypatch):
    monkeypatch.setenv("SIP_GATEWAY", "voiceblender")
    settings = {"ws_ping_interval": 0.2, "ws_ping_timeout": 0.2, **main_mod._ws_keepalive()}
    with _Server(**settings) as port:
        opcodes = _frames_from_a_client_that_never_pongs(port, listen_for=1.5)
    assert opcodes == []
