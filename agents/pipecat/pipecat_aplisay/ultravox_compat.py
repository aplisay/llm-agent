"""Compatibility shims for Pipecat's upstream ``UltravoxRealtimeLLMService``.

There is exactly one bug fix here today: the upstream ``_receive_messages``
wraps its ``try/except`` around the loop *body* rather than the iteration
itself, so when the WebRTC client hangs up before we cleanly close the
Ultravox websocket the resulting ``ConnectionClosedError`` (the "sent 1000
(OK); no close frame received" form) bypasses the catch entirely and lands
in Pipecat's TaskManager as an "unexpected exception" ERROR line.

Hoisting the try/except one level out makes the existing ``_disconnecting``
guard cover the iteration too, and as a side effect collapses the per-message
catch into a single uniform handler. The fatal-dispatch path is unchanged in
practice: dispatch failures already used ``push_error(..., fatal=True)``,
which tears the pipeline down, so the previous "stay in the loop after a
fatal error" behaviour was effectively dead code.

This file is intended to evaporate the moment the upstream fix lands.
"""

from __future__ import annotations

import json

from loguru import logger
from pipecat.services.ultravox.llm import UltravoxRealtimeLLMService


class AplisayUltravoxRealtimeLLMService(UltravoxRealtimeLLMService):
    """Drop-in replacement that silences the teardown-race ERROR line."""

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
