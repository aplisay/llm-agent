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
    LLMUserAggregatorParams,
)
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.services.llm_service import FunctionCallParams
from pipecat.turns.user_mute.mute_until_first_bot_complete_user_mute_strategy import (
    MuteUntilFirstBotCompleteUserMuteStrategy,
)


def _user_aggregator_params_for(agent: dict) -> Optional[LLMUserAggregatorParams]:
    """Build the user-aggregator params, applying ``MuteUntilFirstBotComplete``
    when the agent configures an opening greeting.

    The architecture doc says greetings are uninterruptible — VAD-detected
    user speech should be dropped while the greeting plays. We do that with
    Pipecat's built-in :class:`MuteUntilFirstBotCompleteUserMuteStrategy`,
    which gates ``InputAudioRawFrame``s out of the pipeline from the start
    of the session until the bot's first ``BotStoppedSpeakingFrame``. After
    the first bot turn, normal interruption resumes (user can talk over
    subsequent agent responses just fine — only the greeting is protected).

    When no greeting is configured we return ``None`` so the default
    speak-first behaviour stays interruptible (matches the contract).
    """
    greeting = (agent.get("options") or {}).get("greeting") or {}
    text = greeting.get("text") if isinstance(greeting.get("text"), str) else ""
    instructions = (
        greeting.get("instructions")
        if isinstance(greeting.get("instructions"), str)
        else ""
    )
    has_greeting = bool((text or "").strip()) or bool((instructions or "").strip())
    if not has_greeting:
        return None
    return LLMUserAggregatorParams(
        user_mute_strategies=[MuteUntilFirstBotCompleteUserMuteStrategy()]
    )


def _require_env(name: str, *aliases: str) -> str:
    """Return the first env var that's set; raise a clear error otherwise.

    Provider key conventions vary across vendor docs (Google uses
    ``GEMINI_API_KEY`` / ``GOOGLE_API_KEY`` / ``GOOGLE_GENAI_API_KEY``
    interchangeably depending on which SDK page you land on). Accepting any
    of them avoids surprising the operator just because they set the
    "wrong" one, and the error message names every accepted variant when
    none are present.
    """
    for var in (name, *aliases):
        value = os.environ.get(var)
        if value:
            return value
    candidates = " / ".join((name, *aliases))
    raise KeyError(
        f"Missing API key — set one of {candidates} in the worker environment "
        f"(remember to fully restart the worker after setting env vars; "
        f"uvicorn --reload only watches code, not the shell's exports)."
    )
from pipecat.transports.base_transport import BaseTransport

from .voice_mode import VoiceMode, model_id_from_name, resolve_voice_mode


def _properties_to_function_schema(name: str, description: str, properties: dict, required: list[str]) -> FunctionSchema:
    return FunctionSchema(
        name=name,
        description=description or "",
        properties=properties or {},
        required=required or [],
    )


