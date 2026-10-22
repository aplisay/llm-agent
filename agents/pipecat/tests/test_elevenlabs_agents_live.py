"""Run a real ElevenLabs conversation through a Pipecat pipeline built the way
the worker builds it (the context aggregators, the tool runner, the service),
without a transport: a spoken question goes in as caller audio, a client tool
answers it, and the agent's reply comes back as audio and transcript frames.
Skipped without ELEVENLABS_API_KEY. Creates (and reuses) one hosted agent
under the prefix ``aplisay-test``."""

from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path

import httpx
import pytest
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    InputAudioRawFrame,
    LLMFullResponseEndFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import LLMContextAggregatorPair
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from pipecat_aplisay.elevenlabs_agents_service import build_elevenlabs_agents_service
from pipecat_aplisay.voice_session import _register_tools_on_llm

KEY = os.getenv("ELEVENLABS_API_KEY") or os.getenv("ELEVEN_API_KEY")
pytestmark = pytest.mark.skipif(not KEY, reason="ELEVENLABS_API_KEY is not set")

ROW = "pipecat:elevenlabs/gemini-2.5-flash"
CLIP = Path(tempfile.gettempdir()) / "aplisay-elevenlabs-live-clip-16k.pcm"


async def _clip() -> bytes:
    """A spoken question at 16 kHz, made once with ElevenLabs TTS."""
    if CLIP.exists():
        return CLIP.read_bytes()
    async with httpx.AsyncClient(timeout=60) as c:
        r = await c.post(
            "https://api.elevenlabs.io/v1/text-to-speech/cjVigY5qzO86Huf0OWal",
            headers={"xi-api-key": KEY},
            params={"output_format": "pcm_16000"},
            json={"text": "What time is it in London right now?", "model_id": "eleven_flash_v2_5"},
        )
        r.raise_for_status()
        CLIP.write_bytes(r.content)
        return r.content


class _Sink(FrameProcessor):
    """Collects every frame that reaches the end of the pipeline."""

    def __init__(self) -> None:
        super().__init__()
        self.frames: list[Frame] = []

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        self.frames.append(frame)
        await self.push_frame(frame, direction)


def test_a_spoken_question_runs_a_tool_and_is_answered(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_AGENT_PREFIX", "aplisay-test")
    calls: list[dict] = []

    async def get_time(args: dict) -> dict:
        calls.append(args)
        return {"time": "14:32", "timezone": args.get("timezone")}

    tools = [{
        "schema": {
            "name": "get_time", "description": "Get the current time in a timezone",
            "properties": {"timezone": {"type": "string", "description": "IANA timezone"}}, "required": ["timezone"],
        },
        "execute": get_time, "kind": "function",
    }]
    agent = {
        "id": "live", "name": "Pat", "modelName": ROW, "prompt": "x",
        "options": {"greeting": {"text": "Aplisay test line, Pat speaking."}},
    }
    llm = build_elevenlabs_agents_service(
        api_key=KEY, model_id="elevenlabs/gemini-2.5-flash", agent=agent,
        tool_schemas=[t["schema"] for t in tools],
        system_prompt="You are Pat, a terse assistant. Answer in one short sentence. When asked the time, call get_time with the IANA timezone.",
        max_duration_secs=120,
    )
    schemas = _register_tools_on_llm(llm, tools)
    context = LLMContext([{"role": "developer", "content": "You are Pat."}], tools=schemas)
    user, assistant = LLMContextAggregatorPair(context)
    sink = _Sink()
    pipeline = Pipeline([user, llm, sink, assistant])
    task = PipelineTask(pipeline, params=PipelineParams(enable_metrics=False), idle_timeout_secs=None)

    async def scenario() -> None:
        clip = await _clip()
        runner = PipelineRunner(handle_sigint=False)
        run = asyncio.create_task(runner.run(task))
        try:
            # the greeting: audio and its text
            await _until(lambda: any(isinstance(f, LLMFullResponseEndFrame) for f in sink.frames), 20)
            # silence, then the question, then silence while the agent answers
            await _speak(task, b"\x00" * 32000)
            await _speak(task, clip)
            await _until(lambda: calls, 20)
            await _speak(task, b"\x00" * 32000, until=lambda: _texts(sink).__len__() >= 2, timeout=20)
        finally:
            await task.queue_frame(EndFrame())
            try:
                await asyncio.wait_for(run, 15)
            except asyncio.TimeoutError:
                run.cancel()

    asyncio.run(asyncio.wait_for(scenario(), 120))

    texts = _texts(sink)
    assert texts[0] == "Aplisay test line, Pat speaking."
    assert calls and calls[0].get("timezone", "").startswith("Europe/")
    assert any("32" in t or "two" in t.lower() for t in texts[1:]), texts
    assert any(isinstance(f, TTSAudioRawFrame) and f.sample_rate == 24000 for f in sink.frames)
    assert [m["role"] for m in context.get_messages()][:1] == ["developer"]
    roles = [m.get("role") for m in context.get_messages()]
    assert "assistant" in roles and "tool" in roles
    users = [f.text for f in sink.frames if isinstance(f, TranscriptionFrame)]
    assert not users, "user transcripts travel upstream, not down"


def _texts(sink: _Sink) -> list[str]:
    return [f.text for f in sink.frames if isinstance(f, LLMTextFrame)]


async def _until(predicate, timeout: float) -> None:
    deadline = asyncio.get_running_loop().time() + timeout
    while not predicate():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("timed out waiting")
        await asyncio.sleep(0.05)


async def _speak(task: PipelineTask, pcm: bytes, *, until=None, timeout: float = 0) -> None:
    """Queue ``pcm`` (16 kHz mono) as 20 ms caller frames in real time."""
    deadline = asyncio.get_running_loop().time() + timeout
    for i in range(0, len(pcm), 640):
        await task.queue_frame(InputAudioRawFrame(audio=pcm[i:i + 640], sample_rate=16000, num_channels=1))
        await asyncio.sleep(0.02)
        if until is not None and until():
            return
    while until is not None and not until():
        if asyncio.get_running_loop().time() > deadline:
            raise AssertionError("timed out waiting for the answer")
        await task.queue_frame(InputAudioRawFrame(audio=b"\x00" * 640, sample_rate=16000, num_channels=1))
        await asyncio.sleep(0.02)
