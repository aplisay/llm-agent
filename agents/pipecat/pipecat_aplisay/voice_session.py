"""Voice session factory — sections 4.3 and 4.4 of docs/livekit-agent-architecture.md.

Builds a Pipecat ``PipelineTask`` for a given agent / model / transport. Two
modes:

- ``realtime``: a single speech-to-speech LLM service (OpenAI Realtime / Gemini
  Live) handles audio in / audio out.
- ``pipeline``: STT → LLM → TTS, plus a turn detector. Vendor + voice picked
  from ``agent.options.stt`` / ``agent.options.tts``.

Function-tool registration is uniform across modes: tools described by
:func:`pipecat_aplisay.agent_tools.build_agent_tools` are adapted to Pipecat's
``FunctionSchema`` + ``register_function``.
"""

from __future__ import annotations

import os
from typing import Any, Awaitable, Callable, Optional

from loguru import logger
from pipecat.adapters.schemas.function_schema import FunctionSchema
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.processors.aggregators.llm_response_universal import (
    LLMContextAggregatorPair,
)
from pipecat.services.llm_service import FunctionCallParams
from pipecat.transports.base_transport import BaseTransport

from .voice_mode import VoiceMode, model_id_from_name, resolve_voice_mode


def _properties_to_function_schema(name: str, description: str, properties: dict, required: list[str]) -> FunctionSchema:
    return FunctionSchema(
        name=name,
        description=description or "",
        properties=properties or {},
        required=required or [],
    )


def _register_tools_on_llm(llm: Any, tools: list[dict]) -> ToolsSchema:
    """Register the platform's tool descriptors against a Pipecat LLM service.

    The ``tools`` argument matches the format produced by
    :func:`agent_tools.build_agent_tools`: each entry has ``schema`` and
    ``execute``. The schema is converted to ``FunctionSchema`` and registered
    with the service so it appears on the LLM-visible tool surface.
    """
    schemas: list[FunctionSchema] = []
    for entry in tools:
        s = entry["schema"]
        schema = _properties_to_function_schema(
            s["name"], s.get("description", ""), s.get("properties", {}), s.get("required", [])
        )
        schemas.append(schema)

        async def _runner(params: FunctionCallParams, _execute=entry["execute"]) -> None:
            result = await _execute(params.arguments)
            await params.result_callback(result)

        llm.register_function(s["name"], _runner)

    return ToolsSchema(standard_tools=schemas)


async def build_voice_session(
    *,
    transport: BaseTransport,
    model_name: str,
    agent: dict,
    metadata: dict,
    tools: list[dict],
    system_prompt: str,
) -> PipelineTask:
    """Construct a configured ``PipelineTask`` for the call.

    The caller wires the returned task into a ``PipelineRunner`` and starts it.
    """
    mode: VoiceMode = resolve_voice_mode(model_name, agent.get("options"))
    logger.info({"mode": mode, "model": model_name}, "building voice session")

    if mode == "realtime":
        return await _build_realtime(transport, model_name, agent, metadata, tools, system_prompt)
    return await _build_pipeline(transport, model_name, agent, metadata, tools, system_prompt)


async def _build_realtime(
    transport: BaseTransport,
    model_name: str,
    agent: dict,
    metadata: dict,
    tools: list[dict],
    system_prompt: str,
) -> PipelineTask:
    model_id = model_id_from_name(model_name)
    options = agent.get("options") or {}

    if model_id.startswith("openai/"):
        from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService

        llm = OpenAIRealtimeLLMService(
            api_key=os.environ["OPENAI_API_KEY"],
            settings=OpenAIRealtimeLLMService.Settings(
                system_instruction=system_prompt,
                voice=(options.get("tts") or {}).get("voice") or "alloy",
            ),
        )
    elif model_id.startswith("google/"):
        from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService

        llm = GeminiLiveLLMService(
            api_key=os.environ["GEMINI_API_KEY"],
            system_instruction=system_prompt,
        )
    else:
        raise RuntimeError(f"Unsupported realtime provider for {model_id}")

    schemas = _register_tools_on_llm(llm, tools)

    context = LLMContext(
        [{"role": "developer", "content": system_prompt}],
        tools=schemas,
    )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)

    pipeline = Pipeline(
        [
            transport.input(),
            user_aggregator,
            llm,
            transport.output(),
            assistant_aggregator,
        ]
    )
    return PipelineTask(pipeline, params=PipelineParams())


async def _build_pipeline(
    transport: BaseTransport,
    model_name: str,
    agent: dict,
    metadata: dict,
    tools: list[dict],
    system_prompt: str,
) -> PipelineTask:
    model_id = model_id_from_name(model_name)
    options = agent.get("options") or {}
    stt_opts = options.get("stt") or {}
    tts_opts = options.get("tts") or {}

    # STT
    stt_vendor = (stt_opts.get("vendor") or "deepgram").split("/")[0].lower()
    if stt_vendor == "deepgram":
        from pipecat.services.deepgram.stt import DeepgramSTTService

        stt = DeepgramSTTService(api_key=os.environ["DEEPGRAM_API_KEY"])
    else:
        raise RuntimeError(f"Unsupported STT vendor {stt_vendor!r} for pipeline mode")

    # LLM
    if model_id.startswith("openai/"):
        from pipecat.services.openai.llm import OpenAILLMService

        _, openai_model = model_id.split("/", 1)
        llm = OpenAILLMService(
            api_key=os.environ["OPENAI_API_KEY"],
            model=openai_model,
            settings=OpenAILLMService.Settings(system_instruction=system_prompt),
        )
    elif model_id.startswith("google/"):
        from pipecat.services.google.llm import GoogleLLMService

        _, gemini_model = model_id.split("/", 1)
        llm = GoogleLLMService(
            api_key=os.environ["GEMINI_API_KEY"],
            model=gemini_model,
            settings=GoogleLLMService.Settings(system_instruction=system_prompt),
        )
    elif model_id.startswith("anthropic/"):
        from pipecat.services.anthropic.llm import AnthropicLLMService

        _, anthropic_model = model_id.split("/", 1)
        llm = AnthropicLLMService(
            api_key=os.environ["ANTHROPIC_API_KEY"],
            model=anthropic_model,
            settings=AnthropicLLMService.Settings(system_instruction=system_prompt),
        )
    else:
        raise RuntimeError(f"Unsupported LLM in pipeline mode: {model_id}")

    # TTS
    tts_vendor = (tts_opts.get("vendor") or "cartesia").split("/")[0].lower()
    voice = tts_opts.get("voice")
    if tts_vendor == "cartesia":
        from pipecat.services.cartesia.tts import CartesiaTTSService

        tts = CartesiaTTSService(
            api_key=os.environ["CARTESIA_API_KEY"],
            settings=CartesiaTTSService.Settings(voice=voice or "71a7ad14-091c-4e8e-a314-022ece01c121"),
        )
    elif tts_vendor == "elevenlabs":
        from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

        tts = ElevenLabsTTSService(
            api_key=os.environ["ELEVENLABS_API_KEY"],
            voice_id=voice or "Rachel",
        )
    else:
        raise RuntimeError(f"Unsupported TTS vendor {tts_vendor!r} for pipeline mode")

    schemas = _register_tools_on_llm(llm, tools)

    context = LLMContext(
        [{"role": "developer", "content": system_prompt}],
        tools=schemas,
    )
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(context)

    pipeline = Pipeline(
        [
            transport.input(),
            stt,
            user_aggregator,
            llm,
            tts,
            transport.output(),
            assistant_aggregator,
        ]
    )
    return PipelineTask(pipeline, params=PipelineParams())
