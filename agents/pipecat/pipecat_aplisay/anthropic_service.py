"""``AnthropicLLMService`` that reports the token counts Anthropic reports.

Pipecat adds the ``message_delta`` usage to the ``message_start`` usage, but
the ``message_delta`` counts are cumulative, so the stock service reports every
input token twice (still upstream on pipecat main, 2026-09-16). See PR #346.
"""

from __future__ import annotations

from typing import Any

from pipecat.services.anthropic.llm import AnthropicLLMService


class AplisayAnthropicLLMService(AnthropicLLMService):
    """Report the final cumulative ``message_delta`` counts instead of Pipecat's sums."""

    _final_usage: Any = None

    async def _create_message_stream(self, api_call, params):
        self._final_usage = None
        return self._keep_final_usage(await super()._create_message_stream(api_call, params))

    async def _keep_final_usage(self, stream):
        async for event in stream:
            if event.type == "message_delta":
                self._final_usage = event.usage
            yield event

    async def _report_usage_metrics(
        self,
        prompt_tokens: int,
        completion_tokens: int,
        cache_creation_input_tokens: int,
        cache_read_input_tokens: int,
    ):
        # Without a message_delta (an interrupted stream) Pipecat's counts come from message_start alone.
        final, self._final_usage = self._final_usage, None
        if final is not None and final.input_tokens is not None:
            prompt_tokens = final.input_tokens
            completion_tokens = final.output_tokens
        await super()._report_usage_metrics(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            cache_creation_input_tokens=cache_creation_input_tokens,
            cache_read_input_tokens=cache_read_input_tokens,
        )
