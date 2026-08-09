"""Tests for the send_dtmf builtin platform function (CallSession._on_send_dtmf).

send_dtmf plays out-of-band RFC 4733 DTMF to the far end of a SIP call. These
tests pin the guard rails independent of any real gateway/transport:

  - a WebRTC/browser session is rejected (there is no telephone leg to signal
    on) and the gateway is never asked to send anything;
  - the digit string is validated (non-empty, alphabet 0-9/*/#, length cap);
  - a valid request is forwarded to the active gateway exactly once;
  - a gateway that can't send DTMF (raises NotImplementedError, as the base
    GatewaySession does for Daily / FreeSWITCH) surfaces a clean FAILED result.
"""

from __future__ import annotations

import asyncio

import pytest


class _RecordingGateway:
    """Stub gateway session that records send_dtmf calls, or raises to model a
    gateway without DTMF-send support."""

    transport = None

    def __init__(self, *, unsupported: bool = False) -> None:
        self.sent: list[str] = []
        self._unsupported = unsupported

    async def shutdown(self) -> None:  # pragma: no cover
        return None

    async def send_dtmf(self, digits: str) -> None:
        if self._unsupported:
            raise NotImplementedError("stub gateway has no DTMF send")
        self.sent.append(digits)


def _session(gateway: _RecordingGateway):
    from pipecat_aplisay import api_client
    from pipecat_aplisay.call_session import CallSession

    call = api_client.CallRecord(
        id="call-1",
        userId="user-1",
        organisationId="org-1",
        instanceId="inst-1",
        agentId="agent-1",
        persisted=False,
    )
    return CallSession(
        session_id="s1",
        agent={
            "id": "agent-1",
            "modelName": "pipecat:openai/gpt-4o",
            "organisationId": "org-1",
            "userId": "user-1",
        },
        instance={"streamLog": False},
        sip_gateway=None,  # type: ignore[arg-type]
        gateway_session=gateway,  # type: ignore[arg-type]
        call=call,
    )


def test_send_dtmf_ok_forwards_to_gateway() -> None:
    gw = _RecordingGateway()
    session = _session(gw)
    result = asyncio.run(session._on_send_dtmf({"digits": "1234#"}))
    assert result["status"] == "OK"
    assert gw.sent == ["1234#"]
    assert "5" in result["detail"]  # "sent 5 DTMF digit(s)"


def test_send_dtmf_rejects_webrtc_session() -> None:
    gw = _RecordingGateway()
    session = _session(gw)
    session.is_webrtc_origin = True
    result = asyncio.run(session._on_send_dtmf({"digits": "1234"}))
    assert result["status"] == "FAILED"
    assert "SIP" in result["error"]
    # Must never reach the gateway on a browser session.
    assert gw.sent == []


@pytest.mark.parametrize("digits", ["", "  ", "12a4", "12 34", "12,34", "A", "+441234", "0#*x"])
def test_send_dtmf_rejects_bad_digits(digits) -> None:
    gw = _RecordingGateway()
    session = _session(gw)
    result = asyncio.run(session._on_send_dtmf({"digits": digits}))
    assert result["status"] == "FAILED"
    assert gw.sent == []


def test_send_dtmf_rejects_overlong() -> None:
    gw = _RecordingGateway()
    session = _session(gw)
    result = asyncio.run(session._on_send_dtmf({"digits": "1" * 65}))
    assert result["status"] == "FAILED"
    assert gw.sent == []


def test_send_dtmf_accepts_full_alphabet() -> None:
    gw = _RecordingGateway()
    session = _session(gw)
    result = asyncio.run(session._on_send_dtmf({"digits": "0123456789*#"}))
    assert result["status"] == "OK"
    assert gw.sent == ["0123456789*#"]


def test_send_dtmf_gateway_unsupported_is_clean_failure() -> None:
    gw = _RecordingGateway(unsupported=True)
    session = _session(gw)
    result = asyncio.run(session._on_send_dtmf({"digits": "12"}))
    assert result["status"] == "FAILED"
    assert "not supported" in result["error"].lower()
