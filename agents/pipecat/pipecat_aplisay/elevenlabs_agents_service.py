"""The ElevenLabs Agents conversation as a Pipecat LLM service.

One conversation WebSocket per session: caller audio goes up as
``user_audio_chunk`` messages, the agent's speech comes back as ``audio``
events, and the text of each reply arrives whole (``agent_response``) with a
correction when the caller cuts it short (``agent_response_correction``).
The reply's text is pushed once the reply is over, so the transcript carries
what the caller heard, not what the model wrote. Tools are client tools:
``client_tool_call`` runs the platform's function and the result goes back
as ``client_tool_result``. See docs/elevenlabs-agents.md.

The platform speaks to the agent through user-side messages: the opening
instruction when there is no verbatim greeting, the inactivity kick and the
keypad digits. ElevenLabs echoes some of them back as a user transcript,
which is dropped here so the call's transcript shows the platform's own row.
"""

from __future__ import annotations

import asyncio
import base64
import json
from collections import deque
from typing import Any, Awaitable, Callable, Optional

from loguru import logger
from websockets.asyncio import client as websocket_client
from websockets.exceptions import ConnectionClosed

from pipecat.audio.utils import create_stream_resampler
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    InputTextRawFrame,
    InterruptionFrame,
    LLMContextFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMServiceMetadataFrame,
    LLMTextFrame,
    StartFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
    UserAudioRawFrame,
)
from pipecat.processors.aggregators import async_tool_messages
from pipecat.processors.aggregators.llm_context import LLMContext, LLMSpecificMessage
from pipecat.processors.frame_processor import FrameDirection
from pipecat.services.llm_service import FunctionCallFromLLM, LLMService
from pipecat.services.settings import LLMSettings
from pipecat.utils.time import time_now_iso8601

from . import elevenlabs_agents as el
from .elevenlabs_agents_client import ElevenLabsAgentsClient

#: Caller audio is sent in chunks of about this long, so the socket carries a
#: few messages a second rather than one per transport frame.
SEND_CHUNK_MS = 100

#: An interruption's correction normally arrives with it; a reply with no
#: correction after this long is closed with the text already known.
CORRECTION_GRACE_SECS = 0.5

#: ElevenLabs times a reply's playback, and so its ``agent_response_complete``,
#: against the caller audio it receives. While the greeting mute holds the
#: caller's frames back (or a transport sends none), the service sends silence
#: in their place, a chunk of this length whenever none has gone out for that long.
SILENCE_FILL_MS = 200

#: Injected texts remembered for echo suppression.
_ECHO_MEMORY = 8


def _rate_of(audio_format: Optional[str], default: int) -> int:
    """``pcm_24000`` -> 24000. Anything else keeps the default."""
    if isinstance(audio_format, str) and audio_format.startswith("pcm_"):
        try:
            return int(audio_format.split("_", 1)[1])
        except ValueError:
            return default
    return default


