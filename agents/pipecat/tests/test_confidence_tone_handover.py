"""Tests for the agent-to-agent handover mode of the confidence tone.

The confidence tone (``options.transferTone``) was originally driven only by
the call's ``transfer_state`` (blind/consult line transfers). Full-stack
agent-to-agent handover has no line transfer — the outgoing agent's pipeline is
torn down and the incoming agent's model stack spins up — so a dedicated
"handover" mode covers that dead-air gap, gated only by speech grace and
stopped on the incoming agent's first speech (or a max-duration backstop).

These cover the pure control surface (``arm_handover`` / ``_should_play`` /
``disarm``) and the frame-driven auto-stop on ``BotStartedSpeakingFrame``.
"""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

from pipecat.frames.frames import BotStartedSpeakingFrame
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import run_test

from pipecat_aplisay.confidence_tone import (
    _HANDOVER_MAX_SECS,
    ConfidenceToneInjector,
    ToneConfig,
)


def _injector(state: str = "none") -> ConfidenceToneInjector:
    # In handover mode the transfer state must be IGNORED, so default the stub
    # to "none" — a value that would immediately disarm a blind/consult tone.
    return ConfidenceToneInjector(
        ToneConfig(grace_ms=1200),
        get_transfer_state=lambda: SimpleNamespace(state=state),
    )


class TestArmHandover:
    def test_arm_sets_handover_mode(self) -> None:
        inj = _injector()
        inj.arm_handover()
        assert inj._handover is True
        # ``_mode`` is the "armed" sentinel the generator guards check.
        assert inj._mode == "blind"

    def test_grace_gates_initial_play(self) -> None:
        inj = _injector()
        inj.arm_handover()
        # Just armed: still inside the post-speech grace window → no tone yet.
        assert inj._should_play() is False

    def test_plays_after_grace_ignoring_transfer_state(self) -> None:
        # state="none" would disarm a normal blind tone; handover must ignore it.
        inj = _injector(state="none")
        inj.arm_handover()
        inj._last_voice = time.monotonic() - 5.0
        assert inj._should_play() is True
        assert inj._handover is True  # not disarmed by the "none" state

    def test_speech_suppresses_tone(self) -> None:
        inj = _injector()
        inj.arm_handover()
        inj._last_voice = time.monotonic() - 5.0
        inj._user_speaking = True
        assert inj._should_play() is False

    def test_backstop_disarms(self) -> None:
        inj = _injector()
        inj.arm_handover()
        inj._last_voice = time.monotonic() - 5.0
        # Past the max handover duration: the incoming agent never spoke.
        inj._handover_started_at = time.monotonic() - (_HANDOVER_MAX_SECS + 1.0)
        assert inj._should_play() is False
        assert inj._handover is False
        assert inj._mode is None

    def test_disarm_clears_handover(self) -> None:
        inj = _injector()
        inj.arm_handover()
        inj.disarm()
        assert inj._handover is False
        assert inj._mode is None


def test_bot_speech_stops_handover_tone() -> None:
    """The incoming agent's first ``BotStartedSpeakingFrame`` ends the gap."""

    async def run() -> None:
        inj = _injector()
        inj.arm_handover()
        assert inj._handover is True

        # BotStartedSpeakingFrame travels upstream from the output transport.
        await run_test(
            inj,
            frames_to_send=[BotStartedSpeakingFrame()],
            frames_to_send_direction=FrameDirection.UPSTREAM,
            expected_up_frames=[BotStartedSpeakingFrame],
        )

        assert inj._handover is False
        assert inj._mode is None

    asyncio.run(run())
