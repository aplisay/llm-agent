"""The Anthropic service reports the token counts in Anthropic's stream, not
Pipecat's sum of the ``message_start`` and cumulative ``message_delta`` counts.

Drives Pipecat's real ``_process_context`` over a canned event stream. The
counts are from live ``claude-sonnet-4-5`` streams on 2026-09-16.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from anthropic.types.beta import (
    BetaRawContentBlockDeltaEvent,
    BetaRawContentBlockStartEvent,
    BetaRawContentBlockStopEvent,
    BetaRawMessageDeltaEvent,
    BetaRawMessageStartEvent,
    BetaRawMessageStopEvent,
)
from pipecat.processors.aggregators.llm_context import LLMContext

from pipecat_aplisay.anthropic_service import AplisayAnthropicLLMService


def _start(usage: dict) -> BetaRawMessageStartEvent:
    message = {
        "id": "msg_1",
        "type": "message",
        "role": "assistant",
        "model": "claude-sonnet-4-5",
        "content": [],
        "stop_reason": None,
        "stop_sequence": None,
        "usage": usage,
    }
    return BetaRawMessageStartEvent.model_validate({"type": "message_start", "message": message})


def _text_block() -> list:
    return [
        BetaRawContentBlockStartEvent.model_validate(
            {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}
        ),
        BetaRawContentBlockDeltaEvent.model_validate(
            {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "OK"}}
        ),
        BetaRawContentBlockStopEvent.model_validate({"type": "content_block_stop", "index": 0}),
    ]


def _end(usage: dict) -> list:
    return [
        BetaRawMessageDeltaEvent.model_validate(
            {"type": "message_delta", "delta": {"stop_reason": "end_turn", "stop_sequence": None}, "usage": usage}
        ),
        BetaRawMessageStopEvent.model_validate({"type": "message_stop"}),
    ]


def _run(events: list, *, interrupt: bool = False) -> list:
    async def stream():
        for event in events:
            yield event
        if interrupt:
            raise asyncio.CancelledError

    async def create(**_params):
        return stream()

    client = SimpleNamespace(beta=SimpleNamespace(messages=SimpleNamespace(create=create)))
    service = AplisayAnthropicLLMService(
        api_key="test",
        client=client,
        settings=AplisayAnthropicLLMService.Settings(model="claude-sonnet-4-5", system_instruction="You are terse."),
    )
    reported: list = []

    async def capture(tokens):
        reported.append(tokens)

    async def drop(*_args, **_kwargs):
        return None

    service.start_llm_usage_metrics = capture  # type: ignore[method-assign]
    service.push_frame = drop  # type: ignore[method-assign]
    context = LLMContext([{"role": "user", "content": "Reply with the single word OK."}])
    try:
        asyncio.run(service._process_context(context))
    except asyncio.CancelledError:
        assert interrupt
    return reported


def test_input_tokens_are_counted_once():
    usage = {"input_tokens": 19, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0}
    [tokens] = _run([_start({**usage, "output_tokens": 1}), *_text_block(), *_end({**usage, "output_tokens": 4})])
    assert (tokens.prompt_tokens, tokens.completion_tokens) == (19, 4)


@pytest.mark.parametrize("cache", ["cache_creation_input_tokens", "cache_read_input_tokens"])
def test_prompt_tokens_stay_net_of_the_cache(cache):
    usage = {"input_tokens": 3, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, cache: 5190}
    [tokens] = _run([_start({**usage, "output_tokens": 1}), *_text_block(), *_end({**usage, "output_tokens": 4})])
    assert (tokens.prompt_tokens, tokens.completion_tokens) == (3, 4)
    assert getattr(tokens, cache) == 5190


def test_an_interrupted_stream_keeps_the_message_start_count():
    usage = {"input_tokens": 19, "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0, "output_tokens": 1}
    [tokens] = _run([_start(usage), *_text_block()], interrupt=True)
    assert tokens.prompt_tokens == 19
