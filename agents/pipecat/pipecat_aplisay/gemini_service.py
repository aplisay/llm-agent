"""Pipecat's Gemini Live service plus the mid-call instruction path.

Pipecat's ``GeminiLiveLLMService`` seeds the Live session from the first
context frame and, from later ones, forwards tool results only. A message the
worker appends mid-call (the inactivity kick: a developer message and an
``LLMRunFrame``, see ``voice_session._wire_inactivity_kick``) reaches the local
context and nothing else, so it is never spoken. This subclass keeps a
watermark of the context messages the server already holds and sends each new
developer or system message as a user turn with ``turn_complete=True``, which
makes the model answer it. User and assistant messages are never resent: the
server holds the audio they were transcribed from.

A client-content message interrupts a running generation, so an instruction
that arrives while the model is speaking is held until its turn completes. A
caller interruption drops it: the held instruction is the inactivity prompt,
and the caller is no longer idle.

Keypad digits take the same path (``inject_dtmf``): as a ``TranscriptionFrame``
they became a user message the service never sends, so the DTMF aggregator
hands them to the service instead, as on GPT-Live and Grok.

The caller's transcription is reported per turn, as the STT and OpenAI paths
report it: a cumulative ``InterimTranscriptionFrame`` as each piece arrives and
one final ``TranscriptionFrame`` when the turn ends, which is when the model
starts answering, else after ``USER_TRANSCRIPTION_IDLE_SECS`` of quiet, else at
stop. Upstream pushes a final frame per sentence, and the transcript log
recorded each as a user turn of its own.
"""

from __future__ import annotations

import asyncio
from typing import Any

from loguru import logger
from pipecat.frames.frames import InterimTranscriptionFrame
from pipecat.processors.aggregators.llm_context import LLMContext, LLMSpecificMessage
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService
from pipecat.utils.time import time_now_iso8601

from .gemini import DTMF_MESSAGE

#: How long the caller's transcription may go quiet before the turn is closed
#: without a model answer. Longer than the server's end-of-speech window, so
#: the answer normally closes the turn first.
USER_TRANSCRIPTION_IDLE_SECS = 2.0


def _instruction_text(message: Any) -> str | None:
    """The text of an appended developer or system message, else ``None``."""
    if isinstance(message, LLMSpecificMessage) or not isinstance(message, dict):
        return None
    if message.get("role") not in ("developer", "system") or message.get("tool_call_id"):
        return None
    content = message.get("content")
    if isinstance(content, str):
        text = content.strip()
    elif isinstance(content, list):
        text = "".join(
            part.get("text", "")
            for part in content
            if isinstance(part, dict)
            and part.get("type") in ("text", "input_text")
            and isinstance(part.get("text"), str)
        ).strip()
    else:
        text = ""
    return text or None


