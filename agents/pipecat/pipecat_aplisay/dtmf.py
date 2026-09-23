"""Keypad digits for services that inject them themselves (GPT-Live, the Grok
voice row, OpenAI Realtime). Kept light: voice_session imports it on every
realtime call, so nothing provider-specific belongs here."""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from loguru import logger
from pipecat.frames.frames import BotStoppedSpeakingFrame, CancelFrame, EndFrame, Frame, InputDTMFFrame
from pipecat.processors.aggregators.dtmf_aggregator import DTMFAggregator
from pipecat.processors.frame_processor import FrameDirection


class CallbackDtmfAggregator(DTMFAggregator):
    """An aggregated digit string goes to ``on_digits`` instead of becoming a
    TranscriptionFrame those services would never send.

    With ``mute_until_bot_complete`` the digits before the bot's first turn
    ends are dropped, as the greeting mute drops the caller's speech. Digits
    still buffered when the pipeline ends are dropped too: a response started
    on a closing socket is never metered.
    """

    def __init__(
        self,
        *,
        on_digits: Callable[[str], Awaitable[None]],
        mute_until_bot_complete: bool = False,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._on_digits = on_digits
        self._muted = mute_until_bot_complete

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        if isinstance(frame, BotStoppedSpeakingFrame):
            self._muted = False
        elif isinstance(frame, (EndFrame, CancelFrame)):
            self._aggregation = ""
        await super().process_frame(frame, direction)

    async def _handle_dtmf_frame(self, frame: InputDTMFFrame) -> None:
        if self._muted:
            logger.debug(f"dropping keypad digit {frame.button.value!r} during the greeting")
            return
        await super()._handle_dtmf_frame(frame)

    async def _flush_aggregation(self) -> None:
        if not self._aggregation:
            return
        sequence, self._aggregation = self._aggregation, ""
        try:
            await self._on_digits(sequence)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"DTMF injection failed: {e}")
