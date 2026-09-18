"""The opening turn of a generation that continues a call already in progress.

An agent's greeting is written for a new call. When a generation continues a
call, the caller has already been greeted, so it opens with a platform
instruction instead (``CallSession._platform_opening``):

* ``transfer_prompts.HANDOVER_OPENING_INSTRUCTION`` on the first generation
  after a ``transfer_agent`` full-stack handover, and after an in-place swap.
* ``transfer_prompts.TAKEOVER_OPENING_INSTRUCTION`` on a human-to-agent
  takeover leg (``setup_takeover_call``): a person handed the caller back
  after a bridged transfer (``options.bridgedTransferToAgent``).

Both reach the model the same way:

* Ultravox takes the opening at call creation as
  ``firstSpeakerSettings.agent.prompt``. Before this, such a leg sent
  ``firstSpeakerSettings: {"agent": {}}`` (or the agent's greeting), and
  Ultravox opened the turn with its own "(New Call) Respond as if you are
  answering the phone." message, so the agent greeted the caller as if the
  call were new.
* GPT-Live, OpenAI Realtime and pipeline models get it from
  ``CallSession._wire_greeting`` as a developer message before the first run.

No greeting plays on these generations, so nothing silences the caller for
one: the greeting mute strategy and GPT-Live's greeting guard are off, and the
caller can interrupt the opening.

New calls keep their greeting, and its mute, exactly as before.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame, TTSSpeakFrame

from pipecat_aplisay import gpt_live, voice_session
from pipecat_aplisay.call_session import CallSession
from pipecat_aplisay.transfer_prompts import (
    HANDOVER_OPENING_INSTRUCTION,
    TAKEOVER_OPENING_INSTRUCTION,
)
from pipecat_aplisay.voice_session import _ultravox_one_shot_params

pytest.importorskip("pipecat.services.ultravox.llm")

# The two kinds of generation that continue a call: the platform opening each
# gets, and the CallSession flag that marks it.
KINDS = ["handover", "takeover"]
OPENING = {"handover": HANDOVER_OPENING_INSTRUCTION, "takeover": TAKEOVER_OPENING_INSTRUCTION}
FLAG = {"handover": "_is_handover_generation", "takeover": "_is_takeover"}

GREETINGS = [None, {"text": "Thanks for calling Acme."}, {"instructions": "Greet the caller warmly."}]
GPT_LIVE = "pipecat:openai/gpt-live-1"


def _agent(**options) -> dict:
    return {"options": {k: v for k, v in options.items() if v is not None}}


# --- Ultravox: firstSpeakerSettings on the /calls request ------------------------


@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("greeting", GREETINGS)
def test_ultravox_handover_or_takeover_leg_opens_with_the_platform_prompt(monkeypatch, greeting, kind):
    monkeypatch.setenv("ULTRAVOX_API_KEY", "test-key")
    params = _ultravox_one_shot_params(
        _agent(greeting=greeting), "sys", "ultravox-v0.7", text_output=False, opening=OPENING[kind]
    )
    # The agent's greeting is for a new call, so it is never used here, and the
    # opening is interruptible.
    assert params.extra["firstSpeakerSettings"] == {"agent": {"prompt": OPENING[kind]}}
    # The system prompt, which carries the handover or takeover context, is unchanged.
    assert params.system_prompt == "sys"


@pytest.mark.parametrize("kind", KINDS)
def test_ultravox_handover_or_takeover_leg_in_text_output_mode(monkeypatch, kind):
    monkeypatch.setenv("ULTRAVOX_API_KEY", "test-key")
    agent = _agent(tts={"vendor": "elevenlabs", "voice": "Rachel"}, greeting={"text": "Hello there"})
    params = _ultravox_one_shot_params(agent, "sys", "ultravox-v0.7", text_output=True, opening=OPENING[kind])
    assert params.extra["firstSpeakerSettings"] == {"agent": {"prompt": OPENING[kind]}}
    assert params.output_medium == "text"


@pytest.mark.parametrize(
    "greeting, expected",
    [
        (None, {"agent": {}}),
        (GREETINGS[1], {"agent": {"text": "Thanks for calling Acme.", "uninterruptible": True}}),
        (GREETINGS[2], {"agent": {"prompt": "Greet the caller warmly.", "uninterruptible": True}}),
    ],
)
def test_ultravox_first_leg_keeps_its_greeting(monkeypatch, greeting, expected):
    monkeypatch.setenv("ULTRAVOX_API_KEY", "test-key")
    params = _ultravox_one_shot_params(_agent(greeting=greeting), "sys", "ultravox-v0.7", text_output=False)
    assert params.extra["firstSpeakerSettings"] == expected


class _Stop(Exception):
    """Ends a session build at the point under test."""


@pytest.mark.parametrize("opening", [None, *OPENING.values()], ids=["new-call", *KINDS])
def test_build_voice_session_passes_the_opening_to_ultravox(monkeypatch, opening):
    seen = {}

    def fake_params(agent, system_prompt, ultravox_model, *, text_output, opening=None):
        seen["opening"] = opening
        raise _Stop

    monkeypatch.setattr(voice_session, "_ultravox_one_shot_params", fake_params)
    with pytest.raises(_Stop):
        asyncio.run(
            voice_session.build_voice_session(
                transport=None,
                model_name="pipecat:ultravox/ultravox-v0.7",
                agent=_agent(),
                metadata={},
                tools=[],
                system_prompt="sys",
                opening=opening,
            )
        )
    assert seen == {"opening": opening}


# --- the other models: CallSession._wire_greeting --------------------------------


class _Transport:
    """Records the event handlers that _wire_greeting registers."""

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


def _opening_frames(agent: dict, mode: str, model_name: str, *, kind: str | None = None):
    """Wire the greeting for one generation, connect the client, and return the
    frames queued for the opening turn (None when nothing was wired). ``kind``
    makes the generation a handover or a takeover."""
    session = _session(model_name)
    if kind:
        setattr(session, FLAG[kind], True)
    transport, task = _Transport(), _Task()

    async def run():
        await session._wire_greeting(transport, task, agent, mode, model_name)
        handler = transport.handlers.get("on_client_connected")
        if handler is None:
            return None
        await handler(transport, object())
        return task.frames

    return asyncio.run(run())


def _developer_text(frames) -> list[str]:
    return [
        m["content"]
        for f in frames
        if isinstance(f, LLMMessagesAppendFrame)
        for m in f.messages
        if m.get("role") == "developer"
    ]


@pytest.mark.parametrize(
    "mode, model_name",
    [
        ("pipeline", "pipecat:openai/gpt-4o-mini"),
        ("realtime", "pipecat:openai/gpt-realtime"),
        ("realtime", GPT_LIVE),
    ],
)
@pytest.mark.parametrize("greeting", GREETINGS)
@pytest.mark.parametrize("kind", KINDS)
def test_handover_or_takeover_generation_opens_with_the_platform_instruction(mode, model_name, greeting, kind):
    frames = _opening_frames(_agent(greeting=greeting), mode, model_name, kind=kind)
    assert _developer_text(frames) == [OPENING[kind]]
    assert isinstance(frames[-1], LLMRunFrame)
    # The greeting text is never spoken on a handover or a takeover.
    assert not any(isinstance(f, TTSSpeakFrame) for f in frames)


def test_first_generation_keeps_the_pipeline_greeting_text():
    frames = _opening_frames(_agent(greeting=GREETINGS[1]), "pipeline", "pipecat:openai/gpt-4o-mini")
    assert [type(f) for f in frames] == [TTSSpeakFrame]
    assert frames[0].text == "Thanks for calling Acme."


def test_first_generation_without_a_greeting_just_runs_the_llm():
    frames = _opening_frames(_agent(), "realtime", "pipecat:openai/gpt-realtime")
    assert [type(f) for f in frames] == [LLMRunFrame]


def test_first_generation_on_gpt_live_keeps_the_platform_opening():
    frames = _opening_frames(_agent(), "realtime", GPT_LIVE)
    assert _developer_text(frames) == [gpt_live.OPENING_INSTRUCTION]


@pytest.mark.parametrize("kind", [None, *KINDS])
def test_ultravox_wires_no_frames(kind):
    # Ultravox takes its first turn natively at call creation (tests above).
    frames = _opening_frames(_agent(), "realtime", "pipecat:ultravox/ultravox-v0.7", kind=kind)
    assert frames is None


# --- CallSession: which generation gets which opening ----------------------------


def _call_record(call_id: str, agent_id: str):
    from pipecat_aplisay import api_client

    return api_client.CallRecord(
        id=call_id,
        userId="user-1",
        organisationId="org-1",
        instanceId="inst-1",
        agentId=agent_id,
        persisted=False,
    )


class _StubGatewaySession:
    transport = None

    async def shutdown(self) -> None:  # pragma: no cover
        return None


def _session(model_name: str = "pipecat:openai/gpt-4o-mini") -> CallSession:
    return CallSession(
        session_id="s1",
        agent={"id": "agent-1", "modelName": model_name, "prompt": "old", "options": {}},
        instance={"streamLog": False},
        sip_gateway=None,  # type: ignore[arg-type]
        gateway_session=_StubGatewaySession(),  # type: ignore[arg-type]
        call=_call_record("call-1", "agent-1"),
    )


def _takeover_session(model_name: str = "pipecat:openai/gpt-4o-mini") -> CallSession:
    """A takeover leg, built by setup_takeover_call the way the worker builds one."""
    from pipecat_aplisay.bridged_transfer import TakeoverPayload
    from pipecat_aplisay.call_session import setup_takeover_call
    from pipecat_aplisay.sip_gateway.base import InboundCallContext

    class _Gateway:
        async def setup_inbound(self, inbound, params):
            return _StubGatewaySession()

    payload = TakeoverPayload(
        agent={"id": "agent-2", "modelName": model_name, "prompt": "You book follow-up visits.", "options": {}},
        instance={"streamLog": False},
        call=_call_record("call-2", "agent-2"),
    )
    inbound = InboundCallContext(session_id="sb-bta-1", called_id="+441234567891", caller_id="+441234567890")
    return asyncio.run(setup_takeover_call(_Gateway(), inbound, payload=payload))


def _record_builds(monkeypatch) -> list:
    """Stub build_voice_session: record each build's ``opening`` and stop there."""
    from pipecat_aplisay import call_session as cs

    seen: list = []

    async def fake_build(**kwargs):
        seen.append(kwargs.get("opening"))
        raise _Stop

    monkeypatch.setattr(cs, "build_voice_session", fake_build)
    return seen


