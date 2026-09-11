"""The opening turn after a ``transfer_agent`` full-stack handover.

The incoming agent's greeting is written for a new call. After a handover the
caller has already been greeted, so the first generation opens with
``transfer_prompts.HANDOVER_OPENING_INSTRUCTION`` instead:

* Ultravox takes it at call creation as ``firstSpeakerSettings.agent.prompt``.
  Before this, a handover leg sent ``firstSpeakerSettings: {"agent": {}}`` (or
  the target's greeting), and Ultravox opened the turn with its own
  "(New Call) Respond as if you are answering the phone." message, so the new
  agent greeted the caller as if the call were new.
* GPT-Live, OpenAI Realtime and pipeline models get it from
  ``CallSession._wire_greeting`` as a developer message before the first run.

Calls that are not handovers keep their greeting exactly as before.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest
from pipecat.frames.frames import LLMMessagesAppendFrame, LLMRunFrame, TTSSpeakFrame

from pipecat_aplisay import gpt_live, voice_session
from pipecat_aplisay.call_session import CallSession
from pipecat_aplisay.transfer_prompts import HANDOVER_OPENING_INSTRUCTION
from pipecat_aplisay.voice_session import _ultravox_one_shot_params

pytest.importorskip("pipecat.services.ultravox.llm")

HANDOVER_FIRST_SPEAKER = {"agent": {"prompt": HANDOVER_OPENING_INSTRUCTION}}
GREETINGS = [None, {"text": "Thanks for calling Acme."}, {"instructions": "Greet the caller warmly."}]


def _agent(**options) -> dict:
    return {"options": {k: v for k, v in options.items() if v is not None}}


# --- Ultravox: firstSpeakerSettings on the /calls request ------------------------


@pytest.mark.parametrize("greeting", GREETINGS)
def test_ultravox_handover_leg_opens_with_the_handover_prompt(monkeypatch, greeting):
    monkeypatch.setenv("ULTRAVOX_API_KEY", "test-key")
    params = _ultravox_one_shot_params(
        _agent(greeting=greeting), "sys", "ultravox-v0.7", text_output=False, handover=True
    )
    # The target's greeting is for a new call, so a handover never uses it.
    assert params.extra["firstSpeakerSettings"] == HANDOVER_FIRST_SPEAKER
    # The system prompt, which carries the handover summary and transcript, is unchanged.
    assert params.system_prompt == "sys"


def test_ultravox_handover_leg_in_text_output_mode(monkeypatch):
    monkeypatch.setenv("ULTRAVOX_API_KEY", "test-key")
    agent = _agent(tts={"vendor": "elevenlabs", "voice": "Rachel"}, greeting={"text": "Hello there"})
    params = _ultravox_one_shot_params(agent, "sys", "ultravox-v0.7", text_output=True, handover=True)
    assert params.extra["firstSpeakerSettings"] == HANDOVER_FIRST_SPEAKER
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
    """Ends the session build once the Ultravox params have been requested."""


@pytest.mark.parametrize("flag", [True, False])
def test_build_voice_session_passes_the_handover_flag_to_ultravox(monkeypatch, flag):
    seen = {}

    def fake_params(agent, system_prompt, ultravox_model, *, text_output, handover=False):
        seen["handover"] = handover
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
                handover=flag,
            )
        )
    assert seen == {"handover": flag}


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


def _opening_frames(agent: dict, mode: str, model_name: str, *, handover: bool):
    """Wire the greeting for one generation, connect the client, and return the
    frames queued for the opening turn (None when nothing was wired)."""
    session = SimpleNamespace(_is_handover_generation=handover)
    transport, task = _Transport(), _Task()

    async def run():
        await CallSession._wire_greeting(session, transport, task, agent, mode, model_name)
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
        ("realtime", "pipecat:openai/gpt-live-1"),
    ],
)
@pytest.mark.parametrize("greeting", GREETINGS)
def test_handover_generation_opens_with_the_handover_instruction(mode, model_name, greeting):
    frames = _opening_frames(_agent(greeting=greeting), mode, model_name, handover=True)
    assert _developer_text(frames) == [HANDOVER_OPENING_INSTRUCTION]
    assert isinstance(frames[-1], LLMRunFrame)
    # The greeting text is never spoken on a handover.
    assert not any(isinstance(f, TTSSpeakFrame) for f in frames)


def test_first_generation_keeps_the_pipeline_greeting_text():
    frames = _opening_frames(
        _agent(greeting=GREETINGS[1]), "pipeline", "pipecat:openai/gpt-4o-mini", handover=False
    )
    assert [type(f) for f in frames] == [TTSSpeakFrame]
    assert frames[0].text == "Thanks for calling Acme."


def test_first_generation_without_a_greeting_just_runs_the_llm():
    frames = _opening_frames(_agent(), "realtime", "pipecat:openai/gpt-realtime", handover=False)
    assert [type(f) for f in frames] == [LLMRunFrame]


def test_first_generation_on_gpt_live_keeps_the_platform_opening():
    frames = _opening_frames(_agent(), "realtime", "pipecat:openai/gpt-live-1", handover=False)
    assert _developer_text(frames) == [gpt_live.OPENING_INSTRUCTION]


@pytest.mark.parametrize("handover", [True, False])
def test_ultravox_wires_no_frames(handover):
    # Ultravox takes its first turn natively at call creation (tests above).
    frames = _opening_frames(_agent(), "realtime", "pipecat:ultravox/ultravox-v0.7", handover=handover)
    assert frames is None


# --- CallSession wiring: the flag reaches the build of a handover generation ----


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


def _session(model_name: str = "pipecat:openai/gpt-4o-mini") -> CallSession:
    class _StubGatewaySession:
        transport = None

        async def shutdown(self) -> None:  # pragma: no cover
            return None

    return CallSession(
        session_id="s1",
        agent={"id": "agent-1", "modelName": model_name, "prompt": "old", "options": {}},
        instance={"streamLog": False},
        sip_gateway=None,  # type: ignore[arg-type]
        gateway_session=_StubGatewaySession(),  # type: ignore[arg-type]
        call=_call_record("call-1", "agent-1"),
    )


def _record_builds(monkeypatch) -> list:
    """Stub build_voice_session: record each build's ``handover`` and stop there."""
    from pipecat_aplisay import call_session as cs

    seen: list = []

    async def fake_build(**kwargs):
        seen.append(kwargs.get("handover"))
        raise _Stop

    monkeypatch.setattr(cs, "build_voice_session", fake_build)
    return seen


def test_first_build_is_not_a_handover(monkeypatch):
    seen = _record_builds(monkeypatch)
    session = _session()
    with pytest.raises(_Stop):
        asyncio.run(session.prepare_run(session.agent, session.agent["modelName"], "sys"))
    assert seen == [False]


def test_run_prepared_builds_the_handover_generation_with_the_flag(monkeypatch):
    seen = _record_builds(monkeypatch)
    session = _session()
    runs: list = []

    async def fake_run_once(task, max_duration_secs):
        # The outgoing agent's pipeline ends with a full handover pending, as
        # _begin_agent_handover leaves it.
        runs.append(task)
        if len(runs) == 1:
            session._pending_agent_handover = {
                "agent": {"id": "agent-2", "modelName": "pipecat:openai/gpt-4o-mini", "prompt": "new", "options": {}},
                "system_prompt": "You are agent two.",
                "call": _call_record("call-2", "agent-2"),
                "transport": object(),
                "history": None,
            }

    session._run_prepared_once = fake_run_once
    with pytest.raises(_Stop):
        asyncio.run(session.run_prepared(object(), None))
    assert seen == [True]
    assert session._is_handover_generation is True


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
