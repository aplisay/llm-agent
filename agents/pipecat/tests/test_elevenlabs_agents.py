"""ElevenLabs Agents on the Pipecat worker, without a network or a transport:
the option mapping, the hosted-agent lookup, the conversation protocol and the
worker wiring. See docs/elevenlabs-agents.md."""

from __future__ import annotations

import asyncio
import base64
import json

import httpx
import pytest
from pipecat.frames.frames import (
    InputAudioRawFrame,
    LLMFullResponseEndFrame,
    LLMFullResponseStartFrame,
    LLMTextFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.processors.aggregators.llm_context import LLMContext

from pipecat_aplisay import elevenlabs_agents as el
from pipecat_aplisay import elevenlabs_agents_client as client_module
from pipecat_aplisay.elevenlabs_agents_client import ElevenLabsAgentsClient, ElevenLabsAgentsError
from pipecat_aplisay.elevenlabs_agents_service import (
    CORRECTION_GRACE_SECS,
    ElevenLabsAgentsLLMService,
    build_elevenlabs_agents_service,
)
from pipecat_aplisay.pipeline_model_ids import is_pipeline_model_id
from pipecat_aplisay.realtime_tts import external_tts_vendor, text_output_enabled, text_output_supported
from pipecat_aplisay.usage import bundled_speech_vendor, usage_vendors

ROW = "pipecat:elevenlabs/gemini-2.5-flash"
MODEL_ID = "elevenlabs/gemini-2.5-flash"


def _agent(**options) -> dict:
    return {"id": "a1", "name": "Sam", "modelName": ROW, "prompt": "You are Sam.", "options": options}


def _schemas() -> list[dict]:
    return [
        {
            "name": "book_slot",
            "description": "Book a slot",
            "properties": {
                "when": {"type": "string", "description": "ISO date"},
                "size": {"type": "integer", "description": "party size", "required": True},
                "kind": {"type": "string", "enum": ["lunch", "dinner"]},
                "guests": {"type": "array", "items": {"type": "string"}},
                "contact": {"type": "object", "properties": {"email": {"type": "string"}}, "required": ["email"]},
                "odd": {"description": "no type", "source": "generated", "in": "body"},
            },
            "required": ["when", "size"],
        },
        {"name": "hangup", "description": "End the call", "properties": {}, "required": []},
    ]


# --- model ids and the worker's tables -------------------------------------------------


def test_model_id_rules():
    assert el.is_elevenlabs_agents_model_id(MODEL_ID) is True
    assert el.is_elevenlabs_agents_model_id("ElevenLabs/claude-haiku-5-5") is True
    assert el.is_elevenlabs_agents_model_id("openai/gpt-realtime") is False
    assert el.is_elevenlabs_agents_model_id(None) is False
    assert el.elevenlabs_llm(MODEL_ID) == "gemini-2.5-flash"
    assert el.elevenlabs_llm("elevenlabs") == ""
    assert is_pipeline_model_id(MODEL_ID) is False


def test_no_text_output_mode_and_elevenlabs_is_the_native_voice():
    assert text_output_supported(MODEL_ID) is False
    assert text_output_enabled(_agent(tts={"vendor": "cartesia", "voice": "x"}), MODEL_ID) is False
    assert external_tts_vendor(_agent(tts={"vendor": "elevenlabs", "voice": "x"}), MODEL_ID) is None
    assert external_tts_vendor(_agent(tts={"vendor": "cartesia", "voice": "x"}), MODEL_ID) == "cartesia"


def test_speech_is_not_metered_as_tts():
    # ElevenLabs is a paid discrete TTS vendor too, so a tts|elevenlabs row would be
    # priced on top of the minute line; the row's speech is unmetered like Gemini's.
    services = usage_vendors(_agent(tts={"voice": "v1"}), ROW)
    assert services["tts"]["skip"] is True
    assert services["llm"]["vendor"] == "elevenlabs"
    assert bundled_speech_vendor(_agent(), MODEL_ID) is None


# --- tools ----------------------------------------------------------------------------------


def test_client_tools_keep_the_schema_elevenlabs_reads():
    tools = el.client_tools(_schemas())
    assert [t["name"] for t in tools] == ["book_slot", "hangup"]
    book = tools[0]
    assert book["type"] == "client" and book["expects_response"] is True
    assert book["response_timeout_secs"] == el.TOOL_RESPONSE_TIMEOUT_SECONDS
    params = book["parameters"]
    assert params["type"] == "object" and params["required"] == ["when", "size"]
    props = params["properties"]
    assert props["when"] == {"type": "string", "description": "ISO date"}
    # the property-level boolean `required` is not a schema key
    assert props["size"] == {"type": "integer", "description": "party size"}
    assert props["kind"] == {"type": "string", "enum": ["lunch", "dinner"], "description": ""}
    assert props["guests"] == {"type": "array", "items": {"type": "string", "description": ""}, "description": ""}
    assert props["contact"]["type"] == "object" and props["contact"]["required"] == ["email"]
    assert props["contact"]["properties"]["email"] == {"type": "string", "description": ""}
    # platform metadata keys are gone and a missing type is a string
    assert props["odd"] == {"type": "string", "description": "no type"}
    # no parameters block for a tool without properties
    assert "parameters" not in tools[1]


def test_reserved_tool_names_are_dropped():
    tools = el.client_tools([{"name": "end_call", "description": "", "properties": {}}, {"name": "ok", "description": ""}])
    assert [t["name"] for t in tools] == ["ok"]


# --- the hosted agent's configuration --------------------------------------------------


def test_agent_config_shape():
    config = el.agent_config(_agent(temperature=0.3, maxTokens=400), llm="gemini-2.5-flash", tool_schemas=_schemas())
    cc = config["conversation_config"]
    assert cc["agent"]["prompt"]["llm"] == "gemini-2.5-flash"
    assert cc["agent"]["prompt"]["temperature"] == 0.3 and cc["agent"]["prompt"]["max_tokens"] == 400
    assert cc["agent"]["prompt"]["ignore_default_personality"] is True
    assert [t["name"] for t in cc["agent"]["prompt"]["tools"]] == ["book_slot", "hangup"]
    assert cc["agent"]["first_message"] == "" and cc["agent"]["language"] == "en"
    assert cc["tts"] == {"voice_id": el.ELEVENLABS_DEFAULT_VOICE, "agent_output_audio_format": "pcm_24000"}
    assert cc["asr"] == {"user_input_audio_format": "pcm_16000"}
    assert cc["turn"] == {"turn_timeout": el.TURN_TIMEOUT_SECONDS}
    assert cc["conversation"]["max_duration_seconds"] == 7200
    assert "client_tool_call" in cc["conversation"]["client_events"]
    ps = config["platform_settings"]
    assert ps["auth"] == {"enable_auth": True}
    assert ps["privacy"] == {"record_voice": False, "retention_days": 1}
    allowed = ps["overrides"]["conversation_config_override"]
    assert allowed["agent"]["prompt"]["prompt"] is True and allowed["agent"]["first_message"] is True
    assert allowed["tts"]["voice_id"] is True and allowed["conversation"]["max_duration_seconds"] is True
    # unset options add nothing
    plain = el.agent_config(_agent(), llm="gpt-5.4-mini", tool_schemas=[])
    assert "temperature" not in plain["conversation_config"]["agent"]["prompt"]
    assert "max_tokens" not in plain["conversation_config"]["agent"]["prompt"]


def test_vendor_config_merges_last_minus_the_platforms_paths():
    agent = _agent(vendorSpecific={"elevenlabs": {"conversation_config": {
        "turn": {"turn_timeout": 12, "turn_eagerness": "eager"},
        "tts": {"model_id": "eleven_turbo_v2_5", "stability": 0.4, "voice_id": "sneaky"},
        "agent": {"prompt": {"llm": "gpt-4o", "tools": [{"type": "webhook"}], "reasoning_effort": "low"}, "first_message": "Hi"},
        "conversation": {"text_only": True, "client_events": []},
    }}})
    cc = el.agent_config(agent, llm="gemini-2.5-flash", tool_schemas=[])["conversation_config"]
    assert cc["turn"] == {"turn_timeout": 12, "turn_eagerness": "eager"}
    assert cc["tts"]["model_id"] == "eleven_turbo_v2_5" and cc["tts"]["stability"] == 0.4
    assert cc["tts"]["voice_id"] == el.ELEVENLABS_DEFAULT_VOICE
    assert cc["agent"]["prompt"]["llm"] == "gemini-2.5-flash" and cc["agent"]["prompt"]["tools"] == []
    assert cc["agent"]["prompt"]["reasoning_effort"] == "low"
    assert cc["agent"]["first_message"] == ""
    assert "text_only" not in cc["conversation"] and cc["conversation"]["client_events"] == el.CLIENT_EVENTS
    assert el.vendor_config(_agent()) == {}
    assert el.vendor_config(_agent(vendorSpecific={"elevenlabs": {"conversation_config": []}})) == {}


def test_config_hash_ignores_per_call_values_and_tracks_the_rest():
    base = el.config_hash(el.agent_config(_agent(), llm="gemini-2.5-flash", tool_schemas=_schemas()))
    same = el.config_hash(el.agent_config(
        _agent(tts={"voice": "other", "language": "fr-FR", "speed": 1.1}, greeting={"text": "Hello"}, maxDuration=600),
        llm="gemini-2.5-flash", tool_schemas=_schemas(),
    ))
    assert same == base
    assert el.config_hash(el.agent_config(_agent(), llm="gpt-5.4-mini", tool_schemas=_schemas())) != base
    assert el.config_hash(el.agent_config(_agent(), llm="gemini-2.5-flash", tool_schemas=_schemas()[:1])) != base
    assert el.config_hash(el.agent_config(_agent(temperature=0.9), llm="gemini-2.5-flash", tool_schemas=_schemas())) != base
    vendor = _agent(vendorSpecific={"elevenlabs": {"conversation_config": {"turn": {"turn_eagerness": "eager"}}}})
    assert el.config_hash(el.agent_config(vendor, llm="gemini-2.5-flash", tool_schemas=_schemas())) != base
    assert len(base) == 20


def test_agent_name_and_create_body(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_AGENT_PREFIX", "staging")
    config = el.agent_config(_agent(), llm="gemini-2.5-flash", tool_schemas=[])
    name = el.agent_name(el.config_hash(config))
    assert name == f"staging:{el.config_hash(config)}"
    body = el.create_body(config, name=name)
    assert body["name"] == name and body["tags"] == ["aplisay", "staging"]
    assert "_v" not in body and "conversation_config" in body and "platform_settings" in body
    monkeypatch.delenv("ELEVENLABS_AGENT_PREFIX")
    assert el.agent_name("abc").startswith("aplisay:")


# --- per conversation -----------------------------------------------------------------------


def test_conversation_overrides():
    agent = _agent(tts={"voice": "v123", "language": "fr-FR", "speed": 1.5}, maxDuration="1800s")
    overrides = el.conversation_overrides(agent, system_prompt="Bonjour.", first_message="Allo", max_duration_secs=1800)
    assert overrides["agent"] == {"prompt": {"prompt": "Bonjour."}, "first_message": "Allo", "language": "fr"}
    # speed is clamped to the ElevenLabs range
    assert overrides["tts"] == {"voice_id": "v123", "speed": 1.2}
    assert overrides["conversation"] == {"max_duration_seconds": 1860}
    plain = el.conversation_overrides(_agent(), system_prompt="", first_message="", max_duration_secs=None)
    assert plain["agent"] == {"prompt": {"prompt": ""}, "first_message": ""}
    assert plain["tts"] == {"voice_id": el.ELEVENLABS_DEFAULT_VOICE}
    assert plain["conversation"] == {"max_duration_seconds": 7200}


def test_duration_clamp_and_parsing():
    assert el.clamp_duration(None) == 7200
    assert el.clamp_duration(10) == 70
    assert el.clamp_duration(0) == 7200
    assert el.clamp_duration(600) == 660
    assert el.clamp_duration(7200) == 7200
    assert el.clamp_duration(99999) == 7200
    assert el.max_duration_seconds(_agent(maxDuration="900s")) == 900
    assert el.max_duration_seconds(_agent(maxDuration=120)) == 120
    assert el.max_duration_seconds(_agent(maxDuration="soon")) is None
    assert el.max_duration_seconds(_agent()) is None


def test_opening_plan():
    assert el.opening_plan(_agent(greeting={"text": " Acme, Sam speaking. "}), None) == ("Acme, Sam speaking.", None)
    first, opening = el.opening_plan(_agent(greeting={"instructions": "Greet warmly in French."}), None)
    assert first == "" and "Greet warmly in French." in opening and opening.startswith("(Instruction from the system")
    first, opening = el.opening_plan(_agent(), None)
    assert first == "" and "Greet the caller" in opening
    # a handover or takeover opening replaces the greeting, verbatim text included
    first, opening = el.opening_plan(_agent(greeting={"text": "Hello"}), "Introduce yourself.")
    assert first == "" and "Introduce yourself." in opening
    assert el.initiation_message({"a": 1})["type"] == "conversation_initiation_client_data"


def test_strip_audio_tags():
    assert el.strip_audio_tags("[warm] Bonjour, comment allez-vous?") == "Bonjour, comment allez-vous?"
    assert el.strip_audio_tags("Call [REF-42] is booked [laughs] now.") == "Call [REF-42] is booked now."
    assert el.strip_audio_tags("") == ""


# --- the REST client ---------------------------------------------------------------------


def _mock_client(handler) -> ElevenLabsAgentsClient:
    http = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return ElevenLabsAgentsClient("key", base_url="https://el.test", http=http)


@pytest.fixture(autouse=True)
def _fresh_cache():
    client_module.forget_known_agents()
    yield
    client_module.forget_known_agents()


def test_ensure_agent_finds_then_caches(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_AGENT_PREFIX", "t")
    config = el.agent_config(_agent(), llm="gemini-2.5-flash", tool_schemas=[])
    name = el.agent_name(el.config_hash(config))
    calls: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(f"{request.method} {request.url.path}")
        assert request.headers["xi-api-key"] == "key"
        if request.url.path == "/v1/convai/agents":
            assert request.url.params["search"] == name
            return httpx.Response(200, json={"agents": [
                {"agent_id": "agent_other", "name": name + "x"},
                {"agent_id": "agent_1", "name": name},
            ], "has_more": False})
        return httpx.Response(500)

    client = _mock_client(handler)
    assert asyncio.run(client.ensure_agent(config)) == "agent_1"
    assert asyncio.run(client.ensure_agent(config)) == "agent_1"
    assert calls == ["GET /v1/convai/agents"]


def test_ensure_agent_creates_on_a_miss_and_signs_the_url(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_AGENT_PREFIX", "t")
    config = el.agent_config(_agent(), llm="gemini-2.5-flash", tool_schemas=_schemas())
    created: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path == "/v1/convai/agents":
            return httpx.Response(200, json={"agents": [], "has_more": False})
        if request.method == "POST" and request.url.path == "/v1/convai/agents/create":
            created.append(json.loads(request.content))
            return httpx.Response(200, json={"agent_id": "agent_new"})
        if request.url.path == "/v1/convai/conversation/get-signed-url":
            assert request.url.params["agent_id"] == "agent_new"
            return httpx.Response(200, json={"signed_url": "wss://el.test/conv?token=1"})
        return httpx.Response(500)

    client = _mock_client(handler)
    agent_id, url = asyncio.run(client.conversation_url(config))
    assert (agent_id, url) == ("agent_new", "wss://el.test/conv?token=1")
    [body] = created
    assert body["name"] == el.agent_name(el.config_hash(config))
    assert body["conversation_config"]["agent"]["prompt"]["tools"][0]["name"] == "book_slot"
    assert "_v" not in body


def test_a_deleted_agent_is_recreated_once(monkeypatch):
    monkeypatch.setenv("ELEVENLABS_AGENT_PREFIX", "t")
    config = el.agent_config(_agent(), llm="gemini-2.5-flash", tool_schemas=[])
    name = el.agent_name(el.config_hash(config))
    client_module._known_agents[name] = "agent_stale"
    state = {"created": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/convai/conversation/get-signed-url":
            if request.url.params["agent_id"] == "agent_stale":
                return httpx.Response(404, json={"detail": "not found"})
            return httpx.Response(200, json={"signed_url": "wss://ok"})
        if request.method == "GET" and request.url.path == "/v1/convai/agents":
            return httpx.Response(200, json={"agents": [], "has_more": False})
        if request.url.path == "/v1/convai/agents/create":
            state["created"] += 1
            return httpx.Response(200, json={"agent_id": "agent_fresh"})
        return httpx.Response(500)

    client = _mock_client(handler)
    assert asyncio.run(client.conversation_url(config)) == ("agent_fresh", "wss://ok")
    assert state["created"] == 1


def test_errors_carry_the_status_and_body():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(422, json={"detail": [{"msg": "Max duration in seconds has to be between 60 and 7200"}]})

    client = _mock_client(handler)
    with pytest.raises(ElevenLabsAgentsError) as info:
        asyncio.run(client.create_agent({"name": "x"}))
    assert info.value.status == 422 and "7200" in str(info.value)


def test_list_agents_follows_the_cursor():
    pages = {None: {"agents": [{"agent_id": "1"}], "has_more": True, "next_cursor": "c2"},
             "c2": {"agents": [{"agent_id": "2"}], "has_more": False, "next_cursor": None}}

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=pages[request.url.params.get("cursor")])

    assert [a["agent_id"] for a in asyncio.run(_mock_client(handler).list_agents())] == ["1", "2"]


# --- the conversation service ----------------------------------------------------------


class _Socket:
    def __init__(self):
        self.sent: list[dict] = []

    async def send(self, raw: str) -> None:
        self.sent.append(json.loads(raw))

    async def close(self) -> None:
        return None


def _service(agent=None, *, platform_opening=None, on_session_ended=None, tool_schemas=None):
    agent = agent or _agent()
    llm = build_elevenlabs_agents_service(
        api_key="key",
        model_id=MODEL_ID,
        agent=agent,
        tool_schemas=_schemas() if tool_schemas is None else tool_schemas,
        system_prompt="You are Sam.",
        platform_opening=platform_opening,
        max_duration_secs=600,
        on_session_ended=on_session_ended,
    )
    frames: list = []
    calls: dict[str, list] = {"interruptions": [], "function_calls": []}

    async def push_frame(frame, direction=None):
        frames.append(frame)

    async def noop(*_args, **_kwargs):
        return None

    async def broadcast_interruption():
        calls["interruptions"].append(True)

    async def run_function_calls(function_calls):
        calls["function_calls"].extend(function_calls)

    llm.push_frame = push_frame  # type: ignore[method-assign]
    llm.broadcast_interruption = broadcast_interruption  # type: ignore[method-assign]
    llm.run_function_calls = run_function_calls  # type: ignore[method-assign]
    llm.create_task = lambda coro, *a, **k: asyncio.ensure_future(coro)  # type: ignore[method-assign]

    async def cancel_task(task, timeout=None):
        task.cancel()

    llm.cancel_task = cancel_task  # type: ignore[method-assign]
    for name in ("push_error", "start_processing_metrics", "stop_processing_metrics", "stop_ttfb_metrics", "stop_all_metrics"):
        setattr(llm, name, noop)
    socket = _Socket()
    llm._socket = socket  # type: ignore[assignment]
    # As after start() on a transport that reported the caller connected.
    llm._begun = True
    return llm, socket, frames, calls


def _types(frames) -> list[str]:
    return [type(f).__name__ for f in frames]


def _init(llm, out_format="pcm_24000"):
    return llm._handle_message({"type": "conversation_initiation_metadata", "conversation_initiation_metadata_event": {
        "conversation_id": "conv_1", "agent_output_audio_format": out_format, "user_input_audio_format": "pcm_16000"}})


def _audio(event_id, n=480):
    return {"type": "audio", "audio_event": {"audio_base_64": base64.b64encode(b"\x01" * n).decode(), "event_id": event_id}}


def test_service_settings_and_overrides():
    llm, _, _, _ = _service(_agent(greeting={"text": "Acme, Sam speaking."}, tts={"voice": "v9"}))
    assert llm._settings.model == "gemini-2.5-flash"
    assert llm.overrides["agent"] == {"prompt": {"prompt": "You are Sam."}, "first_message": "Acme, Sam speaking."}
    assert llm.overrides["tts"] == {"voice_id": "v9"} and llm.overrides["conversation"] == {"max_duration_seconds": 660}
    assert llm.config["conversation_config"]["agent"]["prompt"]["tools"][1]["name"] == "hangup"
    assert llm._opening_message is None
    assert llm.service_metadata_frame().is_realtime_service is True


def test_initiation_sends_the_opening_and_the_held_messages():
    llm, socket, _, _ = _service(_agent(greeting={"instructions": "Say bonjour."}))
    asyncio.run(llm.inject_dtmf("12#"))  # pressed before the conversation is ready
    assert socket.sent == []
    asyncio.run(_init(llm))
    assert llm.conversation_id == "conv_1" and llm._out_rate == 24000
    assert socket.sent[0]["type"] == "user_message" and "Say bonjour." in socket.sent[0]["text"]
    assert socket.sent[1] == {"type": "user_message", "text": "12#", "source_medium": "dtmf"}
    # a handover opening goes the same way, and only once
    llm2, socket2, _, _ = _service(platform_opening="Introduce yourself briefly.")
    asyncio.run(_init(llm2))
    asyncio.run(_init(llm2))
    assert [m["type"] for m in socket2.sent] == ["user_message"]
    assert "Introduce yourself briefly." in socket2.sent[0]["text"]


def test_a_reply_is_audio_then_its_text_once_complete():
    llm, _, frames, _ = _service()
    asyncio.run(_init(llm))

    async def scenario():
        await llm._handle_message({"type": "agent_response", "agent_response_event": {"agent_response": "[warm] Hello there.", "event_id": 7}})
        await llm._handle_message(_audio(7))
        await llm._handle_message(_audio(7))
        await llm._handle_message({"type": "agent_response_complete", "agent_response_complete_event": {"event_id": 7}})

    asyncio.run(scenario())
    assert _types(frames) == [
        "LLMFullResponseStartFrame", "TTSStartedFrame", "TTSAudioRawFrame", "TTSAudioRawFrame",
        "LLMTextFrame", "TTSStoppedFrame", "LLMFullResponseEndFrame",
    ]
    audio = [f for f in frames if isinstance(f, TTSAudioRawFrame)]
    assert audio[0].sample_rate == 24000 and audio[0].num_channels == 1 and len(audio[0].audio) == 480
    [text] = [f for f in frames if isinstance(f, LLMTextFrame)]
    assert text.text == "Hello there."
    assert llm._bot_responding is None and llm._response_text == {}


def test_the_output_rate_follows_the_metadata():
    llm, _, frames, _ = _service()
    asyncio.run(_init(llm, out_format="pcm_16000"))
    asyncio.run(llm._handle_message(_audio(1)))
    assert [f for f in frames if isinstance(f, TTSAudioRawFrame)][0].sample_rate == 16000


def test_a_new_reply_closes_the_previous_one():
    llm, _, frames, _ = _service()
    asyncio.run(_init(llm))

    async def scenario():
        await llm._handle_message({"type": "agent_response", "agent_response_event": {"agent_response": "One.", "event_id": 1}})
        await llm._handle_message(_audio(1))
        await llm._handle_message({"type": "agent_response", "agent_response_event": {"agent_response": "Two.", "event_id": 2}})
        await llm._handle_message(_audio(2))

    asyncio.run(scenario())
    assert _types(frames) == [
        "LLMFullResponseStartFrame", "TTSStartedFrame", "TTSAudioRawFrame",
        "LLMTextFrame", "TTSStoppedFrame", "LLMFullResponseEndFrame",
        "LLMFullResponseStartFrame", "TTSStartedFrame", "TTSAudioRawFrame",
    ]
    assert [f.text for f in frames if isinstance(f, LLMTextFrame)] == ["One."]
    assert llm._bot_responding == 2


def test_an_interruption_clears_playout_and_logs_the_corrected_text():
    llm, _, frames, calls = _service()
    asyncio.run(_init(llm))

    async def scenario():
        await llm._handle_message({"type": "agent_response", "agent_response_event": {"agent_response": "I cannot tell long stories; I am terse.", "event_id": 5}})
        await llm._handle_message(_audio(5))
        await llm._handle_message({"type": "interruption", "interruption_event": {"event_id": 6}})
        assert calls["interruptions"] == [True]
        assert llm._bot_responding == 5  # waiting for the correction
        await llm._handle_message({"type": "agent_response_correction", "agent_response_correction_event": {
            "original_agent_response": "I cannot tell long stories; I am terse.", "corrected_agent_response": "I cannot tell long...", "event_id": 5}})
        await asyncio.sleep(0)

    asyncio.run(scenario())
    assert [f.text for f in frames if isinstance(f, LLMTextFrame)] == ["I cannot tell long..."]
    assert _types(frames)[-2:] == ["TTSStoppedFrame", "LLMFullResponseEndFrame"]
    assert llm._bot_responding is None and llm._close_timers == {}


def test_an_interruption_without_a_correction_closes_after_the_grace(monkeypatch):
    import pipecat_aplisay.elevenlabs_agents_service as service_module

    monkeypatch.setattr(service_module, "CORRECTION_GRACE_SECS", 0.01)
    llm, _, frames, _ = _service()
    asyncio.run(_init(llm))

    async def scenario():
        await llm._handle_message({"type": "agent_response", "agent_response_event": {"agent_response": "Full text.", "event_id": 3}})
        await llm._handle_message(_audio(3))
        await llm._handle_message({"type": "interruption", "interruption_event": {"event_id": 4}})
        await asyncio.sleep(0.05)

    asyncio.run(scenario())
    assert [f.text for f in frames if isinstance(f, LLMTextFrame)] == ["Full text."]
    assert llm._bot_responding is None
    assert CORRECTION_GRACE_SECS > 0.01


def test_a_text_only_reply_still_reaches_the_transcript():
    llm, _, frames, _ = _service()
    asyncio.run(_init(llm))

    async def scenario():
        await llm._handle_message({"type": "agent_response", "agent_response_event": {"agent_response": "Noted.", "event_id": 9}})
        await llm._handle_message({"type": "agent_response_complete", "agent_response_complete_event": {"event_id": 9}})

    asyncio.run(scenario())
    assert _types(frames) == ["LLMFullResponseStartFrame", "LLMTextFrame", "LLMFullResponseEndFrame"]


def test_user_transcripts_go_upstream_and_injected_echoes_are_dropped():
    llm, socket, frames, _ = _service()
    asyncio.run(_init(llm))

    async def scenario():
        await llm._handle_message({"type": "user_transcript", "user_transcription_event": {"user_transcript": "What time is it?", "event_id": 2}})
        await llm.inject_dtmf("12#")
        await llm._handle_message({"type": "user_transcript", "user_transcription_event": {"user_transcript": "12#", "event_id": 3}})
        await llm.inject_inactivity_prompt("Are you still there?")
        await llm._handle_message({"type": "user_transcript", "user_transcription_event": {"user_transcript": socket.sent[-1]["text"], "event_id": 4}})
        await llm._handle_message({"type": "user_transcript", "user_transcription_event": {"user_transcript": "12#", "event_id": 5}})

    asyncio.run(scenario())
    transcripts = [f.text for f in frames if isinstance(f, TranscriptionFrame)]
    # the second "12#" is the caller's, not an echo: each injection covers one echo
    assert transcripts == ["What time is it?", "12#"]
    kick = socket.sent[-1]
    assert kick["type"] == "user_message" and "Are you still there?" in kick["text"] and "source_medium" not in kick
    assert socket.sent[-2] == {"type": "user_message", "text": "12#", "source_medium": "dtmf"}


def test_ping_is_answered_with_a_pong():
    llm, socket, _, _ = _service()
    asyncio.run(llm._handle_message({"type": "ping", "ping_event": {"event_id": 42, "ping_ms": 120}}))
    assert socket.sent == [{"type": "pong", "event_id": 42}]


def test_a_tool_call_runs_the_platform_function_and_the_result_goes_back_once():
    llm, socket, _, calls = _service()
    asyncio.run(llm._handle_message({"type": "client_tool_call", "client_tool_call": {
        "tool_name": "book_slot", "tool_call_id": "book_slot_1", "parameters": {"when": "2026-11-01", "size": 2}, "expects_response": True}}))
    [call] = calls["function_calls"]
    assert call.function_name == "book_slot" and call.tool_call_id == "book_slot_1"
    assert call.arguments == {"when": "2026-11-01", "size": 2}
    # a data tool answers natively, once, and the context replay never repeats it
    asyncio.run(llm.deliver_native_tool_result("book_slot_1", {"ok": True, "ref": "B42"}))
    asyncio.run(llm.deliver_native_tool_result("book_slot_1", {"ok": True, "ref": "B42"}))
    assert socket.sent == [{"type": "client_tool_result", "tool_call_id": "book_slot_1", "result": '{"ok": true, "ref": "B42"}', "is_error": False}]
    context = LLMContext([
        {"role": "developer", "content": "You are Sam."},
        {"role": "tool", "tool_call_id": "book_slot_1", "content": '{"ok": true}'},
        {"role": "tool", "tool_call_id": "hangup_1", "content": '{"ok": true}'},
        {"role": "tool", "tool_call_id": "pending", "content": "IN_PROGRESS"},
    ])
    asyncio.run(llm._handle_context(context))
    assert socket.sent[1:] == [{"type": "client_tool_result", "tool_call_id": "hangup_1", "result": '{"ok": true}', "is_error": False}]
    asyncio.run(llm._handle_context(context))
    assert len(socket.sent) == 2
    # an error result is flagged
    asyncio.run(llm.deliver_native_tool_result("x", {"error": "boom"}))
    assert socket.sent[-1]["is_error"] is True


def test_caller_audio_is_resampled_and_sent_in_chunks():
    llm, socket, frames, _ = _service()
    asyncio.run(_init(llm))

    async def scenario():
        # 20 ms frames at the wire rate: 640 bytes each; 100 ms is 3200 bytes
        for _ in range(10):
            await llm._send_user_audio(InputAudioRawFrame(audio=b"\x00" * 640, sample_rate=16000, num_channels=1))

    asyncio.run(scenario())
    chunks = [m for m in socket.sent if "user_audio_chunk" in m]
    assert len(chunks) == 2
    assert all(len(base64.b64decode(c["user_audio_chunk"])) == 3200 for c in chunks)
    assert frames == []

    async def telephony():
        # 8 kHz frames are resampled to the wire rate before they are chunked
        for _ in range(50):
            await llm._send_user_audio(InputAudioRawFrame(audio=b"\x00" * 320, sample_rate=8000, num_channels=1))

    asyncio.run(telephony())
    more = [m for m in socket.sent if "user_audio_chunk" in m]
    assert len(more) > 2
    assert all(len(base64.b64decode(c["user_audio_chunk"])) == 3200 for c in more)


def test_the_provider_closing_the_socket_ends_the_call_once():
    ended: list[str] = []

    async def on_ended(reason):
        ended.append(reason)

    class _Closed:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

        async def close(self):
            return None

    llm, _, frames, _ = _service(on_session_ended=on_ended)
    llm._socket = _Closed()  # type: ignore[assignment]
    asyncio.run(llm._handle_message({"type": "agent_response", "agent_response_event": {"agent_response": "Bye.", "event_id": 1}}))
    asyncio.run(llm._handle_message(_audio(1)))
    asyncio.run(llm._receive_messages())
    assert ended == ["connection_closed"]
    # the open reply was closed with its text
    assert [f.text for f in frames if isinstance(f, LLMTextFrame)] == ["Bye."]
    asyncio.run(llm._receive_messages())
    assert len(ended) == 1
    # our own disconnect is not the provider ending the session
    llm2, _, _, _ = _service(on_session_ended=on_ended)
    llm2._socket = _Closed()  # type: ignore[assignment]
    llm2._disconnecting = True
    asyncio.run(llm2._receive_messages())
    assert len(ended) == 1


# --- wiring ---------------------------------------------------------------------------------


def test_elevenlabs_always_restarts_on_handover():
    from pipecat_aplisay import api_client
    from pipecat_aplisay.call_session import CallSession

    call = api_client.CallRecord(id="c", userId="u", organisationId="o", instanceId="i", agentId="a", persisted=False)
    session = CallSession(session_id="s", agent=_agent(), instance={}, call=call, sip_gateway=None, gateway_session=None)  # type: ignore[arg-type]
    assert session._needs_full_handover({"modelName": ROW}) is True
    session.agent = {"modelName": "pipecat:openai/gpt-realtime"}
    session._active_model_name = "pipecat:openai/gpt-realtime"
    assert session._needs_full_handover({"modelName": "pipecat:elevenlabs/gpt-5.4-mini"}) is True


def test_the_elevenlabs_row_begins_the_conversation_when_the_caller_connects():
    from pipecat_aplisay import api_client
    from pipecat_aplisay.call_session import CallSession

    class _Transport:
        def __init__(self):
            self.handlers: dict[str, list] = {}

        def event_handler(self, name):
            def register(fn):
                self.handlers.setdefault(name, []).append(fn)
                return fn

            return register

    class _Llm:
        begun = 0

        async def begin_conversation(self):
            self.begun += 1

    call = api_client.CallRecord(id="c", userId="u", organisationId="o", instanceId="i", agentId="a", persisted=False)
    session = CallSession(session_id="s", agent=_agent(), instance={}, call=call, sip_gateway=None, gateway_session=None)  # type: ignore[arg-type]
    session._llm_service = _Llm()
    transport = _Transport()
    asyncio.run(session._wire_greeting(transport, object(), _agent(greeting={"text": "Hello"}), "realtime", ROW))
    # the generic greeting frames are not queued; the conversation begins on connect instead
    [handler] = transport.handlers["on_client_connected"]
    asyncio.run(handler())
    assert session._llm_service.begun == 1
    plain = _Transport()
    asyncio.run(session._wire_greeting(plain, object(), _agent(greeting={"text": "Hello"}), "realtime", "pipecat:openai/gpt-realtime"))
    assert list(plain.handlers) == ["on_client_connected"]


def test_a_deferred_conversation_waits_for_begin_and_drops_audio_until_then():
    llm, socket, frames, _ = _service()
    llm._defer_initiation = True
    llm._begun = False

    async def scenario():
        # audio before the conversation has begun goes nowhere (the server has no overrides yet)
        await llm._send_user_audio(InputAudioRawFrame(audio=b"\x01" * 6400, sample_rate=16000, num_channels=1))
        assert socket.sent == []
        await llm.begin_conversation()
        assert [m["type"] for m in socket.sent] == ["conversation_initiation_client_data"]
        assert socket.sent[0]["conversation_config_override"]["agent"]["prompt"]["prompt"] == "You are Sam."
        await llm.begin_conversation()
        assert len(socket.sent) == 1
        await llm._send_user_audio(InputAudioRawFrame(audio=b"\x01" * 6400, sample_rate=16000, num_channels=1))
        assert any("user_audio_chunk" in m for m in socket.sent)

    asyncio.run(scenario())
    assert llm.begun is True
    # a begin before the socket opens is honoured at start: the deferral is cleared
    early, early_socket, _, _ = _service()
    early._socket = None  # type: ignore[assignment]
    early._defer_initiation = True
    early._begun = False
    asyncio.run(early.begin_conversation())
    assert early.begun is False and early._defer_initiation is False
    assert early_socket.sent == []


def test_tools_register_for_native_results():
    from pipecat_aplisay.voice_session import _deliver_native_result, _register_tools_on_llm

    llm, socket, _, _ = _service()
    registered: dict[str, bool] = {}

    def register_function(name, handler, *, cancel_on_interruption=True, timeout_secs=None):
        registered[name] = cancel_on_interruption

    llm.register_function = register_function  # type: ignore[method-assign]

    async def execute(_args):
        return {"ok": True}

    tools = [
        {"schema": {"name": "lookup", "description": "", "properties": {}, "required": []}, "execute": execute, "kind": "function"},
        {"schema": {"name": "hangup", "description": "", "properties": {}, "required": []}, "execute": execute, "kind": "builtin", "protect_from_interruption": True},
    ]
    _register_tools_on_llm(llm, tools)
    # a data tool survives interruption and answers natively; a builtin stays synchronous
    assert registered == {"lookup": False, "hangup": True}

    class _Params:
        tool_call_id = "lookup_1"

    params = _Params()
    params.llm = llm  # type: ignore[attr-defined]
    asyncio.run(_deliver_native_result(params, {"ok": True}))
    assert socket.sent == [{"type": "client_tool_result", "tool_call_id": "lookup_1", "result": '{"ok": true}', "is_error": False}]


def test_inactivity_kick_uses_the_injector():
    from pipecat_aplisay.voice_session import _wire_inactivity_kick

    class _Aggregator:
        def __init__(self):
            self.handlers = {}

        def event_handler(self, name):
            def register(fn):
                self.handlers[name] = fn
                return fn

            return register

    llm, socket, _, _ = _service()
    asyncio.run(_init(llm))
    aggregator = _Aggregator()
    _wire_inactivity_kick(
        user_aggregator=aggregator,
        task_ref_getter=lambda: object(),
        agent=_agent(inactivity={"timeout": 8, "message": "Are you still there?"}),
        mode="realtime",
        is_ultravox=False,
        inject=llm.inject_inactivity_prompt,
    )
    asyncio.run(aggregator.handlers["on_user_turn_idle"](aggregator))
    assert socket.sent[-1]["type"] == "user_message" and "Are you still there?" in socket.sent[-1]["text"]


def test_silence_fills_the_gaps_in_caller_audio(monkeypatch):
    import pipecat_aplisay.elevenlabs_agents_service as service_module

    monkeypatch.setattr(service_module, "SILENCE_FILL_MS", 20)
    llm, socket, _, _ = _service()

    async def scenario():
        await _init(llm)
        assert llm._fill_task is not None
        await asyncio.sleep(0.09)
        filled = [m for m in socket.sent if "user_audio_chunk" in m]
        assert 2 <= len(filled) <= 5
        assert all(base64.b64decode(m["user_audio_chunk"]) == b"\x00" * 640 for m in filled)
        # real caller audio holds the filler off
        before = len(socket.sent)
        for _ in range(5):
            await llm._send_user_audio(InputAudioRawFrame(audio=b"\x01" * 640, sample_rate=16000, num_channels=1))
            await asyncio.sleep(0.015)
        real = [m for m in socket.sent[before:] if "user_audio_chunk" in m]
        assert len(real) >= 1 and all(base64.b64decode(m["user_audio_chunk"]) != b"\x00" * 3200 for m in real)
        await llm._disconnect()
        assert llm._fill_task is None

    asyncio.run(scenario())
