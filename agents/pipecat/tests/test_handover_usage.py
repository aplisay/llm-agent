"""Usage metering across full agent-stack handovers.

A full handover (``transfer_agent`` to another model) cancels the running
pipeline and starts the incoming agent's pipeline on a continuation call, with
a new usage observer. Each leg's meters must reach the ledger against that
leg's own call. Only ``_end`` used to flush, so every leg but the last was
lost. The pipelines, the handover cancel and the usage observer are real; the
build step and the API calls are stubbed.
"""

from __future__ import annotations

import asyncio
from typing import Any, Callable, Optional

from pipecat.frames.frames import EndFrame, MetricsFrame, StartFrame
from pipecat.metrics.metrics import LLMTokenUsage, LLMUsageMetricsData, TTSUsageMetricsData
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.frame_processor import FrameProcessor

from pipecat_aplisay import api_client, invocation_log
from pipecat_aplisay.call_session import CallSession
from pipecat_aplisay.usage import UsageMeteringObserver, usage_vendors

RECEPTION = {"id": "agent-1", "modelName": "pipecat:openai/gpt-4o-mini", "prompt": "reception", "options": {}}
HELPER = {
    "id": "agent-2",
    "modelName": "pipecat:anthropic/claude-sonnet-4-5",
    "prompt": "helper",
    "options": {"tts": {"vendor": "elevenlabs", "voice": "v1"}, "stt": {"vendor": "deepgram"}},
}


class _Speaker(FrameProcessor):
    """Reports LLM turns and TTS characters once the pipeline starts, as the
    services would over a conversation, then calls ``on_start``."""

    def __init__(self, turns: list[tuple[int, int]], characters: list[int], on_start: Callable[[], None]) -> None:
        super().__init__()
        self._turns = turns
        self._characters = characters
        self._on_start = on_start

    async def process_frame(self, frame, direction):  # noqa: ANN001
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if not isinstance(frame, StartFrame):
            return
        for prompt, completion in self._turns:
            usage = LLMTokenUsage(prompt_tokens=prompt, completion_tokens=completion, total_tokens=prompt + completion)
            await self.push_frame(MetricsFrame(data=[LLMUsageMetricsData(processor="llm", model="m", value=usage)]))
        for chars in self._characters:
            await self.push_frame(MetricsFrame(data=[TTSUsageMetricsData(processor="tts", model="t", value=chars)]))
        self._on_start()


def _call(call_id: str, agent_id: str) -> api_client.CallRecord:
    return api_client.CallRecord(
        id=call_id,
        userId="user-1",
        organisationId="org-1",
        instanceId="inst-1",
        agentId=agent_id,
        persisted=False,
    )


class _GatewaySession:
    transport = None

    async def shutdown(self) -> None:  # pragma: no cover
        return None


def _session() -> CallSession:
    return CallSession(
        session_id="s1",
        agent=dict(RECEPTION),
        instance={"streamLog": False},
        sip_gateway=None,  # type: ignore[arg-type]
        gateway_session=_GatewaySession(),  # type: ignore[arg-type]
        call=_call("call-1", RECEPTION["id"]),
    )


# Reception hands over to Helper (a model change, so a full restart), Helper
# hands back to Reception, and the caller hangs up on that last leg.
LEGS: list[dict[str, Any]] = [
    {"turns": [(100, 10)], "characters": [40], "next": (HELPER, "call-2")},
    {"turns": [(1174, 27), (1213, 78)], "characters": [61, 25, 54], "next": (RECEPTION, "call-3")},
    {"turns": [(300, 12)], "characters": [33], "next": None},
]


