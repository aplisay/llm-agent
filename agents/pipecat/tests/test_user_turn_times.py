"""A final ``user`` row is stamped at the end of the caller's turn: a live best
guess, then on Ultravox the call's own message timings just before the call
record ends. Mirrors the LiveKit worker's user-turn-* tests.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    FunctionCallsStartedFrame,
    TranscriptionFrame,
    UserStoppedSpeakingFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.observers.base_observer import FramePushed
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import LLMService

from pipecat_aplisay import api_client, user_turn_times
from pipecat_aplisay.call_session import CallSession
from pipecat_aplisay.transcript_observer import TranscriptForwardingObserver
from pipecat_aplisay.user_turn_times import (
    CORRECTION_SKEW_S,
    RESPONSE_TRANSCRIPT_WINDOW_S,
    UserTurnClock,
    match_user_turn_ends,
    reconcile_user_rows,
    ultravox_call_id,
)


def _at(seconds: float) -> datetime:
    return datetime.fromtimestamp(seconds, timezone.utc)


# ---- UserTurnClock ----


def test_with_no_other_signal_the_row_keeps_the_arrival_time():
    assert UserTurnClock().stamp(100.0) == _at(100.0)


def test_an_ultravox_reply_start_before_the_transcript_gives_the_time():
    clock = UserTurnClock()
    clock.note_response_started(23.408)
    assert clock.stamp(23.736) == _at(23.408)


def test_the_vad_end_of_speech_beats_the_later_turn_level_stop_and_reply():
    clock = UserTurnClock()
    clock.note_user_started(40.0)
    clock.note_user_stopped(42.3)  # VAD stop, already corrected by stop_secs
    clock.note_user_stopped(42.9)  # turn-level stop for the same speech
    clock.note_response_started(43.1)
    assert clock.stamp(43.5) == _at(42.3)


def test_speaking_again_discards_the_earlier_stop():
    clock = UserTurnClock()
    clock.note_user_started(10.0)
    clock.note_user_stopped(11.0)
    clock.note_user_started(11.6)
    clock.note_user_stopped(13.0)
    assert clock.stamp(13.8) == _at(13.0)


def test_a_reply_start_older_than_the_window_or_before_the_caller_spoke_is_ignored():
    clock = UserTurnClock()
    clock.note_response_started(10.0)
    arrived = 10.0 + RESPONSE_TRANSCRIPT_WINDOW_S + 0.01
    assert clock.stamp(arrived) == _at(arrived)

    clock.note_response_started(20.0)
    clock.note_user_started(20.5)
    assert clock.stamp(21.9) == _at(21.9)


def test_each_signal_is_used_once_and_rows_never_go_back_in_time():
    clock = UserTurnClock()
    clock.note_response_started(30.0)
    assert clock.stamp(30.3) == _at(30.0)
    assert clock.stamp(31.0) == _at(31.0)


# ---- Ultravox call id and message matching ----


def test_the_call_id_is_read_from_the_join_url():
    url = "wss://voice.ultravox.ai/calls/7831460c-96e6-4c9b-a5e9-e29befbcb621/server_web_socket?experimentalMessages=debug"
    assert ultravox_call_id(url) == "7831460c-96e6-4c9b-a5e9-e29befbcb621"
    assert ultravox_call_id("wss://elsewhere.example/socket") is None


JOINED = datetime(2026, 10, 14, 17, 21, 19, 440213, timezone.utc)
MESSAGES = [
    {"role": "MESSAGE_ROLE_AGENT", "text": "Hello?", "wallClockTimespan": {"start": "0.286973s", "end": "1.031101s"}},
    {"role": "MESSAGE_ROLE_USER", "text": " Thank you for calling.", "wallClockTimespan": {"start": "1.038358s", "end": "3.437978s"}},
    {"role": "MESSAGE_ROLE_USER", "text": " Yes.", "wallClockTimespan": {"start": "14.0s", "end": "14.5s"}},
    {"role": "MESSAGE_ROLE_USER", "text": "Yes", "wallClockTimespan": {"start": "20.0s", "end": "20.5s"}},
    {"role": "MESSAGE_ROLE_USER", "text": "No timespan"},
]


def test_rows_pair_with_their_messages_in_order_and_by_text():
    ends = match_user_turn_ends(
        ["thank you for calling", "Yes.", "yes", "Never said", "No timespan"], MESSAGES, JOINED
    )
    assert ends[0] == JOINED + timedelta(seconds=3.437978)
    assert ends[1] == JOINED + timedelta(seconds=14.5)
    assert ends[2] == JOINED + timedelta(seconds=20.5)
    assert ends[3] is None
    assert ends[4] is None


# ---- reconcile_user_rows ----


def _call() -> api_client.CallRecord:
    return api_client.CallRecord(id="c1", userId="u", organisationId="o", instanceId="i", agentId="a")


def _row(call, text, guess, **ref):
    return {"call": call, "text": text, "guess": guess, "ultravox_call_id": "uv-1", "api_key": "k", **ref}


@pytest.fixture
def ultravox(monkeypatch):
    calls = []

    async def fetch(call_id, api_key):
        calls.append((call_id, api_key))
        return JOINED, MESSAGES

    monkeypatch.setattr(user_turn_times, "fetch_ultravox_call", fetch)
    return calls


def test_batched_entries_and_streamed_rows_get_ultravoxs_end_time(ultravox):
    call = _call()
    entry = {"createdAt": JOINED + timedelta(seconds=4.0)}
    rows = [
        _row(call, " Thank you for calling.", entry["createdAt"], entry=entry),
        _row(call, " Yes.", JOINED + timedelta(seconds=15.0), id=42),
    ]
    asyncio.run(reconcile_user_rows(call, rows))
    assert entry["createdAt"] == JOINED + timedelta(seconds=3.437978)
    assert call.transaction_log_corrections == [{"id": 42, "createdAt": JOINED + timedelta(seconds=14.5)}]
    assert ultravox == [("uv-1", "k")]


def test_a_time_later_than_the_guess_keeps_the_guess(ultravox):
    call = _call()
    guess = JOINED + timedelta(seconds=3.437978 - CORRECTION_SKEW_S - 0.01)
    entry = {"createdAt": guess}
    asyncio.run(reconcile_user_rows(call, [_row(call, " Thank you for calling.", guess, entry=entry)]))
    assert entry["createdAt"] == guess


def test_a_failing_fetch_keeps_the_guesses(monkeypatch):
    async def fail(call_id, api_key):
        raise RuntimeError("Ultravox down")

    monkeypatch.setattr(user_turn_times, "fetch_ultravox_call", fail)
    call = _call()
    guess = JOINED + timedelta(seconds=4.0)
    entry = {"createdAt": guess}
    asyncio.run(reconcile_user_rows(call, [_row(call, " Thank you for calling.", guess, entry=entry)]))
    assert entry["createdAt"] == guess
    assert call.transaction_log_corrections == []


# ---- end_call ----


@pytest.fixture
def requests(monkeypatch):
    sent = []

    async def _request(method, path, body=None, **_kwargs):
        sent.append((method, path, body))
        return {"id": 7}

    monkeypatch.setattr(api_client, "_request", _request)
    return sent


def test_end_call_runs_the_before_end_hook_first_and_sends_its_corrections(requests):
    call = _call()
    entry = {"type": "user", "data": "Hello", "createdAt": _at(10.0)}
    call.batched_transaction_logs.append(entry)

    async def hook(c):
        assert requests == []
        entry["createdAt"] = _at(9.5)
        c.transaction_log_corrections.append({"id": 3, "createdAt": _at(8.0)})

    call.set_before_end(hook)
    asyncio.run(api_client.end_call(call, "normal"))

    [(_, path, body)] = requests
    assert path == "/api/agent-db/call/c1/end"
    assert body["transactionLogs"][0]["createdAt"] == _at(9.5).isoformat()
    assert body["transactionLogCorrections"] == [{"id": 3, "createdAt": _at(8.0).isoformat()}]


def test_a_failing_or_slow_hook_still_ends_the_call(requests, monkeypatch):
    monkeypatch.setattr(api_client, "BEFORE_END_TIMEOUT_S", 0.05)
    call = _call()

    async def stuck(c):
        await asyncio.sleep(10)

    call.set_before_end(stuck)
    asyncio.run(api_client.end_call(call, "normal"))
    assert [path for _, path, _ in requests] == ["/api/agent-db/call/c1/end"]


# ---- the transcript observer and the session ----


def _push(observer, *frames, source=None) -> None:
    async def run():
        for fr in frames:
            await observer.on_push_frame(
                FramePushed(source=source, destination=None, frame=fr, direction=FrameDirection.DOWNSTREAM, timestamp=0)
            )

    asyncio.run(run())


def test_the_observer_stamps_a_final_user_row_with_the_vad_end_of_speech():
    sent = []

    async def send_message(message, *, is_final, created_at=None, user_turn=False):
        sent.append((message, is_final, created_at, user_turn))

    observer = TranscriptForwardingObserver(send_message, mode="pipeline", clock=UserTurnClock())
    stop = VADUserStoppedSpeakingFrame(stop_secs=0.8, timestamp=1000.8)
    llm = object.__new__(LLMService)
    # Observers see a frame once per hop; a repeat must not move the time.
    _push(observer, VADUserStartedSpeakingFrame(start_secs=0.2, timestamp=998.2), stop, stop)
    _push(observer, BotStartedSpeakingFrame(), UserStoppedSpeakingFrame())
    _push(observer, TranscriptionFrame(text="Hello", user_id="", timestamp="t"), source=llm)
    assert sent == [({"user": "Hello"}, True, _at(1000.0), True)]


def test_a_function_call_counts_as_the_reply_starting():
    sent = []

    async def send_message(message, *, is_final, created_at=None, user_turn=False):
        sent.append(created_at)

    observer = TranscriptForwardingObserver(send_message, mode="realtime", clock=UserTurnClock())
    _push(observer, FunctionCallsStartedFrame(function_calls=[]))
    _push(observer, TranscriptionFrame(text="Book it", user_id="", timestamp="t"), source=object.__new__(LLMService))
    [created_at] = sent
    assert created_at <= datetime.now(timezone.utc)


class _UltravoxService:
    ultravox_call_id = "uv-1"
    ultravox_api_key = "k"


def _session(stream_log: bool, llm=None) -> CallSession:
    session = CallSession(  # type: ignore[arg-type]
        session_id="s", agent={}, instance={"streamLog": stream_log}, call=_call(), sip_gateway=None, gateway_session=None
    )
    session._llm_service = llm
    return session


def test_the_session_queues_ultravox_user_turns_on_their_call(requests):
    session = _session(stream_log=True, llm=_UltravoxService())
    asyncio.run(session._send_message({"user": "Hello"}, is_final=True, created_at=_at(5.0), user_turn=True))
    asyncio.run(session._send_message({"agent": "Hi"}, is_final=True))
    [row] = session._user_turn_rows
    assert (row["call"], row["id"], row["guess"], row["text"]) == (session.call, 7, _at(5.0), "Hello")
    assert session.call._before_end is not None


def test_rows_from_other_models_are_not_queued(requests):
    session = _session(stream_log=False, llm=object())
    asyncio.run(session._send_message({"user": "Hello"}, is_final=True, created_at=_at(5.0), user_turn=True))
    assert session._user_turn_rows == []
    assert session.call._before_end is None
    assert session.call.batched_transaction_logs[0]["createdAt"] == _at(5.0)
