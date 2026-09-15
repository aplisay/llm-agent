"""xAI Grok on the Pipecat worker (docs/grok.md): :mod:`pipecat_aplisay.grok`,
:mod:`pipecat_aplisay.grok_service` and the wiring in ``voice_session`` /
``call_session``.

These tests lock, without a network or a transport:

* the option mappings: the session properties (voice default, server VAD,
  transcription with the language hint, reasoning effort), the effort rule,
  the vendorSpecific overrides and their server-tool strip;
* the service: the vendorSpecific merge into ``session.update``, the audio
  input format fill, the verbatim item, keypad digits, the context
  watermark (a developer message becomes a system item and a response; user
  turns are never resent), the held first response behind a forced
  greeting, the interim transcription split, and the provider-ended mapping
  for the concurrent-session refusal, a fatal error and a server close;
* the wiring: no text-output mode, ``xai`` as the native TTS vendor, the
  pipeline ids, the usage vendor split, the full-restart rule and the
  greeting handler.
"""

from __future__ import annotations

import asyncio
import json

import pytest
from pipecat.adapters.schemas.tools_schema import ToolsSchema
from pipecat.frames.frames import InterimTranscriptionFrame, TranscriptionFrame
from pipecat.processors.aggregators.llm_context import LLMContext
from pipecat.services.xai.realtime import events

from pipecat_aplisay import grok
from pipecat_aplisay.grok import (
    is_xai_model_id,
    is_xai_voice_model_id,
    language_hint,
    strip_server_tools,
    voice_effort,
    xai_session_overrides,
)
from pipecat_aplisay.pipeline_model_ids import is_pipeline_model_id
from pipecat_aplisay.realtime_tts import external_tts_vendor, text_output_enabled, text_output_supported
from pipecat_aplisay.usage import usage_vendors
from pipecat_aplisay.voice_session import _xai_session_properties

grok_service = pytest.importorskip("pipecat_aplisay.grok_service")

GROK = "pipecat:xai/grok-voice-think-fast-2.0"


def _agent(**options) -> dict:
    return {"id": "a1", "name": "Sam", "modelName": GROK, "prompt": "You are Sam.", "options": options}


# --- model ids and rules --------------------------------------------------------


def test_model_id_rules():
    assert is_xai_voice_model_id("xai/grok-voice-think-fast-2.0") is True
    assert is_xai_voice_model_id("XAI/Grok-Voice-Latest") is True
    assert is_xai_voice_model_id("xai/grok-4.3") is False
    assert is_xai_model_id("xai/grok-4.3") is True
    assert is_xai_model_id("openai/gpt-realtime") is False
    assert is_xai_voice_model_id(None) is False


def test_pipeline_rows_and_no_text_output_mode():
    assert is_pipeline_model_id("xai/grok-4.3") is True
    assert is_pipeline_model_id("xai/grok-4.20-0309-non-reasoning") is True
    assert is_pipeline_model_id("xai/grok-voice-think-fast-2.0") is False
    assert text_output_supported("xai/grok-voice-think-fast-2.0") is False
    ext = {"options": {"tts": {"vendor": "elevenlabs", "voice": "Rachel"}}}
    assert text_output_enabled(ext, "xai/grok-voice-think-fast-2.0") is False
    # xai is the model's own vendor
    assert external_tts_vendor({"options": {"tts": {"vendor": "xai", "voice": "rex"}}}, "xai/grok-voice-think-fast-2.0") is None
    assert external_tts_vendor(ext, "xai/grok-voice-think-fast-2.0") == "elevenlabs"


def test_usage_vendor_split():
    services = usage_vendors(_agent(tts={"voice": "rex"}), GROK)
    assert services["llm"] == {"vendor": "xai", "model": "grok-voice-think-fast-2.0"}
    # the model's own speech is metered as xai (bundled in the minute line),
    # not as the pipeline's default TTS vendor (seen as tts|cartesia on the
    # first live call)
    assert services["tts"] == {"vendor": "xai", "model": "rex"}
    # a pipeline row keeps the pipeline default
    assert usage_vendors(_agent(), "pipecat:xai/grok-4.3")["tts"]["vendor"] == "cartesia"


# --- option mappings -------------------------------------------------------------