class ElevenLabsAgentsLLMService(LLMService):
    """A conversation against the hosted agent for this session's configuration."""

    def __init__(
        self,
        *,
        api_key: str,
        model_id: str,
        agent: dict,
        tool_schemas: list[dict],
        system_prompt: str,
        platform_opening: Optional[str] = None,
        max_duration_secs: Optional[int] = None,
        on_session_ended: Optional[Callable[[str], Awaitable[None]]] = None,
        client: Optional[ElevenLabsAgentsClient] = None,
        defer_initiation: bool = False,
        **kwargs: Any,
    ) -> None:
        llm = el.elevenlabs_llm(model_id)
        super().__init__(
            settings=LLMSettings(
                model=llm,
                system_instruction=system_prompt,
                temperature=None,
                max_tokens=None,
                top_p=None,
                top_k=None,
                frequency_penalty=None,
                presence_penalty=None,
                seed=None,
                filter_incomplete_user_turns=False,
                user_turn_completion_config=None,
            ),
            **kwargs,
        )
        self._client = client or ElevenLabsAgentsClient(api_key)
        self._config = el.agent_config(agent, llm=llm, tool_schemas=tool_schemas)
        first_message, opening = el.opening_plan(agent, platform_opening)
        self._overrides = el.conversation_overrides(
            agent, system_prompt=system_prompt, first_message=first_message, max_duration_secs=max_duration_secs
        )
        self._opening_message = opening
        self._on_session_ended = on_session_ended
        # The first message plays the moment the conversation is initiated, so
        # with ``defer_initiation`` the socket opens at start but the initiation
        # waits for begin_conversation(): the call session calls it once the
        # caller's media is up, or the greeting is spoken to nobody.
        self._defer_initiation = defer_initiation
        self._begun = False

        self._socket: Optional[websocket_client.ClientConnection] = None
        self._receive_task: Optional[asyncio.Task] = None
        self._disconnecting = False
        self._ended_reported = False
        self._ready = False
        self._pending: list[dict] = []
        self.agent_id: Optional[str] = None
        self.conversation_id: Optional[str] = None

        self._in_rate = el.INPUT_SAMPLE_RATE
        self._out_rate = el.OUTPUT_SAMPLE_RATE
        self._resampler = create_stream_resampler()
        self._send_buffer = bytearray()
        self._last_audio_sent = 0.0
        self._fill_task: Optional[asyncio.Task] = None

        # The reply being spoken (its event_id), the text of each reply by
        # event_id, and the close timers armed by an interruption.
        self._bot_responding: Optional[int] = None
        self._response_text: dict[int, str] = {}
        self._close_timers: dict[int, asyncio.Task] = {}
        self._last_user_id: str = ""
        self._completed_tool_calls: set[str] = set()
        self._injected: deque[str] = deque(maxlen=_ECHO_MEMORY)

    # ---- metadata -------------------------------------------------------------

    def service_metadata_frame(self) -> LLMServiceMetadataFrame:
        """Realtime service; the provider owns turn detection and sends no turn frames."""
        self._warn_if_realtime_service_emits_no_turn_frames(emits_turn_frames=False)
        return LLMServiceMetadataFrame(service_name=self.name, is_realtime_service=True)

    def can_generate_metrics(self) -> bool:
        return True

    @property
    def config(self) -> dict:
        """The hosted agent's configuration (tests and diagnostics)."""
        return self._config

    @property
    def overrides(self) -> dict:
        return self._overrides

    # ---- lifecycle ----------------------------------------------------------

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        try:
            self.agent_id, url = await self._client.conversation_url(self._config)
            self._socket = await websocket_client.connect(url, max_size=None)
            self._disconnecting = False
            self._receive_task = self.create_task(self._receive_messages())
            logger.bind(agent_id=self.agent_id, deferred=self._defer_initiation).info("ElevenLabs conversation opened")
            if not self._defer_initiation:
                await self.begin_conversation()
        except Exception as e:  # noqa: BLE001
            await self.push_error("Failed to start the ElevenLabs conversation", e, fatal=True)
            await self._session_ended(f"connect failed: {e}")

    async def begin_conversation(self) -> None:
        """Send the initiation (the overrides, and so the first message). Once;
        a call before the socket is open is honoured when it opens."""
        if self._begun:
            return
        self._defer_initiation = False
        if self._socket is None:
            return
        self._begun = True
        await self._send(el.initiation_message(self._overrides))

    @property
    def begun(self) -> bool:
        return self._begun

    async def stop(self, frame: EndFrame) -> None:
        await super().stop(frame)
        await self._disconnect()

    async def cancel(self, frame: CancelFrame) -> None:
        await super().cancel(frame)
        await self._disconnect()

    async def cleanup(self) -> None:
        await super().cleanup()
        await self._disconnect()

    async def _disconnect(self) -> None:
        self._disconnecting = True
        for timer in list(self._close_timers.values()):
            timer.cancel()
        self._close_timers.clear()
        if self._fill_task is not None:
            await self.cancel_task(self._fill_task)
            self._fill_task = None
        if self._receive_task is not None and self._receive_task is not asyncio.current_task():
            await self.cancel_task(self._receive_task)
            self._receive_task = None
        socket, self._socket = self._socket, None
        if socket is not None:
            try:
                await socket.close()
            except Exception as e:  # noqa: BLE001
                logger.debug(f"{self}: closing the ElevenLabs socket raised: {e}")

    async def _session_ended(self, reason: str) -> None:
        if self._ended_reported or self._disconnecting or self._on_session_ended is None:
            return
        self._ended_reported = True
        logger.bind(event="session_ended", reason=reason).warning(f"ElevenLabs conversation ended by the provider ({reason})")
        try:
            await self._on_session_ended(reason)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"{self}: on_session_ended raised: {e}")

    # ---- frames -----------------------------------------------------------------

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, LLMContextFrame):
            await self._handle_context(frame.context)
        elif isinstance(frame, InterruptionFrame):
            await self.stop_all_metrics()
            await self.push_frame(frame, direction)
        elif isinstance(frame, InputTextRawFrame):
            await self._send_user_message(frame.text)
            await self.push_frame(frame, direction)
        elif isinstance(frame, InputAudioRawFrame):
            await self._send_user_audio(frame)
            await self.push_frame(frame, direction)
        else:
            await self.push_frame(frame, direction)

    async def _handle_context(self, context: LLMContext) -> None:
        """The conversation lives on the ElevenLabs side; the only context
        the service forwards is a tool result not yet delivered (the
        synchronous builtins; data tools arrive natively, see
        :meth:`deliver_native_tool_result`)."""
        for message in context.get_messages():
            if isinstance(message, LLMSpecificMessage) or not isinstance(message, dict):
                continue
            if async_tool_messages.parse_message(message) is not None:
                # Data tools answer natively the moment they finish.
                continue
            if message.get("role") == "tool" and message.get("content") != "IN_PROGRESS":
                tool_call_id = message.get("tool_call_id")
                if tool_call_id and tool_call_id not in self._completed_tool_calls:
                    content = message.get("content")
                    result = content if isinstance(content, str) else "".join(
                        t.get("text", "") for t in content or [] if isinstance(t, dict)
                    )
                    self._completed_tool_calls.add(tool_call_id)
                    await self._send_tool_result(tool_call_id, result)

    async def deliver_native_tool_result(self, tool_call_id: str, result: Any) -> None:
        """A data tool's result, sent the moment it finishes (voice_session's
        tool runner calls this on success and on error). Idempotent."""
        if tool_call_id in self._completed_tool_calls:
            return
        self._completed_tool_calls.add(tool_call_id)
        payload = result if isinstance(result, str) else json.dumps(result, default=str, ensure_ascii=False)
        is_error = isinstance(result, dict) and set(result.keys()) == {"error"}
        await self._send_tool_result(tool_call_id, payload, is_error=is_error)

    async def _send_tool_result(self, tool_call_id: str, result: str, *, is_error: bool = False) -> None:
        await self._send({"type": "client_tool_result", "tool_call_id": tool_call_id, "result": result, "is_error": is_error})

    async def _send_user_audio(self, frame: InputAudioRawFrame) -> None:
        if self._socket is None or not self._begun:
            return
        self._last_user_id = frame.user_id if isinstance(frame, UserAudioRawFrame) else ""
        audio = frame.audio
        if frame.sample_rate != self._in_rate:
            audio = await self._resampler.resample(audio, frame.sample_rate, self._in_rate)
        self._send_buffer.extend(audio)
        chunk_bytes = int(self._in_rate * 2 * SEND_CHUNK_MS / 1000)
        while len(self._send_buffer) >= chunk_bytes:
            chunk = bytes(self._send_buffer[:chunk_bytes])
            del self._send_buffer[:chunk_bytes]
            await self._send_audio_chunk(chunk)

    async def _send_audio_chunk(self, chunk: bytes) -> None:
        self._last_audio_sent = asyncio.get_running_loop().time()
        await self._send({"user_audio_chunk": base64.b64encode(chunk).decode("ascii")})

    async def _fill_silence(self) -> None:
        """Send silence whenever no caller audio has gone out for SILENCE_FILL_MS."""
        interval = SILENCE_FILL_MS / 1000
        chunk = b"\x00" * int(self._in_rate * 2 * SILENCE_FILL_MS / 1000)
        while self._socket is not None and not self._disconnecting:
            await asyncio.sleep(interval)
            if asyncio.get_running_loop().time() - self._last_audio_sent >= interval:
                await self._send_audio_chunk(chunk)

    # ---- what the platform says to the agent -----------------------------------

    async def _send_user_message(self, text: str, *, source_medium: Optional[str] = None) -> None:
        text = (text or "").strip()
        if not text:
            return
        message: dict = {"type": "user_message", "text": text}
        if source_medium:
            message["source_medium"] = source_medium
        self._injected.append(text)
        if not self._ready:
            self._pending.append(message)
            return
        await self._send(message)

    async def inject_dtmf(self, digits: str) -> None:
        """Keypad digits as ElevenLabs's own DTMF input."""
        await self._send_user_message(digits, source_medium="dtmf")

    async def inject_inactivity_prompt(self, message: str) -> None:
        """The inactivity kick: an instruction to say the configured message."""
        await self._send_user_message(el.inactivity_message(message))

    # ---- the socket ---------------------------------------------------------------

    async def _send(self, message: dict) -> None:
        socket = self._socket
        if socket is None:
            return
        try:
            await socket.send(json.dumps(message))
        except ConnectionClosed:
            if not self._disconnecting:
                logger.debug(f"{self}: send on a closed ElevenLabs socket")

    async def _receive_messages(self) -> None:
        socket = self._socket
        if socket is None:
            return
        reason = "connection_closed"
        try:
            async for raw in socket:
                if isinstance(raw, bytes):
                    continue
                try:
                    message = json.loads(raw)
                except ValueError:
                    logger.debug(f"{self}: ignoring a non-JSON ElevenLabs message")
                    continue
                await self._handle_message(message)
        except ConnectionClosed as e:
            reason = f"connection_closed: {getattr(e, 'rcvd', None) or e}"
        except Exception as e:  # noqa: BLE001
            if self._disconnecting or self._socket is None:
                return
            await self.push_error("ElevenLabs websocket receive error", e, fatal=True)
            reason = f"receive error: {e}"
        if self._disconnecting:
            return
        if self._bot_responding is not None:
            await self._end_response(self._bot_responding)
        await self._session_ended(reason)

    async def _handle_message(self, message: dict) -> None:
        kind = message.get("type")
        if kind == "audio":
            await self._handle_audio(message.get("audio_event") or {})
        elif kind == "ping":
            event_id = (message.get("ping_event") or {}).get("event_id")
            await self._send({"type": "pong", "event_id": event_id})
        elif kind == "agent_response":
            ev = message.get("agent_response_event") or {}
            event_id = ev.get("event_id")
            if event_id is not None:
                self._response_text[int(event_id)] = str(ev.get("agent_response") or "")
        elif kind == "agent_response_correction":
            ev = message.get("agent_response_correction_event") or {}
            event_id = ev.get("event_id")
            if event_id is not None:
                self._response_text[int(event_id)] = str(ev.get("corrected_agent_response") or "")
                await self._end_response(int(event_id))
        elif kind == "agent_response_complete":
            ev = message.get("agent_response_complete_event") or {}
            event_id = ev.get("event_id")
            if event_id is not None:
                await self._end_response(int(event_id))
        elif kind == "user_transcript":
            ev = message.get("user_transcription_event") or {}
            await self._handle_user_transcript(str(ev.get("user_transcript") or ""))
        elif kind == "interruption":
            await self._handle_interruption()
        elif kind == "client_tool_call":
            await self._handle_tool_call(message.get("client_tool_call") or {})
        elif kind == "conversation_initiation_metadata":
            await self._handle_initiation(message.get("conversation_initiation_metadata_event") or {})
        elif kind == "agent_tool_response":
            ev = message.get("agent_tool_response") or {}
            logger.bind(tool=ev.get("tool_name"), status=ev.get("status")).debug("ElevenLabs tool response")
        elif kind == "client_error":
            ev = message.get("error_event") or {}
            logger.bind(code=ev.get("code"), error=ev.get("error_name")).warning(
                f"ElevenLabs client error: {ev.get('message')}"
            )
        elif kind in ("vad_score", "internal_turn_probability", "internal_tentative_agent_response"):
            pass
        else:
            logger.debug(f"{self}: unhandled ElevenLabs message {kind!r}")

    async def _handle_initiation(self, ev: dict) -> None:
        self.conversation_id = ev.get("conversation_id")
        self._out_rate = _rate_of(ev.get("agent_output_audio_format"), el.OUTPUT_SAMPLE_RATE)
        self._in_rate = _rate_of(ev.get("user_input_audio_format"), el.INPUT_SAMPLE_RATE)
        self._ready = True
        logger.bind(conversation_id=self.conversation_id, out_rate=self._out_rate, in_rate=self._in_rate).info(
            "ElevenLabs conversation ready"
        )
        if self._fill_task is None and self._socket is not None:
            self._last_audio_sent = asyncio.get_running_loop().time()
            self._fill_task = self.create_task(self._fill_silence())
        if self._opening_message:
            await self._send_user_message(self._opening_message)
            self._opening_message = None
        pending, self._pending = self._pending, []
        for message in pending:
            await self._send(message)

    async def _handle_audio(self, ev: dict) -> None:
        data = ev.get("audio_base_64")
        if not data:
            return
        audio = base64.b64decode(data)
        event_id = ev.get("event_id")
        event_id = int(event_id) if event_id is not None else -1
        if self._bot_responding is not None and self._bot_responding != event_id:
            await self._end_response(self._bot_responding)
        if self._bot_responding is None:
            await self._begin_response(event_id)
        await self.push_frame(TTSAudioRawFrame(audio, self._out_rate, 1))

    async def _begin_response(self, event_id: int) -> None:
        await self.start_processing_metrics()
        await self.stop_ttfb_metrics()
        await self.push_frame(LLMFullResponseStartFrame())
        await self.push_frame(TTSStartedFrame())
        self._bot_responding = event_id

    async def _end_response(self, event_id: int) -> None:
        """Close the reply ``event_id``: its text (the corrected text after an
        interruption) as one LLMTextFrame, then the end frames. A reply that
        never produced audio (a text-only turn) still gets its text."""
        timer = self._close_timers.pop(event_id, None)
        if timer is not None and timer is not asyncio.current_task():
            timer.cancel()
        text = el.strip_audio_tags(self._response_text.pop(event_id, ""))
        if self._bot_responding == event_id:
            if text:
                await self.push_frame(LLMTextFrame(text=text))
            await self.push_frame(TTSStoppedFrame())
            await self.push_frame(LLMFullResponseEndFrame())
            await self.stop_processing_metrics()
            self._bot_responding = None
        elif text:
            await self.push_frame(LLMFullResponseStartFrame())
            await self.push_frame(LLMTextFrame(text=text))
            await self.push_frame(LLMFullResponseEndFrame())

    async def _handle_interruption(self) -> None:
        """The caller spoke over the agent: clear what the transport holds and
        close the reply once its correction has arrived."""
        await self.broadcast_interruption()
        event_id = self._bot_responding
        if event_id is None:
            return
        if event_id in self._close_timers:
            return

        async def close_later() -> None:
            await asyncio.sleep(CORRECTION_GRACE_SECS)
            await self._end_response(event_id)

        self._close_timers[event_id] = self.create_task(close_later())

    async def _handle_user_transcript(self, text: str) -> None:
        text = text.strip()
        if not text:
            return
        if text in self._injected:
            # The platform's own message echoed back; the call log has its row already.
            self._injected.remove(text)
            return
        await self.push_frame(
            TranscriptionFrame(user_id=self._last_user_id, timestamp=time_now_iso8601(), result=text, text=text),
            FrameDirection.UPSTREAM,
        )

    async def _handle_tool_call(self, call: dict) -> None:
        name = call.get("tool_name")
        tool_call_id = call.get("tool_call_id")
        if not name or not tool_call_id:
            return
        parameters = call.get("parameters")
        await self.run_function_calls(
            [
                FunctionCallFromLLM(
                    function_name=str(name),
                    tool_call_id=str(tool_call_id),
                    arguments=parameters if isinstance(parameters, dict) else {},
                    context=None,
                )
            ]
        )


def build_elevenlabs_agents_service(
    *,
    api_key: str,
    model_id: str,
    agent: dict,
    tool_schemas: list[dict],
    system_prompt: str,
    platform_opening: Optional[str] = None,
    max_duration_secs: Optional[int] = None,
    on_session_ended: Optional[Callable[[str], Awaitable[None]]] = None,
    defer_initiation: bool = False,
) -> ElevenLabsAgentsLLMService:
    """Construct the service for one session."""
    return ElevenLabsAgentsLLMService(
        api_key=api_key,
        model_id=model_id,
        agent=agent,
        tool_schemas=tool_schemas,
        system_prompt=system_prompt,
        platform_opening=platform_opening,
        max_duration_secs=max_duration_secs,
        on_session_ended=on_session_ended,
        defer_initiation=defer_initiation,
    )