def _build_tools_schema(tools: list[dict]) -> ToolsSchema:
    """Build a :class:`ToolsSchema` from the platform's tool descriptors.

    Extracted from :func:`_register_tools_on_llm` so callers that need the
    schema *before* the LLM service is constructed can grab it without also
    registering the callbacks. The Ultravox realtime branch is the canonical
    case: Pipecat's ``UltravoxRealtimeLLMService`` only sends the
    ``selectedTools`` array to the /calls API when ``one_shot_selected_tools``
    is passed to the constructor (functions added later via
    ``register_function`` wire the callback path but never surface the
    schemas to the model), so we need the ``ToolsSchema`` up front.
    """
    schemas: list[FunctionSchema] = []
    for entry in tools:
        s = entry["schema"]
        schemas.append(
            _properties_to_function_schema(
                s["name"],
                s.get("description", ""),
                s.get("properties", {}),
                s.get("required", []),
            )
        )
    return ToolsSchema(standard_tools=schemas)


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

        async def _runner(params: FunctionCallParams, _execute=entry["execute"], _name=s["name"]) -> None:
            # Breadcrumb so we can confirm the realtime path actually
            # routes function calls through here (and therefore through
            # function_handler.py's transaction-log emissions). Earlier
            # symptoms suggested realtime calls weren't reaching the
            # telemetry path at all.
            from loguru import logger as _logger
            _logger.bind(tool=_name, arguments=params.arguments).debug(
                "tool runner invoked"
            )
            try:
                result = await _execute(params.arguments)
            except Exception as e:  # noqa: BLE001
                _logger.bind(tool=_name, error=str(e)).warning(
                    "tool runner _execute raised"
                )
                # Surface the error to the LLM via the result callback so
                # the conversation can recover, rather than dropping the
                # whole turn.
                await params.result_callback({"error": str(e)})
                return
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
    enable_recording: bool = False,
    relay_endpoint: "Optional[Any]" = None,
) -> tuple[PipelineTask, Optional[AudioBufferProcessor], LLMContext]:
    """Construct a configured ``PipelineTask`` for the call.

    When ``enable_recording`` is true the returned ``AudioBufferProcessor``
    is appended to the pipeline (stereo, user-left/bot-right per
    ``lib/recording/CONTRACT.md``). The caller owns its lifecycle:
    ``await processor.start_recording()`` once the session is up and
    ``await processor.stop_recording()`` on shutdown.

    The ``LLMContext`` is returned alongside the task because callers
    (specifically :class:`CallSession`) need a handle to extract the
    running chat history for the LiveKit-parity consultative-transfer
    flow — see ``CallSession.get_parent_transcript()`` and
    ``docs/call-transfers.md`` for the ``${parentTranscript}`` contract.

    The caller wires the returned task into a ``PipelineRunner`` and starts it.
    """
    mode: VoiceMode = resolve_voice_mode(model_name, agent.get("options"))
    logger.bind(mode=mode, model=model_name, recording=enable_recording).info(
        "building voice session"
    )

    audio_buffer: Optional[AudioBufferProcessor] = None
    if enable_recording:
        # Stereo, sample rate inherits from whatever the source pipeline
        # produces. ``num_channels=2`` is the documented "user left / bot
        # right" layout — matches LiveKit's RecorderIO output exactly.
        audio_buffer = AudioBufferProcessor(num_channels=2)

    if mode == "realtime":
        task, context = await _build_realtime(
            transport, model_name, agent, metadata, tools, system_prompt, audio_buffer, relay_endpoint
        )
    else:
        task, context = await _build_pipeline(
            transport, model_name, agent, metadata, tools, system_prompt, audio_buffer, relay_endpoint
        )
    return task, audio_buffer, context


