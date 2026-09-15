"""The Pipecat side of the Grok voice row: a subclass of upstream's
``GrokRealtimeLLMService`` with the platform's injection paths, the
``vendorSpecific`` merge and provider-close handling.

Why a subclass rather than event handlers:

- Nothing appended to the context after the first turn reaches the model in
  the stock service (``_handle_messages_append`` only logs a warning and
  ``_handle_context`` sends tool results only). The greeting instructions,
  the handover opening and keypad digits need their own path.
- ``greeting.text`` and the inactivity message are spoken through xAI's
  ``force_message`` item, marked uninterruptible, which the typed item model
  cannot express; it is sent as a raw dict.
- ``vendorSpecific.xai.session`` has to land inside every ``session.update``,
  which upstream builds from a typed model that drops unknown keys; the
  overrides are merged into the payload on the way out.
- The session's ``audio.input.format`` is only filled in by upstream when the
  whole input block is absent, and the block is present here because it
  carries the transcription request; without the format the server assumes
  24 kHz and a 16 kHz SIP leg is misread.
- The transcription ``completed`` event arrives several times per utterance
  with ``status: in_progress`` (one final ``completed``), and upstream's event
  model drops ``status``, so every interim would become a final transcript
  and a separate user message. The event model is widened and the interims
  are pushed as interim frames.
- A server close (the concurrent-session limit, an error) leaves the stock
  service silent on a live call; here it ends the call cleanly.

The option mappings are in :mod:`pipecat_aplisay.grok`.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Optional, cast

from loguru import logger
from pipecat.frames.frames import InterimTranscriptionFrame
from pipecat.processors.aggregators.llm_context import LLMSpecificMessage
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.xai.realtime import events
from pipecat.services.xai.realtime.llm import GrokRealtimeLLMService
from pipecat.utils.time import time_now_iso8601

from . import grok
from .grok import merged_session, strip_server_tools

#: Longest an injection waits for ``session.updated`` before giving up.
SESSION_READY_TIMEOUT_SECS = 10.0


class _TranscriptionCompleted(events.ConversationItemInputAudioTranscriptionCompleted):
    """The completed event with the ``status`` xAI sends and upstream drops."""

    status: Optional[str] = None


# Widen the parser's model for this one event so the subclass can tell the
# interim ``completed`` events (status in_progress) from the final one.
events._server_event_types["conversation.item.input_audio_transcription.completed"] = _TranscriptionCompleted


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


class AplisayGrokRealtimeLLMService(GrokRealtimeLLMService):
    """``GrokRealtimeLLMService`` plus the platform's session controls."""

    def __init__(
        self,
        *,
        vendor_session: Optional[dict] = None,
        on_session_ended: Optional[Callable[[str], Awaitable[None]]] = None,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._vendor_session = strip_server_tools(vendor_session or {})
        self._on_session_ended = on_session_ended
        # Context messages already delivered to the server, by position: the
        # seed sends everything up to the first turn, later system messages
        # are sent as they appear (see _handle_context).
        self._sent_messages = 0
        # Set by the greeting wiring: seed the conversation on the first run
        # but do not ask the model to speak (a forced greeting speaks instead).
        self._hold_first_response = False
        self._responses_requested = 0
        self._ended_reported = False

    # ---- session shape --------------------------------------------------

    def _ensure_audio_config(self, input_sample_rate: int, output_sample_rate: int) -> None:
        super()._ensure_audio_config(input_sample_rate, output_sample_rate)
        props = self._settings.session_properties
        audio = getattr(props, "audio", None)
        if audio is not None and audio.input is not None and audio.input.format is None:
            audio.input.format = events.PCMAudioFormat(
                rate=cast(events.SUPPORTED_SAMPLE_RATES, input_sample_rate)
            )

    async def send_client_event(self, event: events.ClientEvent) -> None:
        """Upstream's send, with ``vendorSpecific.xai.session`` merged into
        every ``session.update`` so an explicit value there wins."""
        if isinstance(event, events.SessionUpdateEvent) and self._vendor_session:
            payload = event.model_dump(exclude_none=True)
            payload["session"] = merged_session(payload.get("session") or {}, self._vendor_session)
            await self._ws_send(payload)
            return
        await super().send_client_event(event)

    # ---- injection --------------------------------------------------------

    async def _wait_until_ready(self) -> None:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + SESSION_READY_TIMEOUT_SECS
        while not self._api_session_ready:
            if loop.time() > deadline:
                raise RuntimeError("Grok session did not become ready in time")
            await asyncio.sleep(0.05)

    async def speak_verbatim(self, text: str) -> None:
        """Speak ``text`` exactly, uninterruptible, without the model: xAI's
        ``force_message`` item (the greeting text and the inactivity kick)."""
        text = (text or "").strip()
        if not text:
            return
        await self._wait_until_ready()
        logger.bind(event="verbatim", chars=len(text)).info("Grok: speaking a fixed line verbatim")
        await self._ws_send(
            {
                "type": "conversation.item.create",
                "item": {
                    "type": "force_message",
                    "role": "assistant",
                    "content": [{"type": "text", "text": text}],
                    "interruptible": False,
                },
            }
        )

    def hold_first_response(self) -> None:
        """The first run seeds the conversation and sends the session update
        with the tools, but does not ask the model to speak."""
        self._hold_first_response = True

    async def _send_text_item(self, role: str, text: str) -> None:
        item = events.ConversationItem(
            type="message",
            role="user" if role == "user" else "system",
            content=[events.ItemContent(type="input_text", text=text)],
        )
        event = events.ConversationItemCreateEvent(item=item)
        self._messages_added_manually[item.id] = True
        await self.send_client_event(event)

    async def inject_dtmf(self, digits: str) -> None:
        """Keypad digits: a user message and a new response."""
        if not self._api_session_ready:
            logger.debug(f"{self}: dropping DTMF {digits!r}; the session is not ready")
            return
        await self._send_text_item("user", grok.DTMF_MESSAGE.format(digits=digits))
        if self._context is None:
            # No first turn yet: the digits are on the server and the first
            # run will answer them.
            return
        await self._create_response()

    # ---- conversation ---------------------------------------------------

    async def _seed_conversation(self) -> None:
        """Upstream's first-run setup without the response: the packed history
        as items, then the session update that carries the context's tools."""
        assert self._context is not None
        adapter = self.get_llm_adapter()
        params = adapter.get_llm_invocation_params(self._context)
        for item in params["messages"]:
            event = events.ConversationItemCreateEvent(item=item)
            self._messages_added_manually[event.item.id] = True
            await self.send_client_event(event)
        await self._send_session_update()
        self._llm_needs_conversation_setup = False
        self._sent_messages = len(list(self._context.get_messages()))

    async def _create_response(self) -> None:
        self._responses_requested += 1
        if not self._api_session_ready:
            self._run_llm_when_api_session_ready = True
            return
        assert self._context is not None
        if self._llm_needs_conversation_setup:
            await self._seed_conversation()
        if self._hold_first_response:
            self._hold_first_response = False
            logger.debug(f"{self}: conversation seeded; the forced greeting speaks first")
            return
        await super()._create_response()

    async def _handle_messages_append(self, frame) -> None:  # noqa: ANN001
        # The user aggregator has already added the messages to the context
        # and, when the frame runs the LLM, pushed the context frame that
        # _handle_context turns into items and a response.
        return

    @staticmethod
    def _item_for(message: Any) -> Optional[events.ConversationItem]:
        """A system item for an appended developer or system message. User
        messages are never resent: the aggregator adds one per transcribed
        user turn, and the server already holds that audio item."""
        if isinstance(message, LLMSpecificMessage) or not isinstance(message, dict):
            return None
        if message.get("role") not in ("developer", "system") or message.get("tool_call_id"):
            return None
        text = _text_of(message.get("content"))
        if not text:
            return None
        return events.ConversationItem(
            type="message", role="system", content=[events.ItemContent(type="input_text", text=text)]
        )

    async def _handle_context(self, context) -> None:  # noqa: ANN001
        if self._context is None:
            self._context = context
            await self._process_completed_function_calls(send_new_results=False)
            await self._create_response()
            return
        self._context = context
        messages = list(context.get_messages())
        if self._sent_messages > len(messages):
            # The context was replaced wholesale; what is left is the new history.
            self._sent_messages = len(messages)
        new = messages[self._sent_messages:]
        self._sent_messages = len(messages)
        run = False
        if not self._llm_needs_conversation_setup:
            for message in new:
                item = self._item_for(message)
                if item is None:
                    continue
                event = events.ConversationItemCreateEvent(item=item)
                self._messages_added_manually[item.id] = True
                await self.send_client_event(event)
                run = True
        before = self._responses_requested
        await self._process_completed_function_calls(send_new_results=True)
        if run and self._responses_requested == before:
            await self._create_response()

    # ---- inbound events ---------------------------------------------------

    async def _handle_evt_input_audio_transcription_completed(self, evt) -> None:  # noqa: ANN001
        if getattr(evt, "status", None) == "in_progress":
            transcript = (evt.transcript or "").strip()
            if transcript:
                await self.push_frame(
                    InterimTranscriptionFrame(transcript, "", time_now_iso8601(), result=evt),
                    FrameDirection.UPSTREAM,
                )
            return
        await super()._handle_evt_input_audio_transcription_completed(evt)

    async def _handle_evt_response_done(self, evt) -> None:  # noqa: ANN001
        await super()._handle_evt_response_done(evt)
        status = getattr(evt.response, "status", None)
        if status == "failed":
            details = getattr(evt.response, "status_details", None)
            error = details.get("error") if isinstance(details, dict) else None
            code = error.get("code") if isinstance(error, dict) else None
            message = error.get("message") if isinstance(error, dict) else str(details)
            # Over the account's concurrent-session limit the first event is
            # this failed response, then the server closes the socket.
            if code == "rate_limit_exceeded":
                await self._session_ended(f"rate_limit_exceeded: {message}")

    async def _handle_evt_error(self, evt) -> None:  # noqa: ANN001
        # The receive loop returns after a fatal error, so the session is over.
        await super()._handle_evt_error(evt)
        await self._session_ended(f"error: {getattr(evt.error, 'message', '')}")

    async def _receive_task_handler(self) -> None:
        await super()._receive_task_handler()
        if not self._disconnecting:
            await self._session_ended("connection_closed")

    async def _session_ended(self, reason: str) -> None:
        if self._ended_reported or self._disconnecting or self._on_session_ended is None:
            return
        self._ended_reported = True
        logger.bind(event="session_ended", reason=reason).warning(f"Grok session ended by the provider ({reason})")
        try:
            await self._on_session_ended(reason)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"{self}: on_session_ended raised: {e}")


def build_grok_service(
    *,
    api_key: str,
    model: str,
    system_prompt: str,
    session_properties: Any,
    agent: dict,
    on_session_ended: Optional[Callable[[str], Awaitable[None]]] = None,
) -> AplisayGrokRealtimeLLMService:
    """Construct the service for one session."""
    return AplisayGrokRealtimeLLMService(
        api_key=api_key,
        settings=AplisayGrokRealtimeLLMService.Settings(
            model=model,
            system_instruction=system_prompt,
            session_properties=session_properties,
        ),
        vendor_session=grok.xai_session_overrides(agent),
        on_session_ended=on_session_ended,
    )