def test_voice_effort_rule():
    assert voice_effort({}) is None
    assert voice_effort({"effort": "none"}) == "none"
    assert voice_effort({"effort": "low"}) == "none"
    for level in ("medium", "high", "xhigh", "max", " High "):
        assert voice_effort({"effort": level}) == "high"
    assert voice_effort({"effort": "bogus"}) is None
    assert voice_effort({"effort": 3}) is None


def test_language_hint_is_the_primary_subtag():
    assert language_hint(_agent(stt={"language": "en-GB"})) == "en"
    assert language_hint(_agent(tts={"language": "fr-FR"})) == "fr"
    assert language_hint(_agent()) is None
    assert language_hint(_agent(stt={"language": "any"})) is None


def test_session_properties():
    props = _xai_session_properties(_agent(tts={"voice": "rex"}, stt={"language": "de-DE"}, effort="max"))
    assert props.voice == "rex"
    assert props.turn_detection.type == "server_vad"
    assert props.turn_detection.threshold is None and props.turn_detection.idle_timeout_ms is None
    assert props.audio.input.transcription.model == grok.XAI_TRANSCRIPTION_MODEL
    assert props.audio.input.transcription.language_hint == "de"
    assert props.reasoning.effort == "high"
    # no output block, no text mode: the service fills the audio formats
    assert props.audio.output is None
    plain = _xai_session_properties(_agent())
    assert plain.voice == grok.XAI_DEFAULT_VOICE == "eve"
    assert plain.audio.input.transcription.language_hint is None
    assert plain.reasoning is None
    # xAI's own session default is manual turn detection, so it is always asked for
    assert plain.turn_detection is not None and plain.turn_detection.type == "server_vad"


def test_vendor_overrides_and_the_server_tool_strip():
    agent = _agent(vendorSpecific={"xai": {"session": {
        "turn_detection": {"type": "server_vad", "silence_duration_ms": 350},
        "replace": {"Aplisay": "Appli-say"},
        "tools": [{"type": "web_search"}],
        "extra": [{"type": "mcp", "server_url": "https://x"}, {"type": "function", "name": "f"}],
        "hosted": {"type": "file_search", "vector_store_ids": ["v"]},
    }}})
    overrides = xai_session_overrides(agent)
    assert "tools" in overrides
    stripped = strip_server_tools(overrides)
    assert stripped == {
        "turn_detection": {"type": "server_vad", "silence_duration_ms": 350},
        "replace": {"Aplisay": "Appli-say"},
        "extra": [{"type": "function", "name": "f"}],
    }
    assert xai_session_overrides(_agent()) == {}
    assert xai_session_overrides(_agent(vendorSpecific={"xai": {"session": []}})) == {}
    assert xai_session_overrides(_agent(vendorSpecific={"ultravox": {}})) == {}


# --- the service -------------------------------------------------------------------


def _build(agent: dict | None = None, on_session_ended=None):
    agent = agent or _agent()
    llm = grok_service.build_grok_service(
        api_key="xai-test",
        model="grok-voice-think-fast-2.0",
        system_prompt="You are Sam.",
        session_properties=_xai_session_properties(agent),
        agent=agent,
        on_session_ended=on_session_ended,
    )
    sent: list[dict] = []

    async def capture(payload):
        sent.append(payload)

    async def noop(*_args, **_kwargs):
        return None

    llm._ws_send = capture  # type: ignore[method-assign]
    for name in ("push_frame", "push_error", "start_processing_metrics", "start_ttfb_metrics",
                 "stop_processing_metrics", "stop_ttfb_metrics", "stop_all_metrics", "start_llm_usage_metrics"):
        setattr(llm, name, noop)
    llm._api_session_ready = True
    return llm, sent


def _context(messages=None) -> LLMContext:
    return LLMContext(list(messages or []), tools=ToolsSchema(standard_tools=[]))


def test_service_settings_and_audio_format_fill():
    llm, _ = _build(_agent(tts={"voice": "leo"}))
    assert llm._settings.model == "grok-voice-think-fast-2.0"
    assert llm._settings.system_instruction == "You are Sam."
    props = llm._settings.session_properties
    assert props.instructions == "You are Sam."
    assert props.voice == "leo"
    llm._ensure_audio_config(16000, 24000)
    # the input block exists (it carries the transcription request), so upstream
    # would leave its format unset and the server would assume 24 kHz
    assert props.audio.input.format.rate == 16000
    assert props.audio.output.format.rate == 24000
    assert props.audio.input.transcription.model == "grok-transcribe"