def _hand_over(session: CallSession) -> None:
    """Run ``session`` until its pipeline ends with a full handover pending, as
    _begin_agent_handover leaves it, and run_prepared builds the incoming
    agent's generation (the stubbed build stops there)."""
    runs: list = []

    async def fake_run_once(task, max_duration_secs):
        runs.append(task)
        if len(runs) == 1:
            session._pending_agent_handover = {
                "agent": {"id": "agent-3", "modelName": "pipecat:openai/gpt-4o-mini", "prompt": "new", "options": {}},
                "system_prompt": "You are agent three.",
                "call": _call_record("call-3", "agent-3"),
                "transport": object(),
                "history": None,
            }

    session._run_prepared_once = fake_run_once
    with pytest.raises(_Stop):
        asyncio.run(session.run_prepared(object(), None))


def test_a_new_call_has_no_platform_opening(monkeypatch):
    seen = _record_builds(monkeypatch)
    session = _session()
    with pytest.raises(_Stop):
        asyncio.run(session.prepare_run(session.agent, session.agent["modelName"], "sys"))
    assert seen == [None]


def test_run_prepared_builds_the_handover_generation_with_the_handover_opening(monkeypatch):
    seen = _record_builds(monkeypatch)
    session = _session()
    _hand_over(session)
    assert seen == [HANDOVER_OPENING_INSTRUCTION]
    assert session._is_handover_generation is True