async def _build_realtime(
    transport: BaseTransport,
    model_name: str,
    agent: dict,
    metadata: dict,
    tools: list[dict],
    system_prompt: str,
    audio_buffer: Optional[AudioBufferProcessor],
    relay_endpoint: "Optional[Any]" = None,
) -> tuple[PipelineTask, LLMContext]:
    model_id = model_id_from_name(model_name)
    options = agent.get("options") or {}

    if model_id.startswith("openai/"):
        # OpenAI Realtime: `voice` lives inside SessionProperties → audio →
        # output, not directly on Settings. The Settings class only accepts
        # `session_properties` (plus inherited `model` / `system_instruction`).
        #
        # User-side transcripts are OFF by default; without
        # `audio.input.transcription` set, OpenAI Realtime never emits
        # TranscriptionFrame for the user's speech, which means the
        # platform never sees a `user` row in the transaction log.
        from pipecat.services.openai.realtime.llm import OpenAIRealtimeLLMService
        from pipecat.services.openai.realtime.events import (
            AudioConfiguration,
            AudioInput,
            AudioOutput,
            InputAudioTranscription,
            SessionProperties,
        )

        _, openai_model = model_id.split("/", 1)
        voice = (options.get("tts") or {}).get("voice") or "alloy"
        llm = OpenAIRealtimeLLMService(
            api_key=_require_env("OPENAI_API_KEY"),
            settings=OpenAIRealtimeLLMService.Settings(
                model=openai_model,
                system_instruction=system_prompt,
                session_properties=SessionProperties(
                    audio=AudioConfiguration(
                        input=AudioInput(transcription=InputAudioTranscription()),
                        output=AudioOutput(voice=voice),
                    ),
                ),
            ),
        )
    elif model_id.startswith("google/"):
        from pipecat.services.google.gemini_live.llm import GeminiLiveLLMService

        llm = GeminiLiveLLMService(
            api_key=_require_env("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"),
            system_instruction=system_prompt,
        )
    elif model_id.startswith("ultravox/"):
        # Ultravox Realtime — Pipecat constructs a one-shot call against the
        # Ultravox /calls API. ``OneShotInputParams`` carries the API key,
        # system prompt, voice, and the per-row model id from
        # lib/models/pipecat.js (e.g. ``ultravox-v0.6``, ``ultravox-v0.7``).
        #
        # Ultravox is audio-native — the model receives raw audio and emits
        # both audio and an aligned text transcript (LLMTextFrame/
        # TranscriptionFrame). The mode-aware observer in
        # ``transcript_observer.py`` already accepts TranscriptionFrame from
        # LLMService originators, so user transcripts flow without extra
        # configuration.
        import uuid as _uuid

        from pipecat.services.ultravox.llm import OneShotInputParams

        # Local subclass overrides ``_receive_messages`` to silence a benign
        # ERROR line on client-driven teardown. See ultravox_compat.py.
        from .ultravox_compat import AplisayUltravoxRealtimeLLMService as UltravoxRealtimeLLMService

        # Ultravox's /calls API expects model ids in the ``fixie-ai/<name>``
        # namespace — that's Pipecat's documented default
        # (``fixie-ai/ultravox``) and what the API actually accepts. The
        # ``ultravox/...`` form is rejected with HTTP 400 ``["Model
        # ``ultravox/ultravox-v0.7`` does not exist"]``.
        #
        # The Aplisay platform model registry uses ``ultravox`` as the
        # vendor segment (see lib/models/pipecat.js: rows are
        # ``("ultravox", "ultravox-v0.7")``) for handler routing; we strip
        # that internal prefix and re-attach the API-side ``fixie-ai/``
        # namespace before sending. If the caller already passed a
        # fully-qualified ``fixie-ai/<name>`` (or any other vendor-prefixed
        # spelling) leave it unchanged.
        _, ultravox_model = model_id.split("/", 1)
        if "/" not in ultravox_model:
            ultravox_model = f"fixie-ai/{ultravox_model}"
        voice = (options.get("tts") or {}).get("voice")

        # ----- Greeting wiring (Ultravox-specific) -----
        # Ultravox's ``process_frame`` only handles ``LLMContextFrame``,
        # ``InterruptionFrame``, ``InputTextRawFrame``,
        # ``InputAudioRawFrame``, and ``VADUserStoppedSpeakingFrame`` — the
        # model-agnostic greeting frames we use for OpenAI Realtime / Gemini
        # Live (``LLMMessagesAppendFrame`` + ``LLMRunFrame``, or
        # ``TTSSpeakFrame``) pass through untouched. So we wire greetings
        # via the Ultravox API instead, using ``firstSpeakerSettings.agent``
        # (https://docs.ultravox.ai/api-reference/calls/calls-post#body-first-speaker-settings):
        #
        # - ``greeting.text`` → ``firstSpeakerSettings.agent.text`` — the
        #   exact text is spoken verbatim, uninterruptible.
        # - ``greeting.instructions`` → ``firstSpeakerSettings.agent.prompt``
        #   — Ultravox uses the instructions as an LLM prompt to generate
        #   the opening line. Uninterruptible. We deliberately *do not*
        #   touch the agent's system prompt: ``prompt`` here is scoped to
        #   the first turn only, which preserves the contract that the
        #   greeting doesn't bleed into the rest of the conversation.
        # - No greeting configured → ``firstSpeakerSettings.agent`` with
        #   no overrides — agent speaks first (interruptible) using its
        #   system prompt, matching the model-agnostic default in
        #   ``call_session._wire_greeting``.
        #
        # ``call_session._wire_greeting`` short-circuits for Ultravox so
        # those no-op frames are never queued; this branch is the sole
        # owner of the greeting behaviour on Ultravox.
        greeting = (options.get("greeting") or {})
        greeting_text = greeting.get("text") if isinstance(greeting.get("text"), str) else ""
        greeting_text = (greeting_text or "").strip()
        greeting_instructions = (
            greeting.get("instructions") if isinstance(greeting.get("instructions"), str) else ""
        )
        greeting_instructions = (greeting_instructions or "").strip()

        ultravox_first_speaker: dict[str, Any]
        if greeting_text:
            ultravox_first_speaker = {
                "agent": {
                    "text": greeting_text,
                    "uninterruptible": True,
                }
            }
        elif greeting_instructions:
            ultravox_first_speaker = {
                "agent": {
                    "prompt": greeting_instructions,
                    "uninterruptible": True,
                }
            }
        else:
            # Agent speaks first (interruptible) using its system prompt.
            ultravox_first_speaker = {"agent": {}}

        # Pipecat's ``OneShotInputParams.voice`` is typed ``uuid.UUID | None``
        # via pydantic, so a plain ``voice="Louisamay"`` raises
        # ``ValidationError: Input should be a valid UUID``. But the
        # underlying Ultravox /calls API accepts BOTH the voiceId UUID and
        # the human-readable voice name (the docs at
        # https://docs.ultravox.ai/api-reference/calls/calls-post describe
        # ``voice`` as "voice id or name"). Pipecat itself only does
        # ``str(params.voice)`` when building the request body
        # (services/ultravox/llm.py:_start_one_shot_call), so the wire
        # representation is identical for either form. The Aplisay
        # platform stores voices by their name (see lib/handlers/ultravox.js
        # which fetches the /voices catalogue and exposes the ``name``
        # field), so we want to support names here.
        #
        # Strategy: construct with ``voice=None`` to satisfy the validator,
        # then route around it via ``object.__setattr__`` to plant the
        # raw string (or parsed UUID) directly into the model dict. This
        # is safe because pydantic v2 BaseModel uses ``__dict__`` for
        # field storage and Pipecat's downstream code only stringifies the
        # value.
        params = OneShotInputParams(
            api_key=_require_env("ULTRAVOX_API_KEY"),
            system_prompt=system_prompt,
            # ``model`` on the request body maps to the Ultravox catalogue
            # id (``ultravox-v0.6`` etc.). The default in the library is
            # ``fixie-ai/ultravox`` which is the public alias — pass our
            # explicit id through verbatim.
            model=ultravox_model,
            voice=None,
            # ``OneShotInputParams.extra`` is merged into the /calls request
            # body (see ``_start_one_shot_call`` in Pipecat's Ultravox
            # service: ``request_body = request_body | params.extra``), so
            # this is the canonical place to surface API parameters that
            # the OneShotInputParams class doesn't model directly —
            # ``firstSpeakerSettings`` being the headline case here.
            extra={"firstSpeakerSettings": ultravox_first_speaker},
        )
        if voice:
            # Accept either a UUID string or a human-readable voice name.
            # Stringify a UUID where possible so any future strict
            # validator further down would still pass; otherwise plant the
            # raw name and rely on str(params.voice) at request time.
            try:
                resolved_voice: object = _uuid.UUID(str(voice))
            except (ValueError, AttributeError, TypeError):
                resolved_voice = str(voice)
            object.__setattr__(params, "voice", resolved_voice)

        # Ultravox needs the function schemas at construction time:
        # ``UltravoxRealtimeLLMService`` only forwards ``selectedTools`` to
        # the /calls API when ``one_shot_selected_tools=`` is supplied to
        # the constructor — the ``register_function`` calls below just
        # wire the invocation *callbacks*, not the schemas. Without this
        # the model never sees the tool definitions and never emits any
        # tool calls.
        #
        # Build the schema up front; we'll still call
        # ``_register_tools_on_llm`` after construction so the runtime
        # callback path matches the OpenAI Realtime / Gemini Live branches.
        ultravox_tools_schema = _build_tools_schema(tools)

        llm = UltravoxRealtimeLLMService(
            params=params,
            one_shot_selected_tools=(
                ultravox_tools_schema
                if ultravox_tools_schema.standard_tools
                else None
            ),
        )

        # Workaround for a Pipecat 1.x bug: ``UltravoxRealtimeLLMService``
        # only initialises ``self._selected_tools`` when
        # ``one_shot_selected_tools`` is truthy. The path above sets it
        # when we have tools, but agents with no tools at all would still
        # hit ``AttributeError`` on the unconditional read at
        # ``_start_one_shot_call`` (``if self._selected_tools``). Plant an
        # explicit ``None`` only if the constructor didn't.
        if not hasattr(llm, "_selected_tools"):
            llm._selected_tools = None  # type: ignore[attr-defined]
    else:
        raise RuntimeError(f"Unsupported realtime provider for {model_id}")

    # Pipecat's FrameProcessor.push_error path logs only the wrapping
    # message (e.g. "Failed to connect to Ultravox") and never surfaces
    # the underlying exception that carries the real cause (HTTP status,
    # response body, etc.). Subscribe to the ``on_error`` event so we can
    # see the actual cause in the worker logs when a realtime LLM service
    # fails to start.
    @llm.event_handler("on_error")  # type: ignore[misc]
    async def _log_realtime_llm_error(_processor, error_frame):  # noqa: ANN001
        exc = getattr(error_frame, "exception", None)
        if exc is not None:
            logger.opt(exception=exc).error(
                f"realtime LLM error: {getattr(error_frame, 'error', '')!r}"
                f" ({type(exc).__name__}: {exc})"
            )
        else:
            logger.error(f"realtime LLM error: {getattr(error_frame, 'error', '')!r}")

    schemas = _register_tools_on_llm(llm, tools)

    context = LLMContext(
        [{"role": "developer", "content": system_prompt}],
        tools=schemas,
    )
    user_params = _user_aggregator_params_for(agent)
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context, user_params=user_params
    )

    # Relay tap sits right after input() (capture/mute the leg's mic during a
    # WebRTC-origin transfer); injector sits right before output() (mute the bot
    # and emit the peer leg's audio). Inert until engaged — see media_relay.
    relay_tap = [relay_endpoint.tap] if relay_endpoint is not None else []
    relay_inject = [relay_endpoint.inject] if relay_endpoint is not None else []
    processors: list = [
        transport.input(),
        *relay_tap,
        user_aggregator,
        llm,
        *relay_inject,
        transport.output(),
    ]
    # The recording docs require ``AudioBufferProcessor`` to sit AFTER
    # ``transport.output()`` so it sees both the user's input frames and the
    # bot's rendered TTS output frames.
    if audio_buffer is not None:
        processors.append(audio_buffer)
    processors.append(assistant_aggregator)
    pipeline = Pipeline(processors)
    return PipelineTask(pipeline, params=PipelineParams()), context


