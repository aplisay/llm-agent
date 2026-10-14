"""Every transaction-log entry carries the time it was captured.

Without it the server stamps the write time, so a batched call's rows all
share the end-of-call time and ``ORDER BY created_at`` no longer gives the
conversation order.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

import pytest

from pipecat_aplisay import api_client
from pipecat_aplisay.bridge_transcript import CALLER, TARGET, BridgeTranscriptCollector
from pipecat_aplisay.call_session import CallSession


def _call() -> api_client.CallRecord:
    return api_client.CallRecord(id="c1", userId="u", organisationId="o", instanceId="i", agentId="a")


def _session(stream_log: bool) -> CallSession:
    return CallSession(  # type: ignore[arg-type]
        session_id="s",
        agent={},
        instance={"streamLog": stream_log},
        call=_call(),
        sip_gateway=None,
        gateway_session=None,
    )


@pytest.fixture
def requests(monkeypatch):
    sent: list[tuple[str, str, dict]] = []

    async def _request(method, path, body=None, **_kwargs):
        sent.append((method, path, body))
        return {}

    monkeypatch.setattr(api_client, "_request", _request)
    return sent


async def _send_bracketed(session: CallSession, messages: list[dict]) -> list[tuple[datetime, datetime]]:
    windows = []
    for message in messages:
        before = datetime.now(timezone.utc)
        await session._send_message(message, is_final=True)
        windows.append((before, datetime.now(timezone.utc)))
    return windows


MESSAGES = [{"agent": "Hello, how can I help?"}, {"user": "What's the weather?"}, {"agent": "Sunny."}]


def test_batched_entries_keep_their_capture_time(requests):
    session = _session(stream_log=False)

    async def run():
        windows = await _send_bracketed(session, MESSAGES)
        await api_client.end_call(session.call, "normal")
        return windows

    windows = asyncio.run(run())

    for entry, (before, after) in zip(session.call.batched_transaction_logs, windows):
        assert entry["createdAt"].tzinfo is not None
        assert before <= entry["createdAt"] <= after

    [(_, path, body)] = requests
    assert path == "/api/agent-db/call/c1/end"
    sent = body["transactionLogs"]
    assert [e["type"] for e in sent] == ["agent", "user", "agent"]
    stamps = [datetime.fromisoformat(e["createdAt"]) for e in sent]
    assert stamps == sorted(stamps)
    for stamp, (before, after) in zip(stamps, windows):
        assert before <= stamp <= after


def test_streamed_entries_post_their_capture_time(requests):
    session = _session(stream_log=True)

    windows = asyncio.run(_send_bracketed(session, MESSAGES))

    assert [path for _, path, _ in requests] == ["/api/agent-db/transaction-log"] * 3
    for (_, _, body), (before, after) in zip(requests, windows):
        assert isinstance(body["createdAt"], str)
        assert before <= datetime.fromisoformat(body["createdAt"]) <= after


def test_bridge_transcript_entries_keep_their_capture_time():
    call = _call()
    collector = BridgeTranscriptCollector(call=call, stream_log=False)

    async def run():
        windows = []
        for speaker, text in [(CALLER, "I need help"), (TARGET, "Sure, go ahead")]:
            before = datetime.now(timezone.utc)
            await collector.add(speaker, text)
            windows.append((before, datetime.now(timezone.utc)))
        return windows

    windows = asyncio.run(run())

    assert [e["type"] for e in call.batched_transaction_logs] == ["user", "agent"]
    for entry, (before, after) in zip(call.batched_transaction_logs, windows):
        assert before <= entry["createdAt"] <= after