def test_session_update_carries_the_vendor_overrides_minus_server_tools():
    agent = _agent(vendorSpecific={"xai": {"session": {
        "turn_detection": {"type": "server_vad", "silence_duration_ms": 350},
        "replace": {"Aplisay": "Appli-say"},
        "tools": [{"type": "web_search"}],
    }}})
    llm, sent = _build(agent)
    asyncio.run(llm._send_session_update())
    [payload] = sent
    assert payload["type"] == "session.update"
    s = payload["session"]
    assert s["instructions"] == "You are Sam."
    assert s["voice"] == "eve"
    assert s["turn_detection"] == {"type": "server_vad", "silence_duration_ms": 350}
    assert s["replace"] == {"Aplisay": "Appli-say"}
    assert "tools" not in s
    assert s["audio"]["input"]["transcription"] == {"model": "grok-transcribe"}


def test_speak_verbatim_sends_an_uninterruptible_force_message():
    llm, sent = _build()
    asyncio.run(llm.speak_verbatim("  Acme Dental, Sam speaking.  "))
    [payload] = sent
    assert payload == {
        "type": "conversation.item.create",
        "item": {
            "type": "force_message",
            "role": "assistant",
            "content": [{"type": "text", "text": "Acme Dental, Sam speaking."}],
            "interruptible": False,
        },
    }
    sent.clear()
    asyncio.run(llm.speak_verbatim("   "))
    assert sent == []


def test_speak_verbatim_waits_for_the_session(monkeypatch):
    monkeypatch.setattr(grok_service, "SESSION_READY_TIMEOUT_SECS", 0.2)
    llm, sent = _build()
    llm._api_session_ready = False

    async def scenario():
        task = asyncio.create_task(llm.speak_verbatim("Hello"))
        await asyncio.sleep(0.05)
        assert sent == []
        llm._api_session_ready = True
        await task

    asyncio.run(scenario())
    assert sent[0]["item"]["type"] == "force_message"
    llm._api_session_ready = False
    with pytest.raises(RuntimeError):
        asyncio.run(llm.speak_verbatim("Hello"))


def test_inject_dtmf_is_a_user_item_and_a_response():
    llm, sent = _build()
    llm._context = _context()
    llm._llm_needs_conversation_setup = False
    asyncio.run(llm.inject_dtmf("1234"))
    assert [p["type"] for p in sent] == ["conversation.item.create", "response.create"]
    item = sent[0]["item"]
    assert item["type"] == "message" and item["role"] == "user"
    assert item["content"] == [{"type": "input_text", "text": grok.DTMF_MESSAGE.format(digits="1234")}]
    assert sent[1]["response"]["modalities"] == ["text", "audio"]
    # before the first turn the item is sent and the first run answers it
    llm2, sent2 = _build()
    asyncio.run(llm2.inject_dtmf("5"))
    assert [p["type"] for p in sent2] == ["conversation.item.create"]
    # nothing is sent before the session is ready
    llm3, sent3 = _build()
    llm3._api_session_ready = False
    asyncio.run(llm3.inject_dtmf("5"))
    assert sent3 == []


def test_first_run_seeds_history_and_holds_the_response_behind_a_forced_greeting():
    llm, sent = _build()
    llm.hold_first_response()
    history = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
    asyncio.run(llm._handle_context(_context(history)))
    kinds = [p["type"] for p in sent]
    # the packed history item, then the session update with the tools, no response
    assert kinds == ["conversation.item.create", "session.update"]
    assert sent[0]["item"]["role"] == "user"
    assert "previously saved conversation" in sent[0]["item"]["content"][0]["text"]
    assert llm._llm_needs_conversation_setup is False
    assert llm._sent_messages == 2
    assert llm._hold_first_response is False
    # a plain first run asks the model to speak
    llm2, sent2 = _build()
    asyncio.run(llm2._handle_context(_context()))
    assert [p["type"] for p in sent2] == ["session.update", "response.create"]