async def _build_pipeline(
    transport: BaseTransport,
    model_name: str,
    agent: dict,
    metadata: dict,
    tools: list[dict],
    system_prompt: str,
    audio_buffer: Optional[AudioBufferProcessor],
    relay_endpoint: "Optional[Any]" = None,
) -> tuple[PipelineTask, LLMContext]:
    model_id = model_id_from_name(model_name)
    options = agent.get("options") or {}
    stt_opts = options.get("stt") or {}
    tts_opts = options.get("tts") or {}

    # STT
    stt_vendor = (stt_opts.get("vendor") or "deepgram").split("/")[0].lower()
    if stt_vendor == "deepgram":
        from pipecat.services.deepgram.stt import DeepgramSTTService

        stt = DeepgramSTTService(api_key=_require_env("DEEPGRAM_API_KEY"))
    elif stt_vendor == "google":
        from pipecat.services.google.stt import GoogleSTTService

        # GoogleSTTService accepts credentials JSON or credentials_path. Source
        # of truth is GOOGLE_APPLICATION_CREDENTIALS_JSON (a JSON string) or
        # GOOGLE_APPLICATION_CREDENTIALS (a path) — pass through whichever the
        # operator set.
        creds_json = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS_JSON")
        creds_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        stt = GoogleSTTService(
            credentials=creds_json,
            credentials_path=creds_path,
            location=os.environ.get("GOOGLE_STT_LOCATION", "global"),
        )
    else:
        raise RuntimeError(f"Unsupported STT vendor {stt_vendor!r} for pipeline mode")

    # LLM
    if model_id.startswith("openai/"):
        from pipecat.services.openai.llm import OpenAILLMService

        _, openai_model = model_id.split("/", 1)
        llm = OpenAILLMService(
            api_key=_require_env("OPENAI_API_KEY"),
            model=openai_model,
            settings=OpenAILLMService.Settings(system_instruction=system_prompt),
        )
    elif model_id.startswith("google/"):
        from pipecat.services.google.llm import GoogleLLMService

        _, gemini_model = model_id.split("/", 1)
        llm = GoogleLLMService(
            api_key=_require_env("GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"),
            model=gemini_model,
            settings=GoogleLLMService.Settings(system_instruction=system_prompt),
        )
    elif model_id.startswith("anthropic/"):
        from pipecat.services.anthropic.llm import AnthropicLLMService

        _, anthropic_model = model_id.split("/", 1)
        llm = AnthropicLLMService(
            api_key=_require_env("ANTHROPIC_API_KEY"),
            model=anthropic_model,
            settings=AnthropicLLMService.Settings(system_instruction=system_prompt),
        )
    else:
        raise RuntimeError(f"Unsupported LLM in pipeline mode: {model_id}")

    # TTS — keep this list aligned with PIPECAT_PIPELINE_TTS_VENDORS in
    # lib/model-voices.js. The API layer uses that allow-list to filter the
    # platform's TTS voice catalogue so the UI only offers vendors the worker
    # can actually instantiate.
    tts_vendor = (tts_opts.get("vendor") or "cartesia").split("/")[0].lower()
    voice = tts_opts.get("voice")
    if tts_vendor == "cartesia":
        from pipecat.services.cartesia.tts import CartesiaTTSService

        tts = CartesiaTTSService(
            api_key=_require_env("CARTESIA_API_KEY"),
            settings=CartesiaTTSService.Settings(voice=voice or "71a7ad14-091c-4e8e-a314-022ece01c121"),
        )
    elif tts_vendor == "elevenlabs":
        from pipecat.services.elevenlabs.tts import ElevenLabsTTSService

        tts = ElevenLabsTTSService(
            api_key=_require_env("ELEVENLABS_API_KEY", "ELEVEN_API_KEY"),
            voice_id=voice or "Rachel",
        )
    elif tts_vendor == "deepgram":
        # WebSocket-based streaming TTS. Voice names follow Deepgram's Aura
        # model IDs (e.g. `aura-asteria-en`, `aura-helios-en`) — same values
        # the platform's voices catalogue (lib/voices/deepgram.js) lists.
        from pipecat.services.deepgram.tts import DeepgramTTSService

        tts = DeepgramTTSService(
            api_key=_require_env("DEEPGRAM_API_KEY"),
            voice=voice or "aura-asteria-en",
        )
    else:
        raise RuntimeError(f"Unsupported TTS vendor {tts_vendor!r} for pipeline mode")

    schemas = _register_tools_on_llm(llm, tools)

    context = LLMContext(
        [{"role": "developer", "content": system_prompt}],
        tools=schemas,
    )
    user_params = _user_aggregator_params_for(agent)
    user_aggregator, assistant_aggregator = LLMContextAggregatorPair(
        context, user_params=user_params
    )

    # Relay tap after input(), injector before output() — inert until engaged
    # for a WebRTC-origin transfer (see media_relay / _build_realtime).
    relay_tap = [relay_endpoint.tap] if relay_endpoint is not None else []
    relay_inject = [relay_endpoint.inject] if relay_endpoint is not None else []
    processors: list = [
        transport.input(),
        *relay_tap,
        stt,
        user_aggregator,
        llm,
        tts,
        *relay_inject,
        transport.output(),
    ]
    if audio_buffer is not None:
        processors.append(audio_buffer)
    processors.append(assistant_aggregator)
    pipeline = Pipeline(processors)
    return PipelineTask(pipeline, params=PipelineParams()), context
