"""GPT-Live on the Pipecat worker (docs/gpt-live.md): :mod:`pipecat_aplisay.gpt_live`,
:mod:`pipecat_aplisay.gpt_live_service` and the wiring in ``voice_session`` /
``call_session``.

These tests lock, without a network or a transport:

* delegate resolution: declared (static and metadata-sourced), synthetic when
  absent, and the synthetic fallback when the target is missing, not a text
  agent or cannot be fetched;
* mode selection from the delegate's model, and the prompt composition;
* the tool merge (delegate wins a clash) and that the ``delegate`` declaration
  is never a tool;
* the service: the Responses delegation config, ``vendorSpecific.openai.live``
  merged into ``session.start``, the context seeded without the prompt, the
  greeting opening instruction, the injection shim's events (DTMF, inactivity),
  the client-delegation round trip (answer as commentary, failure as an
  apology), and the provider-close callback;
* the output audit tap's frame class, the full-restart rule, and the usage
  relabel to the delegate's model.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from pipecat.frames.frames import OutputAudioRawFrame, TTSAudioRawFrame

from pipecat_aplisay import gpt_live
from pipecat_aplisay.agent_tools import build_agent_tools
from pipecat_aplisay.gpt_live import (
    DelegateSpec,
    GptLiveSession,
    backend_settings,
    compose_backend_instructions,
    compose_voice_instructions,
    deep_merge,
    delegation_mode,
    find_delegate_function,
    greeting_opening_instruction,
    history_from_messages,
    is_gpt_live_model_id,
    live_overrides,
    merge_tools,
    resolve_delegate,
    resolve_delegate_target,
    synthetic_backend,
)
from pipecat_aplisay.realtime_tts import text_output_enabled, text_output_supported
from pipecat_aplisay.usage import UsageMeteringObserver, usage_vendors

live_service = pytest.importorskip("pipecat_aplisay.gpt_live_service")

GPT_LIVE = "pipecat:openai/gpt-live-1"
DELEGATE_ID = "22222222-2222-4222-8222-222222222222"


def _delegate_fn(target: str = DELEGATE_ID, source: str = "static") -> dict:
    return {
        "name": "brain",
        "implementation": "builtin",
        "platform": "delegate",
        "input_schema": {"properties": {"agent": {"type": "string", "source": source, "from": target}}},
    }


def _voice_agent(**extra) -> dict:
    agent = {
        "id": "voice-1",
        "name": "Sam",
        "modelName": GPT_LIVE,
        "prompt": "You are Sam, the receptionist.",
        "organisationId": "org-1",
        "functions": [_delegate_fn(), {"name": "hangup", "implementation": "builtin", "platform": "hangup", "input_schema": {"properties": {}}}],
        "options": {},
    }
    agent.update(extra)
    return agent


def _text_agent(model_name: str = "text:openai/gpt-5.6-terra", **extra) -> dict:
    agent = {
        "id": DELEGATE_ID,
        "name": "Brain",
        "type": "text",
        "modelName": model_name,
        "prompt": "You book appointments.",
        "organisationId": "org-1",
        "functions": [{"name": "get_slots", "implementation": "rest", "url": "https://x/slots", "input_schema": {"properties": {"date": {"type": "string"}}}}],
        "options": {"effort": "low", "maxTokens": 800},
        "keys": [],
    }
    agent.update(extra)
    return agent


def _descriptor(name: str) -> dict:
    async def execute(args):
        return {"tool": name, "args": args}

    return {"schema": {"name": name, "description": name, "properties": {}, "required": []}, "execute": execute}


# --- model id and rules -------------------------------------------------------


def test_gpt_live_model_ids():
    assert is_gpt_live_model_id("openai/gpt-live-1") is True
    assert is_gpt_live_model_id("OpenAI/GPT-Live-2") is True
    assert is_gpt_live_model_id("openai/gpt-realtime") is False
    assert is_gpt_live_model_id(None) is False


def test_gpt_live_has_no_text_output_mode():
    assert text_output_supported("openai/gpt-realtime") is True
    assert text_output_supported("openai/gpt-live-1") is False
    ext = {"options": {"tts": {"vendor": "elevenlabs", "voice": "Rachel"}}}
    assert text_output_enabled(ext, "openai/gpt-realtime") is True
    assert text_output_enabled(ext, "openai/gpt-live-1") is False


def test_delegation_mode_follows_the_delegate_model():
    assert delegation_mode("text:openai/gpt-5.6-terra") == "responses"
    assert delegation_mode("openai/gpt-5.6-luna") == "responses"
    assert delegation_mode("text:anthropic/claude-sonnet-5") == "client"
    assert delegation_mode("text:gemini/gemini-2.5-pro") == "client"


# --- delegate resolution ------------------------------------------------------


def test_find_and_resolve_the_delegate_target():
    agent = _voice_agent()
    fn = find_delegate_function(agent)
    assert fn is not None and fn["name"] == "brain"
    assert resolve_delegate_target(fn, {}) == DELEGATE_ID
    via_metadata = _delegate_fn("aplisay.backend", source="metadata")
    assert resolve_delegate_target(via_metadata, {"aplisay": {"backend": DELEGATE_ID}}) == DELEGATE_ID
    assert resolve_delegate_target(via_metadata, {"aplisay": {}}) is None
    assert resolve_delegate_target(_delegate_fn(source="generated"), {}) is None
    assert find_delegate_function({"functions": {"x": {"name": "x", "implementation": "rest"}}}) is None
    # object-shaped functions are accepted too
    assert find_delegate_function({"functions": {"brain": _delegate_fn()}}) is not None


def test_declared_delegate_is_fetched_with_the_organisation():
    seen = []

    async def fetch(agent_id, organisation_id):
        seen.append((agent_id, organisation_id))
        return _text_agent()

    spec = asyncio.run(resolve_delegate(_voice_agent(), {}, "org-1", fetch_agent=fetch))
    assert seen == [(DELEGATE_ID, "org-1")]
    assert spec.synthetic is False
    assert spec.mode == "responses"
    assert spec.model_name == "text:openai/gpt-5.6-terra"
    assert spec.backend_model == "gpt-5.6-terra"
    assert spec.backend_model_id == "openai/gpt-5.6-terra"
    assert spec.usage_backend == {"vendor": "openai", "model": "openai/gpt-5.6-terra"}


def test_no_delegate_means_the_synthetic_backend():
    async def fetch(*_):  # pragma: no cover - never called
        raise AssertionError("must not fetch")

    agent = _voice_agent(functions=[{"name": "hangup", "implementation": "builtin", "platform": "hangup", "input_schema": {"properties": {}}}])
    spec = asyncio.run(resolve_delegate(agent, {}, "org-1", fetch_agent=fetch))
    assert spec.synthetic is True
    assert spec.mode == "responses"
    assert spec.model_name == gpt_live.SYNTHETIC_BACKEND_MODEL_NAME
    assert spec.backend_model == "gpt-5.6-luna"
    assert spec.agent["prompt"] == agent["prompt"]
    assert spec.agent["type"] == "text"
    assert spec.agent["functions"] == []


@pytest.mark.parametrize(
    "fetch_result",
    [
        {"id": DELEGATE_ID, "type": "interactive-audio", "modelName": "pipecat:openai/gpt-realtime"},
        RuntimeError("404"),
    ],
)
def test_a_bad_delegate_falls_back_to_the_synthetic_backend(fetch_result):
    async def fetch(*_):
        if isinstance(fetch_result, Exception):
            raise fetch_result
        return fetch_result

    spec = asyncio.run(resolve_delegate(_voice_agent(), {}, "org-1", fetch_agent=fetch))
    assert spec.synthetic is True


def test_an_unresolved_metadata_target_falls_back_to_the_synthetic_backend():
    async def fetch(*_):  # pragma: no cover
        raise AssertionError("must not fetch")

    agent = _voice_agent(functions=[_delegate_fn("aplisay.backend", source="metadata")])
    spec = asyncio.run(resolve_delegate(agent, {"aplisay": {}}, "org-1", fetch_agent=fetch))
    assert spec.synthetic is True


def test_client_mode_for_a_non_openai_delegate():
    async def fetch(*_):
        return _text_agent("text:anthropic/claude-sonnet-5")

    spec = asyncio.run(resolve_delegate(_voice_agent(), {}, "org-1", fetch_agent=fetch))
    assert spec.mode == "client"
    assert spec.usage_backend == {"vendor": "anthropic", "model": "anthropic/claude-sonnet-5"}


# --- prompts, tools, settings -------------------------------------------------


def test_prompt_composition_appends_the_platform_blocks():
    voice = compose_voice_instructions("You are Sam.", language="Speak en-GB unless the caller asks you to switch language.")
    assert voice.startswith("You are Sam.")
    assert "Speak en-GB" in voice
    assert gpt_live.VOICE_DELEGATION_POLICY in voice
    backend = compose_backend_instructions("You book appointments.", tool_names=["hangup", "get_slots"])
    assert backend.startswith("You book appointments.")
    assert gpt_live.BACKEND_TOOL_POLICY in backend
    assert "Tools available to you: get_slots, hangup." in backend
    assert compose_voice_instructions("").startswith("You are a helpful voice assistant.")


def test_merge_tools_prefers_the_delegate_on_a_clash():
    voice = [_descriptor("get_slots"), _descriptor("hangup")]
    delegate = [_descriptor("get_slots"), _descriptor("book_slot")]
    merged = merge_tools(voice, delegate)
    names = [t["schema"]["name"] for t in merged]
    assert names == ["get_slots", "book_slot", "hangup"]
    assert merged[0] is delegate[0]
    assert merge_tools([], []) == []


def test_the_delegate_declaration_is_never_a_tool():
    async def noop(*_a, **_k):
        return None

    tools = build_agent_tools(
        agent=_voice_agent(),
        metadata={},
        send_message=noop,
        on_hangup=noop,  # type: ignore[arg-type]
        on_transfer=noop,  # type: ignore[arg-type]
        get_transfer_state=lambda: {"state": "none", "description": ""},
    )
    assert [t["schema"]["name"] for t in tools] == ["hangup"]


def test_backend_settings_and_live_overrides():
    assert backend_settings(_text_agent()) == {"effort": "low", "max_tokens": 800}
    assert backend_settings({"options": {"temperature": 0.2, "maxTokens": True}}) == {}
    agent = _voice_agent(options={"vendorSpecific": {"openai": {"live": {"delegation": {"responses": {"service_tier": "priority"}}}}}})
    assert live_overrides(agent) == {"delegation": {"responses": {"service_tier": "priority"}}}
    assert live_overrides({"options": {"vendorSpecific": {"ultravox": {}}}}) == {}
    assert deep_merge({"a": {"b": 1, "c": 2}, "d": 3}, {"a": {"b": 9}, "e": 4}) == {"a": {"b": 9, "c": 2}, "d": 3, "e": 4}


def test_history_keeps_only_text_turns_and_the_most_recent():
    messages = [
        {"role": "developer", "content": "prompt"},
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": [{"type": "text", "text": "hello "}, {"type": "text", "text": "there"}]},
        {"role": "assistant", "content": "", "tool_calls": []},
        {"role": "tool", "content": "x"},
    ]
    assert history_from_messages(messages) == [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello there"}]
    many = [{"role": "user", "content": str(i)} for i in range(200)]
    kept = history_from_messages(many)
    assert len(kept) == gpt_live.MAX_HISTORY_MESSAGES and kept[-1]["content"] == "199"


def test_greeting_opening_instruction():
    assert greeting_opening_instruction({"options": {}}) == gpt_live.OPENING_INSTRUCTION
    text = greeting_opening_instruction({"options": {"greeting": {"text": "Acme Dental, Sam speaking."}}})
    assert text.endswith("Acme Dental, Sam speaking.") and "exactly and in full" in text
    instr = greeting_opening_instruction({"options": {"greeting": {"instructions": "Greet warmly."}}})
    assert "Greet warmly." in instr and "opening line only" in instr


# --- the service ----------------------------------------------------------------


def _session(spec: DelegateSpec | None = None, **kwargs) -> GptLiveSession:
    spec = spec or DelegateSpec(agent=_text_agent(), synthetic=False, mode="responses")
    defaults = dict(
        delegate=spec,
        voice_instructions="VOICE",
        backend_instructions="BACKEND",
        tools=[],
        settings={"effort": "low", "max_tokens": 800},
        overrides={},
    )
    defaults.update(kwargs)
    return GptLiveSession(**defaults)


def _build(session: GptLiveSession, voice: str | None = None):
    llm = live_service.build_gpt_live_service(api_key="sk-test", voice=voice, session=session)
    sent: list[dict] = []

    async def capture(payload):
        sent.append(payload)

    llm._ws_send = capture  # type: ignore[method-assign]
    return llm, sent


def test_responses_delegation_config_and_voice():
    llm, _ = _build(_session(), voice="cedar")
    assert llm.responses_mode is True
    assert llm.aplisay_backend == {"vendor": "openai", "model": "openai/gpt-5.6-terra"}
    from pipecat.services.openai.live.llm import _responses_delegation_config

    config = _responses_delegation_config(llm._delegation)
    assert config["model"] == "gpt-5.6-terra"
    assert config["instructions"] == "BACKEND"
    assert config["reasoning"] == {"effort": "low"}
    assert config["max_output_tokens"] == 800
    assert llm._settings.voice == "cedar"
    assert llm._settings.system_instruction == "VOICE"
    # default voice when the agent sets none
    llm2, _ = _build(_session())
    assert llm2._settings.voice == gpt_live.GPT_LIVE_DEFAULT_VOICE


def test_session_start_carries_the_context_and_the_vendor_overrides():
    from pipecat.adapters.schemas.tools_schema import ToolsSchema
    from pipecat.processors.aggregators.llm_context import LLMContext

    session = _session(overrides={"delegation": {"responses": {"service_tier": "priority"}}, "store": False})
    llm, sent = _build(session)
    llm._context = LLMContext(
        [{"role": "user", "content": "earlier"}, {"role": "developer", "content": "Greet the caller."}],
        tools=ToolsSchema(standard_tools=[]),
    )
    asyncio.run(llm._send_session_config())
    [payload] = sent
    assert payload["type"] == "session.start"
    s = payload["session"]
    assert s["model"] == "gpt-live-1"
    assert s["instructions"] == "VOICE"
    assert s["audio"]["output"]["voice"] == "marin"
    assert s["delegation"]["type"] == "responses"
    assert s["delegation"]["responses"]["model"] == "gpt-5.6-terra"
    # the override lands beside the platform mapping, and an explicit value wins
    assert s["delegation"]["responses"]["service_tier"] == "priority"
    assert s["store"] is False
    # the trailing developer message became the opening instruction, not history
    assert s["input"] == [{"type": "message", "role": "user", "content": [{"type": "input_text", "text": "earlier"}]}]
    assert llm._opening_instruction == "Greet the caller."


def test_injection_shim_events_in_responses_mode():
    llm, sent = _build(_session())
    llm._session_started = True
    asyncio.run(llm.inject_dtmf("1234"))
    types = [p["type"] for p in sent]
    assert types == ["response.item.create", "response.create", "session.thinking.append"]
    item = sent[0]["item"]
    assert item == {"type": "message", "role": "user", "content": [{"type": "input_text", "text": gpt_live.dtmf_typed_input("1234")}]}
    assert sent[2]["delegation_id"] is None and "1234" in sent[2]["content"]
    sent.clear()
    asyncio.run(llm.inject_inactivity_prompt("Are you still there?"))
    assert [p["type"] for p in sent] == ["session.commentary.append"]
    assert "Are you still there?" in sent[0]["content"]
    # nothing is sent before the session has started
    llm._session_started = False
    sent.clear()
    asyncio.run(llm.inject_dtmf("5"))
    asyncio.run(llm.inject_inactivity_prompt("x"))
    assert sent == []


def test_long_appends_are_chunked():
    llm, sent = _build(_session())
    llm._session_started = True
    asyncio.run(llm.append_commentary("word " * 1500))
    assert len(sent) > 1
    assert all(p["type"] == "session.commentary.append" for p in sent)


def test_client_delegation_round_trip():
    calls: list = []

    async def delegate(messages, first):
        calls.append((messages, first))
        return "Two slots are free tomorrow: 9:30 and 11:00."

    spec = DelegateSpec(agent=_text_agent("text:anthropic/claude-sonnet-5"), synthetic=False, mode="client")
    llm, sent = _build(_session(spec, client_delegate=delegate))
    assert llm.responses_mode is False
    llm._session_started = True
    # typed input before any delegation is queued for the next one
    asyncio.run(llm.typed_input("The caller pressed 1"))
    assert sent == []
    llm._remember_fragment("user", "I would like")
    llm._remember_fragment("user", " an appointment")
    llm._remember_fragment("assistant", "Let me check.")
    from pipecat.services.openai.live.events import DelegationMetadata

    asyncio.run(llm._run_platform_delegation(DelegationMetadata(id="dlg_1", target="client")))
    [(messages, first)] = calls
    assert first is True
    assert messages == [
        {"role": "user", "content": "The caller pressed 1"},
        {"role": "user", "content": "I would like an appointment"},
        {"role": "assistant", "content": "Let me check."},
    ]
    assert [p["type"] for p in sent] == ["session.commentary.append"]
    assert sent[0]["delegation_id"] == "dlg_1"
    assert sent[0]["content"] == "Two slots are free tomorrow: 9:30 and 11:00."
    # the ledger is consumed
    assert llm._take_transcript() == []


def test_client_delegation_failure_is_spoken_as_an_apology():
    async def delegate(messages, first):
        raise RuntimeError("API request failed: 403")

    spec = DelegateSpec(agent=_text_agent("text:anthropic/claude-sonnet-5"), synthetic=False, mode="client")
    llm, sent = _build(_session(spec, client_delegate=delegate))
    llm._session_started = True
    from pipecat.services.openai.live.events import DelegationMetadata

    asyncio.run(llm._run_platform_delegation(DelegationMetadata(id="dlg_2", target="client")))
    assert [p["type"] for p in sent] == ["session.commentary.append"]
    assert sent[0]["delegation_id"] == "dlg_2"
    assert sent[0]["content"] == live_service.DELEGATION_FAILED_COMMENTARY


def test_provider_close_reasons_end_the_call():
    ended: list[str] = []

    async def on_ended(reason):
        ended.append(reason)

    from pipecat.services.openai.live.events import SessionClosedEvent

    llm, _ = _build(_session(on_session_ended=on_ended))
    for reason in ("expired", "content", "connection_lost"):
        asyncio.run(llm._handle_evt_session_closed(SessionClosedEvent(type="session.closed", reason=reason)))
    assert ended == ["expired", "content", "connection_lost"]
    ended.clear()
    asyncio.run(llm._handle_evt_session_closed(SessionClosedEvent(type="session.closed", reason="close_requested")))
    asyncio.run(llm._handle_evt_session_closed(SessionClosedEvent(type="session.closed", reason="remote_hangup")))
    assert ended == []


def test_dtmf_aggregator_hands_the_digits_to_the_shim():
    got: list[str] = []

    async def on_digits(digits):
        got.append(digits)

    aggregator = live_service.GptLiveDtmfAggregator(timeout=1.5, on_digits=on_digits)
    aggregator._aggregation = "42#"
    asyncio.run(aggregator._flush_aggregation())
    assert got == ["42#"]
    assert aggregator._aggregation == ""
    asyncio.run(aggregator._flush_aggregation())
    assert got == ["42#"]


# --- wiring ---------------------------------------------------------------------


def test_output_audit_tap_keys_on_output_audio_for_gpt_live():
    from pipecat_aplisay import voice_session

    async def on_transcript(_text):
        return None

    agent = {"options": {"tts": {"output": True}}}
    tap = voice_session._output_stt_tap_for(agent, on_transcript, None)
    assert tap._frame_cls is TTSAudioRawFrame
    tap = voice_session._output_stt_tap_for(agent, on_transcript, None, frame_cls=OutputAudioRawFrame)
    assert tap._frame_cls is OutputAudioRawFrame


def test_inactivity_kick_uses_the_injector_when_given():
    from pipecat_aplisay.voice_session import _wire_inactivity_kick

    class _Aggregator:
        def __init__(self):
            self.handlers = {}

        def event_handler(self, name):
            def register(fn):
                self.handlers[name] = fn
                return fn

            return register

    injected: list[str] = []

    async def inject(message):
        injected.append(message)

    class _Task:
        async def queue_frames(self, frames):  # pragma: no cover - must not be used
            raise AssertionError("frames must not be queued when an injector is given")

    aggregator = _Aggregator()
    _wire_inactivity_kick(
        user_aggregator=aggregator,
        task_ref_getter=lambda: _Task(),
        agent={"options": {"inactivity": {"timeout": 8, "message": "Still there?"}}},
        mode="realtime",
        is_ultravox=False,
        inject=inject,
    )
    asyncio.run(aggregator.handlers["on_user_turn_idle"](aggregator))
    assert injected == ["Still there?"]


def test_gpt_live_always_restarts_on_handover():
    from pipecat_aplisay import api_client
    from pipecat_aplisay.call_session import CallSession

    call = api_client.CallRecord(id="c", userId="u", organisationId="o", instanceId="i", agentId="a", persisted=False)
    session = CallSession(session_id="s", agent=_voice_agent(), instance={}, call=call, sip_gateway=None, gateway_session=None)  # type: ignore[arg-type]
    assert session._needs_full_handover({"modelName": GPT_LIVE}) is True
    session.agent = {"modelName": "pipecat:openai/gpt-realtime"}
    session._active_model_name = "pipecat:openai/gpt-realtime"
    assert session._needs_full_handover({"modelName": "pipecat:openai/gpt-realtime"}) is False


def test_usage_relabels_backend_tokens_to_the_delegate_model():
    services = usage_vendors(_voice_agent(), GPT_LIVE, backend={"vendor": "openai", "model": "openai/gpt-5.6-terra"})
    assert services["llm"] == {"vendor": "openai", "model": "openai/gpt-5.6-terra", "authoritative": True}
    observer = UsageMeteringObserver(services=services)
    # the service labels its token metrics with the live model
    assert observer._resolve("llm", "gpt-live-1") == ("openai", "openai/gpt-5.6-terra")
    plain = usage_vendors(_voice_agent(), GPT_LIVE)
    assert plain["llm"] == {"vendor": "openai", "model": "gpt-live-1"}
    assert UsageMeteringObserver(services=plain)._resolve("llm", "gpt-4o") == ("openai", "gpt-4o")


def test_compose_gpt_live_merges_delegate_tools_and_settings(monkeypatch):
    from pipecat_aplisay import api_client, call_session
    from pipecat_aplisay.call_session import CallSession

    async def fetch(agent_id, expected_organisation_id=None):
        assert (agent_id, expected_organisation_id) == (DELEGATE_ID, "org-1")
        return _text_agent(mcpServers=[])

    monkeypatch.setattr(api_client, "get_internal_agent_by_id", fetch)

    async def no_mcp(agent, *, log=None):
        return [], []

    monkeypatch.setattr(call_session, "connect_mcp_servers", no_mcp)

    call = api_client.CallRecord(id="c", userId="u", organisationId="org-1", instanceId="i", agentId="a", persisted=False)
    agent = _voice_agent(options={"tts": {"language": "en-GB"}, "vendorSpecific": {"openai": {"live": {"store": False}}}})
    session = CallSession(session_id="s", agent=agent, instance={}, call=call, sip_gateway=None, gateway_session=None)  # type: ignore[arg-type]
    voice_tools = session._build_tools_for(agent)
    composed, merged = asyncio.run(session._compose_gpt_live(agent, "You are Sam.", voice_tools, {}))
    assert composed.delegate.synthetic is False
    assert composed.delegate.mode == "responses"
    assert [t["schema"]["name"] for t in merged] == ["get_slots", "hangup"]
    assert composed.tools is merged
    assert composed.settings == {"effort": "low", "max_tokens": 800}
    assert composed.overrides == {"store": False}
    assert composed.voice_instructions.startswith("You are Sam.")
    assert "Speak en-GB" in composed.voice_instructions
    assert composed.backend_instructions.startswith("You book appointments.")
    assert "Tools available to you: get_slots, hangup." in composed.backend_instructions
    assert composed.client_delegate is None
    assert composed.on_dtmf is not None and composed.on_session_ended is not None


def test_client_delegate_calls_the_subagent_endpoint(monkeypatch):
    from pipecat_aplisay import api_client
    from pipecat_aplisay.call_session import CallSession

    seen: list = []

    async def invoke(agent_id, input_args, metadata, *, organisation_id, call_id):
        seen.append((agent_id, input_args, organisation_id, call_id))
        return {"text": "Nine thirty is free."}

    monkeypatch.setattr(api_client, "invoke_subagent", invoke)
    call = api_client.CallRecord(id="call-9", userId="u", organisationId="org-1", instanceId="i", agentId="a", persisted=False)
    session = CallSession(session_id="s", agent=_voice_agent(), instance={}, call=call, sip_gateway=None, gateway_session=None)  # type: ignore[arg-type]
    spec = DelegateSpec(agent=_text_agent("text:anthropic/claude-sonnet-5"), synthetic=False, mode="client")
    delegate = session._gpt_live_client_delegate(spec)
    text = asyncio.run(delegate([{"role": "user", "content": "Any slots tomorrow?"}], True))
    assert text == "Nine thirty is free."
    [(agent_id, input_args, organisation_id, call_id)] = seen
    assert (agent_id, organisation_id, call_id) == (DELEGATE_ID, "org-1", "call-9")
    assert "USER: Any slots tomorrow?" in input_args["task"]
    assert input_args["task"].startswith("Voice conversation so far:")
