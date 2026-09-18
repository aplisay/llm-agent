"""Opt-in hangup after repeated unanswered inactivity prompts
(``options.inactivity.hangup``, :mod:`pipecat_aplisay.voice_session`).

Without the flag a leg nobody hangs up is only reclaimed by the session long-stop
(the model's ``maxDuration`` plus a few seconds), so whoever is still on the line
sits through minutes of silence first — most visibly an abandoned
consultative-transfer target, which has no other party left to hang up on it.

Two enforcement paths, mirroring the LiveKit worker: Ultravox-backed sessions get a
provider-side ``endBehavior`` on the last ``inactivityMessages`` entry; everything
else is counted by the generic kick and torn down by ``CallSession``. These tests
cover the option gate, the Ultravox mapping and the generic kick's prompt counter.
"""

from __future__ import annotations

import asyncio

import pytest
from loguru import logger
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMUserAggregator,
    LLMUserAggregatorParams,
)
from pipecat.turns.user_start import UserTurnStartedParams, VADUserTurnStartStrategy
from pipecat.turns.user_stop import SpeechTimeoutUserTurnStopStrategy
from pipecat.turns.user_turn_strategies import UserTurnStrategies

from pipecat_aplisay.constants import DISCONNECT_REASONS
from pipecat_aplisay.voice_session import (
    INACTIVITY_PROMPT_COUNT,
    _inactivity_hangup_enabled,
    _ultravox_inactivity_extra,
    _wire_inactivity_kick,
)


def _agent(**inactivity) -> dict:
    return {"options": {"inactivity": inactivity}} if inactivity else {"options": {}}


def _configured(**extra) -> dict:
    return _agent(timeout="6s", message="Are you still there?", **extra)


# --- the option gate ---------------------------------------------------------


def test_hangup_defaults_off():
    assert _inactivity_hangup_enabled(_configured()) is False
    assert _inactivity_hangup_enabled(_configured(hangup=False)) is False


def test_hangup_on_when_explicitly_set():
    assert _inactivity_hangup_enabled(_configured(hangup=True)) is True


def test_hangup_requires_a_usable_inactivity_config():
    # No prompt to count means nothing to hang up after.
    assert _inactivity_hangup_enabled({"options": {}}) is False
    assert _inactivity_hangup_enabled(_agent(hangup=True)) is False
    assert _inactivity_hangup_enabled(_agent(hangup=True, timeout="6s")) is False, "message missing"
    assert (
        _inactivity_hangup_enabled(_agent(hangup=True, message="hi", timeout="0s")) is False
    ), "non-positive timeout"


def test_truthy_but_not_true_does_not_opt_in():
    # A hand-edited agent definition must not arm this by accident.
    assert _inactivity_hangup_enabled(_configured(hangup="yes")) is False
    assert _inactivity_hangup_enabled(_configured(hangup=1)) is False


def test_no_inactivity_block_at_all():
    assert _inactivity_hangup_enabled({}) is False
    assert _inactivity_hangup_enabled({"options": None}) is False


# --- Ultravox native mapping -------------------------------------------------


def test_without_hangup_no_end_behavior_anywhere():
    messages = _ultravox_inactivity_extra(_configured())["inactivityMessages"]
    assert len(messages) == INACTIVITY_PROMPT_COUNT
    for m in messages:
        assert m == {"duration": "6s", "message": "Are you still there?"}
        assert "endBehavior" not in m


def test_with_hangup_end_behavior_on_last_prompt_only():
    messages = _ultravox_inactivity_extra(_configured(hangup=True))["inactivityMessages"]
    assert len(messages) == INACTIVITY_PROMPT_COUNT
    for m in messages[:-1]:
        assert "endBehavior" not in m, "earlier prompts must not end the call"
    assert messages[-1] == {
        "duration": "6s",
        "message": "Are you still there?",
        # SOFT not STRICT, so the final prompt is still delivered rather than cut.
        "endBehavior": "END_BEHAVIOR_HANG_UP_SOFT",
    }


def test_entries_are_independent_objects():
    messages = _ultravox_inactivity_extra(_configured(hangup=True))["inactivityMessages"]
    messages[0]["message"] = "mutated"
    assert messages[1]["message"] == "Are you still there?"


def test_unset_inactivity_yields_no_extra():
    assert _ultravox_inactivity_extra({"options": {}}) == {}
    assert _ultravox_inactivity_extra(_agent(hangup=True)) == {}