def _stub(monkeypatch, *, failing_flush_for: Optional[str] = None) -> dict:
    events: list[str] = []
    batches: list[list[dict]] = []
    observers_at_build: list = []

    async def prepare_run(self, agent, model_name, system_prompt, *, history=None):  # noqa: ANN001
        leg = LEGS[len(observers_at_build)]
        observers_at_build.append(getattr(self, "_usage_observer", None))
        events.append(f"build:{self.call.id}")
        self._usage_observer = UsageMeteringObserver(services=usage_vendors(agent, model_name))

        def on_start() -> None:
            if leg["next"] is None:
                return
            next_agent, next_call_id = leg["next"]
            # What _begin_agent_handover leaves behind once it commits.
            self._pending_agent_handover = {
                "agent": dict(next_agent),
                "system_prompt": next_agent["prompt"],
                "call": _call(next_call_id, next_agent["id"]),
                "transport": object(),
                "history": None,
            }
            self._agent_swap_task = asyncio.ensure_future(self._cancel_for_handover())

        task = PipelineTask(Pipeline([_Speaker(leg["turns"], leg["characters"], on_start)]))
        task.add_observer(self._usage_observer)
        if leg["next"] is None:
            # The caller hangs up on the last leg.
            await task.queue_frames([EndFrame()])
        return task, None

    async def save_usage(records):  # noqa: ANN001
        [call_id] = {r["callId"] for r in records}
        events.append(f"usage:{call_id}")
        batches.append(records)

    async def end_call(call, reason=None):  # noqa: ANN001
        events.append(f"end:{call.id}")

    async def flush_invocation_logs(**_kwargs) -> None:
        return None

    monkeypatch.setattr(CallSession, "prepare_run", prepare_run)
    monkeypatch.setattr(api_client, "save_usage", save_usage)
    monkeypatch.setattr(api_client, "end_call", end_call)
    monkeypatch.setattr(invocation_log, "flush_invocation_logs", flush_invocation_logs)

    if failing_flush_for is not None:
        real_flush = UsageMeteringObserver.flush

        async def flush(self, call, *, finalised=False):  # noqa: ANN001
            if call.id == failing_flush_for:
                raise RuntimeError("ledger unreachable")
            await real_flush(self, call, finalised=finalised)

        monkeypatch.setattr(UsageMeteringObserver, "flush", flush)

    return {"events": events, "batches": batches, "observers_at_build": observers_at_build}


def _run(session: CallSession) -> None:
    async def drive() -> None:
        task, max_duration = await session.prepare_run(session.agent, session.agent["modelName"], "reception")
        await asyncio.wait_for(session.run_prepared(task, max_duration), 10)

    asyncio.run(drive())


def _meters(batch: list[dict]) -> dict[tuple[str, str, str], int]:
    return {(r["technology"], r["provider"], r["unit"]): r["quantity"] for r in batch}


def test_each_leg_is_flushed_to_its_own_call_before_the_next_leg_is_built(monkeypatch) -> None:
    seen = _stub(monkeypatch)
    _run(_session())

    assert seen["events"] == [
        "build:call-1",
        "usage:call-1",
        "build:call-2",
        "usage:call-2",
        "build:call-3",
        "usage:call-3",
        "end:call-3",
    ]
    first, second, third = seen["batches"]
    assert all(r["finalised"] is True and r["mode"] == "set" for b in seen["batches"] for r in b)
    assert {r["agentId"] for r in first} == {"agent-1"}
    assert {r["agentId"] for r in second} == {"agent-2"}
    assert {r["agentId"] for r in third} == {"agent-1"}

    # Each leg carries its own vendors and only its own quantities.
    assert _meters(first) == {
        ("llm", "openai", "input_tokens"): 100,
        ("llm", "openai", "output_tokens"): 10,
        ("tts", "cartesia", "characters"): 40,
    }
    assert _meters(second) == {
        ("llm", "anthropic", "input_tokens"): 1174 + 1213,
        ("llm", "anthropic", "output_tokens"): 27 + 78,
        ("tts", "elevenlabs", "characters"): 61 + 25 + 54,
    }
    assert _meters(third) == {
        ("llm", "openai", "input_tokens"): 300,
        ("llm", "openai", "output_tokens"): 12,
        ("tts", "cartesia", "characters"): 33,
    }


def test_no_leg_inherits_the_outgoing_observer(monkeypatch) -> None:
    # Between the handover flush and the next build, an _end (or late aux-STT
    # usage) must not reach the outgoing leg's meters: they would be written
    # again, with mode "set", onto the continuation call.
    seen = _stub(monkeypatch)
    _run(_session())
    assert seen["observers_at_build"] == [None, None, None]


def test_a_failed_flush_does_not_stop_the_handover(monkeypatch) -> None:
    seen = _stub(monkeypatch, failing_flush_for="call-1")
    _run(_session())

    assert seen["events"] == [
        "build:call-1",
        "build:call-2",
        "usage:call-2",
        "build:call-3",
        "usage:call-3",
        "end:call-3",
    ]