def test_setup_takeover_call_builds_a_takeover_leg(monkeypatch):
    seen = _record_builds(monkeypatch)
    session = _takeover_session()
    assert session._is_takeover is True
    with pytest.raises(_Stop):
        asyncio.run(session.prepare_run(session.agent, session.agent["modelName"], session.agent["prompt"]))
    assert seen == [TAKEOVER_OPENING_INSTRUCTION]


def test_a_handover_from_a_takeover_leg_opens_as_a_handover(monkeypatch):
    seen = _record_builds(monkeypatch)
    session = _takeover_session()
    _hand_over(session)
    assert seen == [HANDOVER_OPENING_INSTRUCTION]


def test_the_takeover_opening_is_worded_for_a_hand_back_from_a_person():
    # The handover wording says the call came from another agent. After a
    # hand-back the caller was last talking to a person.
    assert "another agent" in HANDOVER_OPENING_INSTRUCTION
    assert "another agent" not in TAKEOVER_OPENING_INSTRUCTION
    assert "person" in TAKEOVER_OPENING_INSTRUCTION


def test_in_place_handover_adds_the_opening_after_the_new_prompt():
    from pipecat.frames.frames import LLMMessagesUpdateFrame

    session = _session()
    task = _Task()
    session._task = task
    session._llm_service = SimpleNamespace(
        register_function=lambda *a, **k: None, unregister_function=lambda *a, **k: None
    )
    session._registered_tool_names = set()
    session._build_tools_for = lambda agent, extra_builtins=None: []

    new_agent = {"id": "agent-2", "modelName": "pipecat:openai/gpt-4o-mini", "prompt": "two"}
    asyncio.run(session._apply_agent_transfer(new_agent, "You are agent two."))

    [update] = [f for f in task.frames if isinstance(f, LLMMessagesUpdateFrame)]
    assert update.messages == [
        {"role": "developer", "content": "You are agent two."},
        {"role": "developer", "content": HANDOVER_OPENING_INSTRUCTION},
    ]
    assert isinstance(task.frames[-1], LLMRunFrame)


