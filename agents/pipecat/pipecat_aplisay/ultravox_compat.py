"""Compatibility shims for Pipecat's upstream ``UltravoxRealtimeLLMService``.

Two fixes live here today:

1. ``_receive_messages`` teardown race (original): upstream wraps its
   ``try/except`` around the loop *body* rather than the iteration itself, so
   when the WebRTC client hangs up before we cleanly close the Ultravox
   websocket the resulting ``ConnectionClosedError`` (the "sent 1000 (OK); no
   close frame received" form) bypasses the catch and lands in Pipecat's
   TaskManager as an "unexpected exception" ERROR line. Hoisting the try/except
   one level out makes the existing ``_disconnecting`` guard cover the iteration
   too.

2. NATIVE tool-result delivery (see ``deliver_native_tool_result`` and
   ``_handle_tool_invocation``): our data tools are registered
   ``cancel_on_interruption=False`` so the caller's trailing speech can't cancel
   the call mid-turn — but that puts Pipecat's Ultravox service on its
   *async-tool* path, which unfreezes the call with a placeholder and then
   delivers the true result as user-side TEXT. Ultravox does not treat that text
   as a function result, so the model loops (staging 2026-07-24: booking_get_slots
   re-called 4× on placeholder results it couldn't use). We suppress the
   placeholder and deliver the true result as a native ``client_tool_result``
   for the same invocation id instead.

This file is intended to shrink as upstream fixes land.
"""

from __future__ import annotations

import json
from typing import Any

from loguru import logger
from pipecat.services.llm_service import FunctionCallFromLLM
from pipecat.services.ultravox.llm import UltravoxRealtimeLLMService


class AplisayUltravoxRealtimeLLMService(UltravoxRealtimeLLMService):
    """Drop-in replacement: teardown-race fix + native tool-result delivery."""

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
        """Run the tool WITHOUT shipping the async "started" placeholder.

        Ultravox freezes the conversation between ``client_tool_invocation`` and
        the matching ``client_tool_result``. We WANT that freeze to hold for the
        (short) tool turn: ``deliver_native_tool_result`` sends the true result
        the instant the tool finishes, so the freeze ends with the real answer
        rather than a placeholder. Shipping the placeholder here would make IT
        the result Ultravox accepts, leaving our real result to arrive as an
        ignored second result / user text — the bug this shim removes.

        (Every tool we register as async on Ultravox is a data tool delivered
        natively; sync builtins never triggered the placeholder anyway, so
        dropping it unconditionally is safe.)
        """
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
