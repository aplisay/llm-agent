"""A transcript row that arrives after its call record has ended still lands.

With ``streamLog`` off a call's rows are batched and sent with the end
request. A row that comes later used to join a batch nobody sends. On
Ultravox the caller's final transcript comes 0 to 0.7 s after the reply or
tool call it led to, so the line that made a consult leg ``accept_transfer``
arrived after that leg's record had ended, and was lost.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from pipecat_aplisay import api_client
from pipecat_aplisay.call_session import CallSession


def _session(*, stream_log: bool = False, persisted: bool = True) -> CallSession:
    call = api_client.CallRecord(
        id="c1", userId="u", organisationId="o", instanceId="i", agentId="a", persisted=persisted
    )
    return CallSession(  # type: ignore[arg-type]
        session_id="s",
        agent={},
        instance={"streamLog": stream_log},
        call=call,
        sip_gateway=None,
        gateway_session=None,
    )


@pytest.fixture
def requests(monkeypatch):
    sent: list[tuple[str, str, dict]] = []

    async def _request(method, path, body=None, **_kwargs):
        sent.append((method, path, body))
        return {"id": len(sent)}

    monkeypatch.setattr(api_client, "_request", _request)
    return sent


SPOKE_AT = datetime(2026, 11, 16, 12, 14, 5, 600000, tzinfo=timezone.utc)


def test_a_row_after_the_end_is_posted_on_its_own(requests):
    session = _session()

    async def run():
        await session._send_message({"agent": "Are you available to take the call?"})
        await api_client.end_call(session.call, "Transfer accepted")
        await session._send_message(
            {"user": "Yes, I will take the call."}, created_at=SPOKE_AT, user_turn=True
        )

    asyncio.run(run())

    (_, end_path, end_body), (method, path, body) = requests
    assert end_path == "/api/agent-db/call/c1/end"
    assert [e["type"] for e in end_body["transactionLogs"]] == ["agent"]
    assert (method, path) == ("POST", "/api/agent-db/transaction-log")
    assert (body["callId"], body["type"], body["data"]) == ("c1", "user", "Yes, I will take the call.")
    # It keeps the time the caller spoke, so it sorts before the end of the record.
    assert datetime.fromisoformat(body["createdAt"]) == SPOKE_AT


def test_rows_before_the_end_are_still_batched(requests):
    session = _session()
    asyncio.run(session._send_message({"user": "Hello"}))
    assert requests == []
    assert [e["type"] for e in session.call.batched_transaction_logs] == ["user"]


def test_a_browser_stub_record_still_sends_nothing(requests):
    session = _session(persisted=False)

    async def run():
        await api_client.end_call(session.call, "normal")
        await session._send_message({"user": "late"})

    asyncio.run(run())
    assert requests == []
