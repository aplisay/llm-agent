"""Upstream compatibility for teardown, native tool results, timeouts and text transcripts; remove overrides as fixes
land. See PRs #115, #169, #176 and #305."""

from __future__ import annotations

import json
from typing import Any

from loguru import logger
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import LLMFullResponseEndFrame, LLMFullResponseStartFrame, LLMTextFrame
from pipecat.services.llm_service import FunctionCallFromLLM
from pipecat.services.ultravox.llm import UltravoxRealtimeLLMService

# Ultravox's client-tool execution window (protobuf Duration string, 40s max).
# 10s clears our slowest data tools (booking_book ≈ 4s, MCP knowledge search)
# with margin, while still bounding how long a wedged tool can freeze the
# conversation. Ultravox delivers results the moment they arrive — a generous
# ceiling adds no latency to the common fast path.
ULTRAVOX_TOOL_TIMEOUT = "10s"


class AplisayUltravoxRealtimeLLMService(UltravoxRealtimeLLMService):
    """Drop-in replacement: teardown-race fix + native tool-result delivery +
    explicit tool timeouts + exact text-medium transcript streaming."""

    #: Text already pushed as LLMTextFrames for the agent turn in progress
    #: (text medium only). Compared against Ultravox's ``text`` snapshots so a
    #: snapshot is never spoken twice and a snapshot-only turn is spoken once.
    _text_turn_streamed: str = ""

    async def _handle_agent_transcript(
        self, medium: str, text: str | None, delta: str | None, final: bool
    ) -> None:
        """Voice medium: upstream's behaviour. Text medium: push exactly the
        text that has not been pushed yet for this turn, then upstream's
        end-of-turn handling on ``final``.

        A non-final frame carries either a ``delta`` (push it) or a ``text``
        snapshot of the turn so far (push the part beyond what was streamed).
        A final frame carries the whole turn as ``text``: push whatever of it
        is still unspoken (the whole greeting, or nothing after a fully
        streamed turn), then close the response. A snapshot that does not
        extend what was streamed (Ultravox truncated the turn on a barge-in)
        pushes nothing.
        """
        if medium != "text":
            await super()._handle_agent_transcript(medium, text, delta, final)
            return

        chunk = ""
        if text is not None:
            if text.startswith(self._text_turn_streamed):
                chunk = text[len(self._text_turn_streamed):]
        elif delta:
            chunk = delta

        if chunk:
            if not self._bot_responding:
                await self.start_processing_metrics()
                await self.stop_ttfb_metrics()
                await self.push_frame(LLMFullResponseStartFrame())
                self._bot_responding = "text"
            self._text_turn_streamed += chunk
            await self.push_frame(LLMTextFrame(text=chunk))

        if final:
            self._text_turn_streamed = ""
            if self._bot_responding:
                await self.stop_processing_metrics()
                await self.push_frame(LLMFullResponseEndFrame())
                self._bot_responding = None

    def _to_selected_tools(self, tool: ToolsSchema) -> list[dict[str, Any]]:
        """Upstream's mapping, plus an explicit ``timeout`` on every
        ``temporaryTool`` so slow-but-healthy data tools aren't cut off at
        Ultravox's 2.5s default (which discards the late result and makes the
        model retry — duplicate side effects for non-idempotent tools)."""
        selected = super()._to_selected_tools(tool)
        for entry in selected:
            temporary = entry.get("temporaryTool")
            if isinstance(temporary, dict):
                temporary.setdefault("timeout", ULTRAVOX_TOOL_TIMEOUT)
        return selected

    async def deliver_native_tool_result(self, tool_call_id: str, result: Any) -> None:
        """Send a REAL native ``client_tool_result`` for a data tool the instant
        it finishes, and mark the call complete so the base async-tool path never
        also injects the result as user-side text.

        Called from ``voice_session._runner`` (the single tool choke point) on
        both success and error. Idempotent: a second call for the same
        invocation (or a racing ``_handle_context``) is a no-op, so exactly one
        ``client_tool_result`` reaches Ultravox per invocation — the true one.
        """
        if tool_call_id in self._completed_tool_calls:
            return
        payload = result if isinstance(result, str) else json.dumps(result, default=str, ensure_ascii=False)
        # Mark complete BEFORE the await so a concurrent _handle_context (its
        # async-final branch dedupes on _completed_tool_calls) can never race in
        # a duplicate user-text delivery.
        self._completed_tool_calls.add(tool_call_id)
        await self._send_tool_result(tool_call_id, payload)

    async def _handle_tool_invocation(self, tool_name: str, invocation_id: str, parameters: dict) -> None:
        """Suppress the async placeholder: Ultravox accepts one native result per invocation, so it must be the real answer.
        See PR #169."""
        await self.run_function_calls(
            [
                FunctionCallFromLLM(
                    function_name=tool_name,
                    tool_call_id=invocation_id,
                    arguments=parameters,
                    context=None,
                )
            ]
        )

    async def _receive_messages(self) -> None:
        if not self._socket:
            return
        try:
            async for message in self._socket:
                if isinstance(message, bytes):
                    await self._handle_audio(message)
                    continue

                data = json.loads(message)
                match data.get("type"):
                    case "state":
                        if self._bot_responding and data.get("state") != "speaking":
                            await self._handle_response_end()
                    case "playback_clear_buffer":
                        # The caller interrupted the agent. Same as upstream:
                        # broadcast an InterruptionFrame so the assistant
                        # aggregator marks the turn interrupted (upstream) and
                        # the output transport, plus any external TTS stage,
                        # clears what it holds (downstream).
                        await self.broadcast_interruption()
                    case "client_tool_invocation":
                        await self._handle_tool_invocation(
                            data.get("toolName"),
                            data.get("invocationId"),
                            data.get("parameters"),
                        )
                    case "transcript":
                        match data.get("role"):
                            case "user":
                                if not data.get("final"):
                                    logger.warning(
                                        "Unexpected non-final user transcript from Ultravox Realtime; ignoring."
                                    )
                                else:
                                    await self._handle_user_transcript(data.get("text"))
                            case "agent":
                                await self._handle_agent_transcript(
                                    data.get("medium"),
                                    data.get("text"),
                                    data.get("delta"),
                                    data.get("final", False),
                                )
                            case _:
                                logger.debug(
                                    f"Received transcript with unknown role from Ultravox Realtime: {data}"
                                )
                    case _:
                        logger.debug(f"Received unhandled Ultravox message: {data}")
        except Exception as e:
            if self._disconnecting or not self._socket:
                return
            await self.push_error("Ultravox websocket receive error", e, fatal=True)
