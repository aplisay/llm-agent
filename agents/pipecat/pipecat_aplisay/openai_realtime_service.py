"""OpenAI Realtime with the platform's mid-call context injection.

Pipecat's ``OpenAIRealtimeLLMService`` seeds the server conversation once, from
the first context frame, and after that only sends newly completed tool
results. Its ``_handle_messages_append`` is a stub. So on the
``pipecat:openai/gpt-realtime`` row nothing the worker appended to the context
after the first reply reached OpenAI: the inactivity kick's developer message,
the in-place handover opening, and a following ``LLMRunFrame`` produced no
``response.create``. Keypad digits only reached the local context.

This subclass follows ``grok_service.AplisayGrokRealtimeLLMService``: each new
developer or system context message goes out as a ``system`` conversation item
and a response is requested. The seed still packs the history the stock way.
"""

from __future__ import annotations

from typing import Any, Optional

from loguru import logger
from pipecat.processors.aggregators.llm_context import LLMSpecificMessage
from pipecat.services.openai.realtime import events
from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService

from .grok import DTMF_MESSAGE


def _text_of(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if isinstance(content, list):
        parts = [
            part.get("text", "") for part in content
            if isinstance(part, dict) and part.get("type") in ("text", "input_text") and isinstance(part.get("text"), str)
        ]
        return "".join(parts).strip()
    return ""


class AplisayOpenAIRealtimeLLMService(OpenAIRealtimeLLMService):
    """``OpenAIRealtimeLLMService`` plus the platform's context injection."""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(**kwargs)
        # Context messages the server already has, in order. The seed packs
        # everything up to the first run into one item; later developer and
        # system messages are sent as they appear (see _handle_context).
        self._seen_messages: list = []
        # Items that arrived before the session was ready; sent on session.updated.
        self._pending_items: list[events.ConversationItem] = []
        self._responses_requested = 0

    # ---- items ------------------------------------------------------------

    @staticmethod
    def _text_item(role: str, text: str) -> events.ConversationItem:
        return events.ConversationItem(
            type="message",
            role="user" if role == "user" else "system",
            content=[events.ItemContent(type="input_text", text=text)],
        )

    async def _send_item(self, item: events.ConversationItem) -> None:
        # Marked as ours so the server's conversation.item.added echo is not
        # taken for the start of an assistant turn (see the stock service).
        self._messages_added_manually[item.id] = True
        await self.send_client_event(events.ConversationItemCreateEvent(item=item))

    async def _send_or_hold(self, item: events.ConversationItem) -> None:
        if self._api_session_ready:
            await self._send_item(item)
        else:
            self._pending_items.append(item)

    async def _handle_evt_session_updated(self, evt) -> None:  # noqa: ANN001
        # Held items go first, so the run they asked for follows them.
        pending, self._pending_items = self._pending_items, []
        for item in pending:
            await self._send_item(item)
        await super()._handle_evt_session_updated(evt)

    async def inject_dtmf(self, digits: str) -> None:
        """Keypad digits: a user message and a new response. The DTMF
        aggregator's TranscriptionFrame would only reach the local context."""
        item = self._text_item("user", DTMF_MESSAGE.format(digits=digits))
        if not self._api_session_ready:
            # Sent on session.updated. The first run, or the run below, answers it.
            self._pending_items.append(item)
            if self._context is not None:
                self._run_llm_when_api_session_ready = True
            return
        await self._send_item(item)
        if self._context is None:
            # No first turn yet: the digits are on the server and the first
            # run will answer them.
            return
        await self._create_response()

    # ---- conversation -----------------------------------------------------

    async def _create_response(self) -> None:
        self._responses_requested += 1
        seeding = self._llm_needs_conversation_setup
        await super()._create_response()
        if seeding and not self._llm_needs_conversation_setup:
            # The seed packed every message so far into the first item.
            assert self._context is not None
            self._seen_messages = list(self._context.get_messages())

    async def _handle_messages_append(self, frame) -> None:  # noqa: ANN001
        # The user aggregator has already added the messages to the context
        # and, when the frame runs the LLM, pushed the context frame that
        # _handle_context turns into items and a response.
        return

    def _item_for(self, message: Any) -> Optional[events.ConversationItem]:
        """A system item for an appended developer or system message. User
        messages are never resent: the aggregator adds one per transcribed
        user turn, and the server already holds that audio item. A message
        that repeats the session instructions (the in-place handover replaces
        the context with the new prompt first) is already on the server."""
        if isinstance(message, LLMSpecificMessage) or not isinstance(message, dict):
            return None
        if message.get("role") not in ("developer", "system") or message.get("tool_call_id"):
            return None
        text = _text_of(message.get("content"))
        if not text or text == (self._settings.system_instruction or "").strip():
            return None
        return self._text_item("system", text)

    def _new_messages(self, messages: list) -> list:
        seen = self._seen_messages
        if len(messages) >= len(seen) and all(a == b for a, b in zip(seen, messages)):
            return messages[len(seen):]
        # The context was replaced wholesale (the in-place handover): what is
        # there now is the new history.
        return list(messages)

    async def _handle_context(self, context) -> None:  # noqa: ANN001
        if self._context is None:
            await super()._handle_context(context)
            return
        self._context = context
        if self._llm_needs_conversation_setup:
            # The first run has not seeded the server yet; it packs the whole
            # context when it does.
            await self._process_completed_function_calls(send_new_results=True)
            return
        messages = list(context.get_messages())
        new = self._new_messages(messages)
        self._seen_messages = list(messages)
        sent = False
        caller_turn = False
        for message in new:
            if isinstance(message, dict) and message.get("role") == "user":
                caller_turn = True
                continue
            item = self._item_for(message)
            if item is None:
                continue
            await self._send_or_hold(item)
            sent = True
        before = self._responses_requested
        await self._process_completed_function_calls(send_new_results=True)
        # A context frame that carries the caller's own turn is answered by the
        # server VAD; asking again would collide with that response. Only a
        # platform-only update (the kick, the handover opening) asks for one.
        if sent and not caller_turn and self._responses_requested == before:
            await self._create_response()
        elif sent and caller_turn:
            logger.debug(f"{self}: platform message sent alongside a caller turn; the server's response covers it")


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