def test_context_watermark_sends_developer_messages_but_never_user_turns():
    llm, sent = _build()
    asyncio.run(llm._handle_context(_context()))
    sent.clear()
    # a transcribed user turn lands in the context: the server already has it
    ctx = _context([{"role": "user", "content": "I need an appointment"}])
    asyncio.run(llm._handle_context(ctx))
    assert sent == []
    # an appended developer message (greeting instructions, an opening) is new
    ctx = _context([
        {"role": "user", "content": "I need an appointment"},
        {"role": "developer", "content": [{"type": "text", "text": "Say goodbye now."}]},
    ])
    asyncio.run(llm._handle_context(ctx))
    assert [p["type"] for p in sent] == ["conversation.item.create", "response.create"]
    assert sent[0]["item"] == {
        "id": sent[0]["item"]["id"], "type": "message", "role": "system",
        "content": [{"type": "input_text", "text": "Say goodbye now."}],
    }
    assert llm._sent_messages == 2
    sent.clear()
    # the same context again sends nothing
    asyncio.run(llm._handle_context(ctx))
    assert sent == []
    # a context replaced wholesale resets the watermark instead of slicing past the end
    asyncio.run(llm._handle_context(_context([{"role": "assistant", "content": "ok"}])))
    assert sent == [] and llm._sent_messages == 1


def test_a_tool_result_creates_one_response_only():
    llm, sent = _build()
    asyncio.run(llm._handle_context(_context()))
    sent.clear()
    ctx = _context([
        {"role": "developer", "content": "Answer now."},
        {"role": "tool", "tool_call_id": "call-1", "content": '{"ok": true}'},
    ])
    asyncio.run(llm._handle_context(ctx))
    kinds = [p["type"] for p in sent]
    assert kinds.count("response.create") == 1
    assert [p["item"]["type"] for p in sent if p["type"] == "conversation.item.create"] == ["message", "function_call_output"]


def test_interim_transcription_completed_events_are_interim_frames():
    llm, _ = _build()
    pushed: list = []

    async def push_frame(frame, direction=None):
        pushed.append(frame)

    llm.push_frame = push_frame  # type: ignore[method-assign]
    base = {"event_id": "e1", "type": "conversation.item.input_audio_transcription.completed", "item_id": "i1", "content_index": 0}
    interim = events.parse_server_event(json.dumps({**base, "transcript": "Hello, I would", "status": "in_progress"}))
    final = events.parse_server_event(json.dumps({**base, "transcript": "Hello, I would like to book.", "status": "completed"}))
    assert isinstance(interim, grok_service._TranscriptionCompleted) and interim.status == "in_progress"
    asyncio.run(llm._handle_evt_input_audio_transcription_completed(interim))
    asyncio.run(llm._handle_evt_input_audio_transcription_completed(final))
    assert [type(f) for f in pushed] == [InterimTranscriptionFrame, TranscriptionFrame]
    assert pushed[0].text == "Hello, I would"
    assert pushed[1].text == "Hello, I would like to book."


def test_provider_ended_paths_end_the_call_once():
    ended: list[str] = []

    async def on_ended(reason):
        ended.append(reason)

    llm, _ = _build(on_session_ended=on_ended)
    llm._context = _context()
    refused = events.parse_server_event(json.dumps({
        "event_id": "e2", "type": "response.done",
        "response": {"id": "r1", "object": "realtime.response", "output": [], "status": "failed",
                     "status_details": {"type": "failed", "error": {"type": "invalid_request_error", "code": "rate_limit_exceeded",
                                                                     "message": "Too many concurrent sessions. Limit is 10."}}},
    }))
    asyncio.run(llm._handle_evt_response_done(refused))
    assert ended == ["rate_limit_exceeded: Too many concurrent sessions. Limit is 10."]
    # the socket close that follows is not reported twice
    class _Closed:
        def __aiter__(self):
            return self

        async def __anext__(self):
            raise StopAsyncIteration

    llm._websocket = _Closed()
    asyncio.run(llm._receive_task_handler())
    assert len(ended) == 1
    # a fatal error on a fresh service
    llm2, _ = _build(on_session_ended=on_ended)
    error = events.parse_server_event(json.dumps({
        "event_id": "e3", "type": "error",
        "error": {"type": "invalid_request_error", "code": "invalid_value", "message": "bad voice"},
    }))
    asyncio.run(llm2._handle_evt_error(error))
    assert ended[-1] == "error: bad voice"
    # a server close on a third
    llm3, _ = _build(on_session_ended=on_ended)
    llm3._websocket = _Closed()
    asyncio.run(llm3._receive_task_handler())
    assert ended[-1] == "connection_closed"
    # our own disconnect is not the provider ending the session
    llm4, _ = _build(on_session_ended=on_ended)
    llm4._websocket = _Closed()
    llm4._disconnecting = True
    asyncio.run(llm4._receive_task_handler())
    assert ended[-1] == "connection_closed" and len(ended) == 3