# --- the generic kick's prompt counter ---------------------------------------
#
# Driven through a real LLMUserAggregator from the pinned pipecat, so the
# handlers get exactly the arguments pipecat passes. Pipecat's dispatcher
# catches an exception raised by a handler and only logs it, so a signature
# mismatch shows up as a logged error and a count that never resets.


@pytest.fixture()
def handler_errors():
    """ERROR log lines written during the test. Pipecat logs a handler's
    exception here instead of raising it."""
    lines: list[str] = []
    sink = logger.add(lines.append, format="{message}", level="ERROR")
    try:
        yield lines
    finally:
        logger.remove(sink)


class _Task:
    """Stands in for the PipelineTask: records the frames the kick queues."""

    def __init__(self) -> None:
        self.frames: list = []

    async def queue_frames(self, frames: list) -> None:
        self.frames.extend(frames)


def _wired() -> tuple[LLMUserAggregator, list[int]]:
    """A user aggregator with the kick wired on it, as in pipeline mode with
    ``hangup`` set. Also returns a list that gets the number of prompts spoken
    so far each time the kick ends the call."""
    # Light strategies: the default stop strategy loads the smart-turn model.
    aggregator = LLMUserAggregator(
        LLMContext(),
        params=LLMUserAggregatorParams(
            user_turn_strategies=UserTurnStrategies(
                start=[VADUserTurnStartStrategy()],
                stop=[SpeechTimeoutUserTurnStopStrategy()],
            )
        ),
    )
    task = _Task()
    hangups: list[int] = []

    async def hang_up() -> None:
        hangups.append(len(task.frames))

    _wire_inactivity_kick(
        user_aggregator=aggregator,
        task_ref_getter=lambda: task,
        agent=_configured(hangup=True),
        mode="pipeline",
        is_ultravox=False,
        on_inactivity_hangup=hang_up,
    )
    return aggregator, hangups


async def _settle() -> None:
    # The aggregator runs these handlers as tasks. Wait for them to finish.
    current = asyncio.current_task()
    await asyncio.gather(*(t for t in asyncio.all_tasks() if t is not current))


async def _user_turn_started(aggregator: LLMUserAggregator) -> None:
    # The aggregator's own emitter, so pipecat picks the handler's arguments
    # (today: aggregator, strategy). There is no pipeline to push frames into,
    # so the speaking frames and the interruption are turned off.
    await aggregator._on_user_turn_started(
        aggregator._user_turn_controller,
        VADUserTurnStartStrategy(),
        UserTurnStartedParams(enable_interruptions=False, enable_user_speaking_frames=False),
    )
    await _settle()


async def _user_idle(aggregator: LLMUserAggregator) -> None:
    await aggregator._on_user_turn_idle(aggregator._user_idle_controller)
    await _settle()


def test_unanswered_prompts_in_a_row_end_the_call(handler_errors):
    async def scenario() -> list[int]:
        aggregator, hangups = _wired()
        for _ in range(INACTIVITY_PROMPT_COUNT):
            await _user_idle(aggregator)
        return hangups

    hangups = asyncio.run(scenario())
    assert handler_errors == []
    assert hangups == [INACTIVITY_PROMPT_COUNT]


def test_user_speech_between_prompts_resets_the_count(handler_errors):
    async def scenario() -> tuple[list[int], list[int]]:
        aggregator, hangups = _wired()
        for _ in range(INACTIVITY_PROMPT_COUNT - 1):
            await _user_idle(aggregator)
        await _user_turn_started(aggregator)
        for _ in range(INACTIVITY_PROMPT_COUNT - 1):
            await _user_idle(aggregator)
        before = list(hangups)
        await _user_idle(aggregator)
        return before, hangups

    before, after = asyncio.run(scenario())
    assert handler_errors == [], "an event handler raised inside pipecat's dispatcher"
    assert before == [], "prompts either side of the caller speaking must not add up to a hangup"
    assert after == [2 * INACTIVITY_PROMPT_COUNT - 1], "the count starts again from zero"


# --- disconnect taxonomy -----------------------------------------------------


def test_distinct_disconnect_reason():
    # Must be distinguishable from a maxDuration long-stop in call records, and
    # identical to the LiveKit worker's string so reporting can span both stacks.
    assert DISCONNECT_REASONS["INACTIVITY_TIMEOUT"] == "Inactivity timeout"
    assert DISCONNECT_REASONS["INACTIVITY_TIMEOUT"] != DISCONNECT_REASONS["SESSION_TIMEOUT"]