# --- the greeting mute: only while a greeting plays ------------------------------


def _mutes_caller(params) -> bool:
    return params is not None and bool(params.user_mute_strategies)


@pytest.mark.parametrize(
    "model_name",
    ["pipecat:openai/gpt-4o-mini", "pipecat:openai/gpt-realtime", "pipecat:ultravox/ultravox-v0.7"],
)
@pytest.mark.parametrize("opening", [None, *OPENING.values()], ids=["new-call", *KINDS])
def test_the_greeting_mute_applies_only_when_the_greeting_plays(monkeypatch, model_name, opening):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("ULTRAVOX_API_KEY", "test-key")
    # The pipeline's STT and TTS need vendor keys and play no part here.
    monkeypatch.setattr(voice_session, "build_stt_service", lambda agent: object())
    monkeypatch.setattr(voice_session, "build_tts_service", lambda agent: object())
    real = voice_session._user_aggregator_params_for
    built: list = []

    def spy(agent, **kwargs):
        built.append(real(agent, **kwargs))
        raise _Stop

    monkeypatch.setattr(voice_session, "_user_aggregator_params_for", spy)
    with pytest.raises(_Stop):
        asyncio.run(
            voice_session.build_voice_session(
                transport=None,
                model_name=model_name,
                agent=_agent(greeting=GREETINGS[1]),
                metadata={},
                tools=[],
                system_prompt="sys",
                opening=opening,
            )
        )
    # A new call's greeting mutes the caller until it ends. A handover or
    # takeover opening takes the greeting's place, and the caller can interrupt it.
    assert [_mutes_caller(p) for p in built] == [opening is None]


@pytest.mark.parametrize("kind", [None, *KINDS])
def test_gpt_live_silences_the_caller_only_while_a_greeting_plays(kind):
    # No delegate is declared, so the backend is synthesised and nothing is fetched.
    agent = {
        "id": "agent-1",
        "modelName": GPT_LIVE,
        "prompt": "You are Sam.",
        "functions": [],
        "options": {"greeting": {"text": "Thanks for calling Acme."}},
    }
    session = _session(GPT_LIVE)
    if kind:
        setattr(session, FLAG[kind], True)
    composed, _ = asyncio.run(session._compose_gpt_live(agent, "You are Sam.", [], {}))
    assert composed.deaf_during_greeting is (kind is None)
