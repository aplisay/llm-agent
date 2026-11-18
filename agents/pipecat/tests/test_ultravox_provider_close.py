"""An Ultravox server close ends the call, as on the other realtime models.

Before, a close went unnoticed. The worker logged a send error for every audio
frame until the call ended, which crowded out the call's own invocation log,
and the caller heard nothing until the session timeout.
"""

from __future__ import annotations

import asyncio
import json

import pytest

pytest.importorskip("pipecat.services.ultravox.llm")

from websockets.exceptions import ConnectionClosedError, ConnectionClosedOK  # noqa: E402
from websockets.frames import Close  # noqa: E402

from pipecat_aplisay import ultravox_compat, voice_session  # noqa: E402
from pipecat_aplisay.ultravox_compat import AplisayUltravoxRealtimeLLMService  # noqa: E402


class _Socket:
    """An Ultravox socket that delivers ``messages``, then closes with
    ``code``: a normal close ends the iteration, an abnormal one raises."""

    def __init__(self, messages=(), *, code: int = 1000) -> None:
        self._messages = list(messages)
        self._code = code
        self.close_code: int | None = None
        self.sent: list = []

    def __aiter__(self):
        return self

    async def __anext__(self):
        if self._messages:
            return self._messages.pop(0)
        self.close_code = self._code
        if self._code != 1000:
            raise ConnectionClosedError(Close(self._code, "internal error"), None)
        raise StopAsyncIteration

    async def send(self, data) -> None:
        if self.close_code is not None:
            raise ConnectionClosedOK(Close(1000, ""), None)
        self.sent.append(data)

    async def close(self) -> None:
        self.close_code = self.close_code or 1000


def _service(socket: _Socket, ended: list[str], errors: list[str]) -> AplisayUltravoxRealtimeLLMService:
    """A no-init service: only the attributes the receive and send paths read."""
    service = object.__new__(AplisayUltravoxRealtimeLLMService)
    service._socket = socket
    service._receive_task = None
    service._disconnecting = False
    service._bot_responding = None

    async def on_ended(reason: str) -> None:
        ended.append(reason)

    async def push_error(message: str, *_args, **_kwargs) -> None:
        errors.append(message)

    service._on_session_ended = on_ended
    service.push_error = push_error  # type: ignore[method-assign]
    return service


def test_a_server_close_ends_the_call_once_and_later_sends_are_dropped():
    ended: list[str] = []
    errors: list[str] = []
    socket = _Socket([json.dumps({"type": "state", "state": "listening"})])
    service = _service(socket, ended, errors)

    async def scenario() -> None:
        await service._receive_messages()
        # The caller's audio keeps arriving until the call is torn down.
        for _ in range(50):
            await service._send(b"\x00" * 320)
        await service._send({"type": "user_text_message", "text": "hello"})
        await service._session_ended("connection_closed")

    asyncio.run(scenario())
    assert ended == ["connection_closed (code 1000)"]
    assert errors == []
    assert socket.sent == []


def test_an_abnormal_close_ends_the_call():
    ended: list[str] = []
    errors: list[str] = []
    service = _service(_Socket(code=1011), ended, errors)

    asyncio.run(service._receive_messages())
    assert ended == ["connection_closed (code 1011)"]
    assert errors == []


def test_a_send_that_finds_the_socket_closed_is_quiet():
    ended: list[str] = []
    errors: list[str] = []
    socket = _Socket()
    socket.close_code = 1000
    service = _service(socket, ended, errors)

    async def scenario() -> None:
        await service._send(b"\x00" * 320)
        await service._send(b"\x00" * 320)

    asyncio.run(scenario())
    assert errors == []
    # The receive loop reports the close, not the send path.
    assert ended == []


def test_our_own_disconnect_is_not_the_provider_ending_the_session():
    ended: list[str] = []
    errors: list[str] = []
    service = _service(_Socket(), ended, errors)
    service._disconnecting = True

    asyncio.run(service._receive_messages())
    assert ended == []


def test_build_passes_the_close_callback_to_the_ultravox_service(monkeypatch):
    class _Stop(Exception):
        pass

    seen: dict = {}

    class _Captured:
        def __init__(self, **kwargs) -> None:
            seen.update(kwargs)
            raise _Stop

    async def on_ended(_reason: str) -> None:
        return None

    monkeypatch.setattr(voice_session, "_ultravox_one_shot_params", lambda *_a, **_k: object())
    monkeypatch.setattr(ultravox_compat, "AplisayUltravoxRealtimeLLMService", _Captured)
    with pytest.raises(_Stop):
        asyncio.run(
            voice_session._build_realtime(
                None, "pipecat:ultravox/ultravox-v0.6", {"options": {}}, {}, [], "sys", None,
                on_provider_session_ended=on_ended,
            )
        )
    assert seen["on_session_ended"] is on_ended


def test_the_constructor_takes_the_close_callback():
    from pipecat.services.ultravox.llm import OneShotInputParams

    async def on_ended(_reason: str) -> None:
        return None

    service = AplisayUltravoxRealtimeLLMService(
        params=OneShotInputParams(api_key="test-key", system_prompt="sys"),
        on_session_ended=on_ended,
    )
    assert service._on_session_ended is on_ended


def test_a_platform_notice_goes_as_user_text_marked_as_not_from_the_caller():
    socket = _Socket()
    service = _service(socket, [], [])

    asyncio.run(service.inject_platform_notice("Transfer failed. The line was busy."))
    [sent] = socket.sent
    assert json.loads(sent) == {
        "type": "user_text_message",
        "text": "(Instruction from the system, not the caller: Transfer failed. The line was busy.)",
        "urgency": "soon",
    }