class AplisayGeminiLiveLLMService(GeminiLiveLLMService):
    """``GeminiLiveLLMService`` that speaks messages appended after the seed."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # Context messages the server already holds, by position: the seed sends
        # everything, later instructions are sent as they appear.
        self._sent_messages = 0
        self._held_instructions: list[str] = []

    async def _create_initial_response(self, for_reconnect: bool = False) -> None:
        await super()._create_initial_response(for_reconnect=for_reconnect)
        # The seed reads the live context, so everything in it is on the server
        # (or will be, when a seed deferred to session-ready runs).
        if self._context is not None:
            self._sent_messages = len(list(self._context.get_messages()))

    async def _handle_context(self, context: LLMContext) -> None:
        initial = self._context is None
        await super()._handle_context(context)
        if initial:
            return
        messages = list(context.get_messages())
        if self._sent_messages > len(messages):
            # The context was replaced wholesale; what is left is the new history.
            self._sent_messages = len(messages)
        new = messages[self._sent_messages:]
        self._sent_messages = len(messages)
        texts = [text for message in new if (text := _instruction_text(message)) is not None]
        if not texts:
            return
        if self._bot_is_responding:
            logger.debug(f"{self}: holding {len(texts)} instruction(s) until the bot turn ends")
            self._held_instructions.extend(texts)
            return
        await self._send_instructions(texts)

    async def _send_instructions(self, texts: list[str]) -> None:
        logger.bind(count=len(texts)).debug("Gemini Live: sending appended instructions as a user turn")
        # Upstream's single-response path: client content with turn_complete=True,
        # plus the realtime nudge Gemini 3.x needs before it will answer.
        await self._create_single_response([{"role": "user", "content": text} for text in texts])

    async def inject_dtmf(self, digits: str) -> None:
        """Keypad digits: a user turn the model answers now. The DTMF aggregator
        broadcast the interruption on the first digit, so nothing is held."""
        if self._disconnecting or not self._session:
            logger.debug(f"{self}: dropping DTMF {digits!r}; the session is not ready")
            return
        logger.bind(digits=digits).debug("Gemini Live: sending keypad digits as a user turn")
        await self._create_single_response([{"role": "user", "content": DTMF_MESSAGE.format(digits=digits)}])

    async def _handle_msg_turn_complete(self, message: Any) -> None:
        await super()._handle_msg_turn_complete(message)
        if self._held_instructions and not self._bot_is_responding:
            texts, self._held_instructions = self._held_instructions, []
            await self._send_instructions(texts)

    # ---- the caller's transcription, one turn at a time -----------------------

    async def _handle_msg_input_transcription(self, message: Any) -> None:
        content = getattr(message, "server_content", None)
        text = getattr(getattr(content, "input_transcription", None), "text", None)
        if not text:
            return
        await self._cancel_transcription_timeout()
        if text.startswith(" ") and not self._user_transcription_buffer:
            text = text.lstrip()
        self._user_transcription_buffer += text
        await self.push_frame(
            InterimTranscriptionFrame(
                self._user_transcription_buffer, "", time_now_iso8601(), result=message
            ),
            FrameDirection.UPSTREAM,
        )
        self._transcription_timeout_task = self.create_task(self._transcription_timeout_handler())

    async def _transcription_timeout_handler(self) -> None:
        await asyncio.sleep(USER_TRANSCRIPTION_IDLE_SECS)
        self._transcription_timeout_task = None
        await self._close_user_turn("quiet")

    async def _cancel_transcription_timeout(self) -> None:
        task, self._transcription_timeout_task = self._transcription_timeout_task, None
        if task is not None and task is not asyncio.current_task():
            await self.cancel_task(task)

    async def _close_user_turn(self, reason: str) -> None:
        """One final frame for everything the caller said this turn."""
        text = self._user_transcription_buffer.strip()
        self._user_transcription_buffer = ""
        if not text:
            return
        logger.bind(reason=reason, chars=len(text)).debug("Gemini Live: caller turn transcribed")
        await self._push_user_transcription(text, result=None)

    async def _set_bot_is_responding(self, responding: bool) -> None:
        if responding and not self._bot_is_responding:
            # The model's answer is the end of the caller's turn.
            await self._cancel_transcription_timeout()
            await self._close_user_turn("model turn")
        await super()._set_bot_is_responding(responding)

    async def stop(self, frame: Any) -> None:
        # Words the caller said just before the call ended still get their row.
        await self._cancel_transcription_timeout()
        await self._close_user_turn("stop")
        await super().stop(frame)

    async def _handle_interruption(self) -> None:
        await super()._handle_interruption()
        if self._held_instructions:
            logger.debug(f"{self}: dropping {len(self._held_instructions)} held instruction(s), the caller interrupted")
            self._held_instructions = []

    async def _disconnect(self) -> None:
        self._held_instructions = []
        await super()._disconnect()


def build_gemini_live_service(
    *, api_key: str, model: str, system_prompt: str, voice: str
) -> AplisayGeminiLiveLLMService:
    """Construct the service for one session.

    ``model`` is the bare id from the row (``gemini-2.5-flash-native-audio-preview-12-2025``).
    No language is set: Google's Live API guide says native-audio models choose
    the language themselves and do not support a language code, so Pipecat's
    default stays and the system prompt is the way to pin one.
    """
    return AplisayGeminiLiveLLMService(
        api_key=api_key,
        settings=AplisayGeminiLiveLLMService.Settings(
            model=model if model.startswith("models/") else f"models/{model}",
            system_instruction=system_prompt,
            voice=voice,
        ),
    )
