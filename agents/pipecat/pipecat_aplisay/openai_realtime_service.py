"""OpenAI Realtime with the platform's mid-call context injection. See PR #364.

Pipecat's ``OpenAIRealtimeLLMService`` seeds the server conversation once, from
the first context frame. After that it only sends newly completed tool
results, and its ``_handle_messages_append`` is a stub. So nothing the worker
appends to the context later reaches OpenAI.

This subclass follows ``grok_service.AplisayGrokRealtimeLLMService``. Each new
developer or system context message goes out as a ``system`` conversation item
and a response is requested. A replaced context (the in-place handover) starts
a new server conversation.
"""

from __future__ import annotations

from typing import Any, Literal, Optional

from loguru import logger
from pipecat.frames.frames import LLMFullResponseEndFrame, TTSStoppedFrame
from pipecat.services.openai.realtime import events
from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService

from .realtime_context import DTMF_MESSAGE, platform_message_text, text_of

#: OpenAI's refusal of a response.create while a response is active.
ACTIVE_RESPONSE_ERROR = "conversation_already_has_active_response"


class AplisayOpenAIRealtimeLLMService(OpenAIRealtimeLLMService):
    """``OpenAIRealtimeLLMService`` plus the platform's context injection."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # Context messages the server already has, in order (see _handle_context).
        self._seen_messages: list = []
        # Keypad digits pressed before the seed; sent after it (see inject_dtmf).
        self._held_items: list[events.ConversationItem] = []
        self._responses_requested = 0
        self._seeding = False
        # A response.create owed once the active response is done.
        self._response_pending = False
        # Function calls the current server conversation has issued.
        self._session_call_ids: set[str] = set()

    # ---- items ------------------------------------------------------------

    @staticmethod
    def _text_item(role: Literal["user", "system"], text: str) -> events.ConversationItem:
        return events.ConversationItem(
            type="message", role=role, content=[events.ItemContent(type="input_text", text=text)]
        )

    async def _send_item(self, item: events.ConversationItem) -> None:
        # Marked like the stock's own seed items; the server's echo is then dropped.
        self._messages_added_manually[item.id] = True
        await self.send_client_event(events.ConversationItemCreateEvent(item=item))

    async def inject_dtmf(self, digits: str) -> None:
        """Keypad digits: a user message and a new response. The DTMF
        aggregator's TranscriptionFrame would only reach the local context."""
        item = self._text_item("user", DTMF_MESSAGE.format(digits=digits))
        if self._llm_needs_conversation_setup:
            # The seed's packed history tells the model to act on its last
            # saved message, so digits sent before it would go unanswered.
            self._held_items.append(item)
            return
        await self._send_item(item)
        await self._create_response()

    # ---- responses --------------------------------------------------------

    async def _create_response(self) -> None:
        self._responses_requested += 1
        if self._seeding or self._current_assistant_response is not None:
            # OpenAI refuses a response.create while a response is active; it
            # is sent after that response's response.done instead.
            self._response_pending = True
            return
        seeding = (
            self._llm_needs_conversation_setup and self._api_session_ready and self._context is not None
        )
        # The seed packs the context as it is now; a message added during its
        # sends goes out on the next context frame.
        snapshot = list(self._context.get_messages()) if seeding else []
        self._seeding = seeding
        try:
            await super()._create_response()
        finally:
            self._seeding = False
        if not seeding or self._llm_needs_conversation_setup:
            return
        self._seen_messages = snapshot
        held, self._held_items = self._held_items, []
        for item in held:
            await self._send_item(item)
        if held:
            self._response_pending = True

    async def _handle_evt_response_done(self, evt) -> None:  # noqa: ANN001
        await super()._handle_evt_response_done(evt)
        if self._response_pending:
            self._response_pending = False
            await self._create_response()

    async def _maybe_handle_evt_retrieve_conversation_item_error(self, evt) -> bool:  # noqa: ANN001
        if getattr(evt.error, "code", None) == ACTIVE_RESPONSE_ERROR:
            # Our response.create lost the race with a server-VAD reply.
            self._response_pending = True
            logger.debug(f"{self}: response.create refused while a response is active; asking again after it")
            return True
        return await super()._maybe_handle_evt_retrieve_conversation_item_error(evt)

    async def _handle_evt_function_call_arguments_done(self, evt) -> None:  # noqa: ANN001
        self._session_call_ids.add(evt.call_id)
        await super()._handle_evt_function_call_arguments_done(evt)

    # ---- conversation -----------------------------------------------------

    def _new_messages(self, messages: list) -> Optional[list]:
        """The messages after the ones the server has, or None when the seen
        prefix no longer matches: the context was replaced."""
        seen = self._seen_messages
        if messages[: len(seen)] == seen:
            return messages[len(seen):]
        return None

    def _settings_behind(self, messages: list) -> bool:
        """The handover queues its settings update before the context
        replacement, but a transcript flush frame queued just before both can
        read the replaced context first. Its leading prompt is then not yet
        the session instructions; the run frame's own context frame follows."""
        first = messages[0] if messages else None
        if not isinstance(first, dict) or first.get("role") not in ("developer", "system"):
            return False
        return text_of(first.get("content")) != (self._settings.system_instruction or "").strip()

    async def _handle_context(self, context) -> None:  # noqa: ANN001
        if self._context is None or self._llm_needs_conversation_setup:
            # The first run seeds the server from the whole context; until
            # then the stock path only sends tool results.
            await super()._handle_context(context)
            return
        messages = list(context.get_messages())
        new = self._new_messages(messages)
        if new is None:
            if self._settings_behind(messages):
                return
            await self._restart_conversation(context)
            return
        self._context = context
        self._seen_messages = messages
        sent = False
        for message in new:
            text = platform_message_text(message)
            if text is None:
                continue
            await self._send_item(self._text_item("system", text))
            sent = True
        before = self._responses_requested
        await self._process_completed_function_calls(send_new_results=True)
        if sent and self._responses_requested == before:
            await self._create_response()

    async def _restart_conversation(self, context) -> None:  # noqa: ANN001
        """A new server conversation for a replaced context (the in-place
        handover). The outgoing agent's turns and open tool calls stay
        behind, so ``includeHistory`` holds, and the first run packs the new
        prompt and the opening the way a new call's greeting is packed."""
        if self._current_assistant_response is not None:
            # Close the outgoing agent's turn for the aggregators; its socket goes next.
            await self.push_frame(LLMFullResponseEndFrame())
            if self._is_modality_enabled("audio"):
                await self.push_frame(TTSStoppedFrame())
        old_calls, self._session_call_ids = self._session_call_ids, set()
        self._context = context
        self._seen_messages = []
        self._held_items = []
        self._response_pending = False
        self._current_assistant_response = None
        self._current_audio_response = None
        logger.info(f"{self}: context replaced; starting a new server conversation")
        await self.reset_conversation()
        # A late result for one of the old agent's calls belongs to the old conversation.
        self._completed_tool_calls |= old_calls
        await self._create_response()


def build_openai_realtime_service(
    *,
    api_key: str,
    model: str,
    system_prompt: str,
    session_properties: Any,
) -> AplisayOpenAIRealtimeLLMService:
    """Construct the service for one session."""
    return AplisayOpenAIRealtimeLLMService(
        api_key=api_key,
        settings=AplisayOpenAIRealtimeLLMService.Settings(
            model=model,
            system_instruction=system_prompt,
            session_properties=session_properties,
        ),
    )