# --- wiring ---------------------------------------------------------------------------


def test_grok_always_restarts_on_handover():
    from pipecat_aplisay import api_client
    from pipecat_aplisay.call_session import CallSession

    call = api_client.CallRecord(id="c", userId="u", organisationId="o", instanceId="i", agentId="a", persisted=False)
    session = CallSession(session_id="s", agent=_agent(), instance={}, call=call, sip_gateway=None, gateway_session=None)  # type: ignore[arg-type]
    assert session._needs_full_handover({"modelName": GROK}) is True
    session.agent = {"modelName": "pipecat:openai/gpt-realtime"}
    session._active_model_name = "pipecat:openai/gpt-realtime"
    assert session._needs_full_handover({"modelName": "pipecat:openai/gpt-realtime"}) is False
    assert session._needs_full_handover({"modelName": GROK}) is True


def test_greeting_text_is_spoken_verbatim_after_a_held_first_run():
    from pipecat.frames.frames import LLMRunFrame

    from pipecat_aplisay import api_client
    from pipecat_aplisay.call_session import CallSession

    class _Transport:
        def __init__(self):
            self.handlers = {}

        def event_handler(self, name):
            def register(fn):
                self.handlers[name] = fn
                return fn

            return register

    class _Task:
        def __init__(self):
            self.frames = []

        async def queue_frames(self, frames):
            self.frames.extend(frames)

    class _Llm:
        def __init__(self):
            self.calls = []

        def hold_first_response(self):
            self.calls.append("hold")

        async def speak_verbatim(self, text):
            self.calls.append(("verbatim", text))

    call = api_client.CallRecord(id="c", userId="u", organisationId="o", instanceId="i", agentId="a", persisted=False)
    agent = _agent(greeting={"text": "Acme Dental, Sam speaking."})
    session = CallSession(session_id="s", agent=agent, instance={}, call=call, sip_gateway=None, gateway_session=None)  # type: ignore[arg-type]
    llm = _Llm()
    session._llm_service = llm
    transport, task = _Transport(), _Task()
    asyncio.run(session._wire_greeting(transport, task, agent, "realtime", GROK))
    asyncio.run(transport.handlers["on_client_connected"]())
    assert llm.calls == ["hold", ("verbatim", "Acme Dental, Sam speaking.")]
    assert [type(f) for f in task.frames] == [LLMRunFrame]
    # greeting instructions take the generic path: a developer message and a run
    agent2 = _agent(greeting={"instructions": "Greet warmly."})
    session2 = CallSession(session_id="s", agent=agent2, instance={}, call=call, sip_gateway=None, gateway_session=None)  # type: ignore[arg-type]
    session2._llm_service = _Llm()
    transport2, task2 = _Transport(), _Task()
    asyncio.run(session2._wire_greeting(transport2, task2, agent2, "realtime", GROK))
    asyncio.run(transport2.handlers["on_client_connected"]())
    assert session2._llm_service.calls == []
    assert len(task2.frames) == 2 and isinstance(task2.frames[1], LLMRunFrame)
    assert "Greet warmly." in task2.frames[0].messages[0]["content"]


def test_inactivity_kick_uses_the_verbatim_injector():
    from pipecat_aplisay.voice_session import _wire_inactivity_kick

    class _Aggregator:
        def __init__(self):
            self.handlers = {}

        def event_handler(self, name):
            def register(fn):
                self.handlers[name] = fn
                return fn

            return register

    spoken: list[str] = []

    async def speak_verbatim(message):
        spoken.append(message)

    aggregator = _Aggregator()
    _wire_inactivity_kick(
        user_aggregator=aggregator,
        task_ref_getter=lambda: object(),
        agent=_agent(inactivity={"timeout": 8, "message": "Are you still there?"}),
        mode="realtime",
        is_ultravox=False,
        inject=speak_verbatim,
    )
    asyncio.run(aggregator.handlers["on_user_turn_idle"](aggregator))
    assert spoken == ["Are you still there?"]
