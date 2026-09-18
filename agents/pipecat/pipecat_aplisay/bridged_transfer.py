"""Human-to-agent transfers (``options.bridgedTransferToAgent``).

After a **bridged** transfer (blind ``dial_bridge`` or a consultative
finalise), the caller is talking to a human transfer target and the AI
has left the call. ``options.bridgedTransferToAgent`` lets the *transfer
target* hand the caller back to an AI agent by pressing a DTMF sequence:

    "options": {
      "bridgedTransferToAgent": {
        "1":  { "agent": "<uuid>" },
        "*7": { "agent": "<uuid>", "includeHistory": false }
      }
    }

While the option is set, transfers are forced onto the bridged path
(REFER would hand the call off-platform, where no DTMF can be observed)
and the worker keeps watching DTMF **from the transfer-target leg only**:

- **sipbridge**: the bridge keeps the caller leg's worker WS open as a
  control channel (``monitor_dtmf: true`` on the transfer) and ships
  target-leg RFC 4733 presses as ``{"type":"dtmf",...,
  "source":"transfer_target"}`` MessageFrames. The worker's WS handler
  watches those after the pipeline ends (see ``worker.py``), and on a
  match POSTs ``/v1/calls/{id}/unbridge`` — the bridge drops the target
  and re-dials a fresh agent WS for the caller leg.
- **voiceblender**: the two legs sit in a room and DTMF arrives on the
  VSI event stream per leg; the gateway routes target-leg digits to a
  watcher registered here. On a match the worker deletes the target
  leg, pulls the caller out of the room, and re-attaches a Pipecat
  agent to the caller leg (``POST /v1/legs/{id}/agent/pipecat``).

Either way the takeover lands in the per-gateway WS handler as a fresh
WS whose ``session_id`` maps to a :class:`TakeoverPayload` stashed on
the gateway — the handler builds a new CallSession for the mapped agent
on a child call record and runs it. History carry (``includeHistory``,
default true) mirrors the ``transfer_agent`` builtin: the original
agent↔caller conversation is embedded in the incoming agent's prompt
(the human-bridge period itself is untranscribed).

See ``docs/call-transfers.md`` (“Human to agent transfers”).
"""

from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from loguru import logger

from . import api_client

# Matches the server-side validation in lib/database.js — 1-8 chars of
# the keypad symbols RFC 4733 carries (A-D are unsupported end-to-end).
_DTMF_KEY_CHARS = set("0123456789*#")


@dataclass
class BtaTarget:
    """One entry of the bridgedTransferToAgent map, normalised."""

    key: str
    agent_id: str
    include_history: bool = True
    # Optional text agent pre-fired at hand-back to summarise the carried
    # transcripts; the takeover agent collects it with ``transfer_summary``.
    summary_agent_id: Optional[str] = None


def parse_bta_map(options: Optional[dict]) -> Optional[dict[str, BtaTarget]]:
    """Parse ``options.bridgedTransferToAgent`` into key → :class:`BtaTarget`.

    The server has already validated + normalised the option (values are
    ``{agent, includeHistory?, fromLabel?}`` objects with UUID agents), but
    be lenient here: skip malformed entries with a warning rather than
    failing the call. Returns ``None`` when the option is absent/empty.
    """
    raw = (options or {}).get("bridgedTransferToAgent")
    if not isinstance(raw, dict) or not raw:
        return None
    targets: dict[str, BtaTarget] = {}
    for key, value in raw.items():
        key = str(key)
        if not (1 <= len(key) <= 8) or not all(c in _DTMF_KEY_CHARS for c in key):
            logger.warning(f"bridgedTransferToAgent: ignoring malformed key {key!r}")
            continue
        entry = {"agent": value} if isinstance(value, str) else value
        agent_id = (entry or {}).get("agent") if isinstance(entry, dict) else None
        if not agent_id:
            logger.warning(f"bridgedTransferToAgent[{key!r}]: ignoring entry without agent")
            continue
        include_history = entry.get("includeHistory")
        summary_agent = entry.get("summaryAgent")
        targets[key] = BtaTarget(
            key=key,
            agent_id=str(agent_id),
            include_history=True if include_history is None else bool(include_history),
            summary_agent_id=str(summary_agent) if summary_agent else None,
        )
    return targets or None


class DtmfSequenceMatcher:
    """Multi-digit DTMF matcher with inter-digit timeout semantics.

    Feed digits as they arrive; ``on_match(key)`` fires (once) when a
    configured sequence is recognised:

    - a buffer that exactly matches a key AND cannot be extended into a
      longer key fires immediately;
    - a buffer that matches a key but is also a prefix of a longer key
      fires after ``timeout_s`` of silence (giving the longer key a
      chance);
    - a buffer that is only a proper prefix resets after ``timeout_s``;
    - non-matching digits slide out of the buffer (oldest first), so a
      stray press doesn't poison a following valid sequence.

    ``timeout_s`` intentionally reuses the platform's DTMF aggregation
    default (``options.dtmfTimeout``, 1.5 s).
    """

    def __init__(
        self,
        keys: list[str],
        on_match: Callable[[str], Awaitable[None]],
        *,
        timeout_s: float = 1.5,
    ) -> None:
        self._keys = list(keys)
        self._on_match = on_match
        self._timeout_s = timeout_s
        self._buffer = ""
        self._timer: Optional[asyncio.TimerHandle] = None
        self._fired = False
        self._lock = asyncio.Lock()

    def cancel(self) -> None:
        if self._timer is not None:
            self._timer.cancel()
            self._timer = None

    async def feed(self, digit: str) -> None:
        async with self._lock:
            if self._fired:
                return
            self.cancel()
            self._buffer += str(digit)
            # Slide until the buffer is a prefix of at least one key.
            while self._buffer and not any(k.startswith(self._buffer) for k in self._keys):
                self._buffer = self._buffer[1:]
            if not self._buffer:
                return
            exact = self._buffer in self._keys
            extendable = any(k != self._buffer and k.startswith(self._buffer) for k in self._keys)
            if exact and not extendable:
                await self._fire(self._buffer)
                return
            # Exact-but-extendable resolves on timeout to the exact key;
            # a bare prefix resolves on timeout to a reset.
            loop = asyncio.get_running_loop()
            self._timer = loop.call_later(
                self._timeout_s,
                lambda: _detach(self._on_timeout(exact)),
            )

    async def _on_timeout(self, exact: bool) -> None:
        async with self._lock:
            if self._fired:
                return
            buffer, self._buffer = self._buffer, ""
            self._timer = None
            if exact and buffer in self._keys:
                await self._fire(buffer)

    async def _fire(self, key: str) -> None:
        self._fired = True
        self._buffer = ""
        self.cancel()
        try:
            await self._on_match(key)
        except Exception as e:  # noqa: BLE001
            logger.error(f"bridgedTransferToAgent: on_match({key!r}) failed: {e}")
            # Allow another attempt if the takeover errored (e.g. target
            # agent at concurrency limit) — the bridge is still up.
            self._fired = False


@dataclass
class BtaContext:
    """Everything the post-bridge watcher needs, captured from the parent
    CallSession at the moment the monitored bridge is installed (the
    session's pipeline — and its call record — end shortly after).

    ``targets`` may be empty when the watch exists only for transcription
    (``bridgedTransferTranscribe`` without ``bridgedTransferToAgent``).
    """

    targets: dict[str, BtaTarget]
    agent: dict
    instance: dict
    parent_call_id: str
    organisation_id: Optional[str]
    user_id: Optional[str]
    instance_id: Optional[str]
    caller_id: str
    called_id: str
    transcript: str
    metadata: dict = field(default_factory=dict)
    dtmf_timeout_s: float = 1.5
    # Bridged-segment transcription (``options.bridgedTransferTranscribe``):
    # normalised config or None, the transfer destination (the bridged
    # record's calledId), and — once ``prepare_bridge_monitor`` has run —
    # the started bridged-segment call record + its transcript collector.
    transcribe: Optional[dict] = None
    destination: str = ""
    stream_log: bool = False
    bridged_call: Optional[api_client.CallRecord] = None
    collector: Optional[Any] = None
    # Consultative transfers only: the TransferAgent↔target briefing
    # conversation, snapshotted when the consult accept installs the bridge.
    # Seeded into the takeover call's ``aplisay.transfer.consultTranscript``.
    consult_transcript: str = ""
    # Bridged-segment recording (sipbridge only): when the original call's
    # effective recording is enabled, the monitor loop also writes the tap's
    # stereo audio (L=caller, R=target) to a RecordingSession keyed to the
    # bridged call record, encrypted with the same client key.
    recording_enabled: bool = False
    recording_key: Optional[str] = None


@dataclass
class TakeoverPayload:
    """Stashed on the gateway between a DTMF match and the fresh agent
    WS arriving at the worker (mirrors :class:`ConsultPayload`). The
    ``agent`` dict already carries the composed takeover prompt in its
    ``prompt`` field, and ``call`` is the started child call record.
    ``extra`` carries gateway-specific correlation (e.g. voiceblender's
    caller ``leg_id``)."""

    agent: dict
    instance: dict
    call: api_client.CallRecord
    extra: dict = field(default_factory=dict)
    # Resolves to the pre-fired summaryAgent result (``{"status": ...}``) —
    # threaded onto the takeover CallSession so its ``transfer_summary``
    # builtin can await it. None when the map entry has no summaryAgent.
    summary_future: Optional[Any] = None


def bta_context_from_session(
    session: Any,
    targets: Optional[dict[str, BtaTarget]],
    *,
    transcribe: Optional[dict] = None,
    destination: str = "",
    consult_transcript: str = "",
    recording: Optional[Any] = None,
) -> BtaContext:
    """Snapshot a parent CallSession into a :class:`BtaContext`.

    ``recording`` is the parent call's resolved ``_RecordingOptions`` (or
    None) — when enabled, the sipbridge monitor loop records the bridged
    segment with the same client encryption key."""
    aplisay_meta = dict((session.call.metadata or {}).get("aplisay") or {})
    options = session.agent.get("options") or {}
    timeout_ms = options.get("dtmfTimeout")
    try:
        timeout_s = max(0.25, float(timeout_ms) / 1000.0) if timeout_ms is not None else 1.5
    except (TypeError, ValueError):
        timeout_s = 1.5
    return BtaContext(
        targets=targets or {},
        agent=session.agent,
        instance=session.instance,
        parent_call_id=session.call.id,
        organisation_id=session.call.organisationId,
        user_id=session.call.userId,
        instance_id=session.call.instanceId,
        caller_id=aplisay_meta.get("callerId") or "unknown",
        called_id=aplisay_meta.get("calledId") or "unknown",
        transcript=session.get_parent_transcript(),
        metadata=dict(session.call.metadata or {}),
        dtmf_timeout_s=timeout_s,
        transcribe=transcribe,
        destination=destination,
        stream_log=bool((session.instance or {}).get("streamLog")),
        consult_transcript=consult_transcript,
        recording_enabled=bool(getattr(recording, "enabled", False)),
        recording_key=getattr(recording, "key", None),
    )


async def prepare_bridge_monitor(ctx: BtaContext, *, platform: str) -> BtaContext:
    """Create + start the bridged-segment call record (child of the
    original call, ``modelName: "telephony:bridged-call"`` — LiveKit
    parity) and, when transcription is enabled, its transcript collector.
    Failures are logged, not raised: the bridge itself must proceed even
    if the record can't be created."""
    from .bridge_transcript import BridgeTranscriptCollector

    aplisay_meta = dict((ctx.metadata or {}).get("aplisay") or {})
    try:
        call = await api_client.create_call(
            {
                "parentId": ctx.parent_call_id,
                "userId": ctx.user_id,
                "organisationId": ctx.organisation_id,
                "instanceId": ctx.instance_id,
                "agentId": ctx.agent.get("id"),
                "platform": platform,
                "platformCallId": f"bridge-{ctx.parent_call_id}",
                "calledId": ctx.destination or ctx.called_id,
                "callerId": ctx.caller_id,
                "modelName": "telephony:bridged-call",
                "options": {},
                "metadata": {
                    **(ctx.metadata or {}),
                    "aplisay": {
                        **aplisay_meta,
                        "model": "telephony:bridged-call",
                        "bridgeOf": ctx.parent_call_id,
                    },
                },
            }
        )
        await api_client.start_call(call)
        ctx.bridged_call = call
        if ctx.transcribe:
            ctx.collector = BridgeTranscriptCollector(
                call=call, stream_log=ctx.stream_log
            )
    except Exception as e:  # noqa: BLE001
        logger.warning(f"bridged transfer: bridged call record creation failed: {e}")
    return ctx


async def maybe_start_bridge_recorder(ctx: BtaContext) -> Optional[Any]:
    """Open a RecordingSession for the bridged segment when the original
    call's effective recording is enabled and a bridged record exists
    (sipbridge topology only — voiceblender exposes no audio tap). The
    tap's interleaved stereo (L=caller, R=target) is written as-is, so the
    recording carries the same per-speaker channel separation as the
    transcript. Best-effort: a failure never disturbs the watch."""
    if not ctx.recording_enabled or ctx.bridged_call is None:
        return None
    try:
        from .recording import RecordingSession

        recorder = RecordingSession(
            call_id=ctx.bridged_call.id,
            client_encryption_key=ctx.recording_key,
        )
        await recorder.start()
        logger.bind(call_id=ctx.bridged_call.id).info(
            "bridged transfer: recording the bridged segment"
        )
        return recorder
    except Exception as e:  # noqa: BLE001
        logger.warning(f"bridged transfer: recording setup failed: {e}")
        return None


async def finalise_bridge_recorder(recorder: Optional[Any], ctx: BtaContext) -> None:
    """Encode/encrypt/upload the bridged-segment recording and stamp its
    recordingId on the bridged call record. Best-effort, idempotent-safe."""
    if recorder is None or ctx.bridged_call is None:
        return
    try:
        result = await recorder.stop_and_upload()
    except Exception as e:  # noqa: BLE001
        logger.warning(f"bridged transfer: recording upload failed: {e}")
        return
    if result is None:
        return
    try:
        await api_client.set_call_recording_data(
            ctx.bridged_call.id, result.gcs_object, result.server_generated_key
        )
    except Exception as e:  # noqa: BLE001
        logger.warning(f"bridged transfer: recording metadata PUT failed: {e}")


async def end_bridged_record(ctx: BtaContext, reason: str) -> None:
    """End the bridged-segment record (idempotent — ``end_call`` guards
    re-entry), flushing any batched transcript entries with it."""
    if ctx.bridged_call is None:
        return
    try:
        await api_client.end_call(ctx.bridged_call, reason=reason)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"bridged transfer: ending bridged record failed: {e}")


# Per-transcript cap for the ``aplisay.transfer.*`` metadata keys: protects
# the call row (JSONB) from unbounded transcripts while keeping far more than
# any realistic conversation. The TAIL is kept — the most recent turns are the
# ones the takeover flow acts on.
TRANSFER_METADATA_TRANSCRIPT_MAX = 32_000


def clip_transcript_for_metadata(text: str, limit: int = TRANSFER_METADATA_TRANSCRIPT_MAX) -> str:
    """Tail-truncate a rendered transcript for metadata seeding."""
    text = text or ""
    if len(text) <= limit:
        return text
    return "(… earlier conversation truncated)\n" + text[-limit:]


def transfer_metadata_block(ctx: BtaContext, target: BtaTarget) -> dict:
    """The ``aplisay.transfer`` metadata block seeded onto the takeover call
    (docs/transfer-back-plan.md). Always seeded, independent of the
    ``includeHistory`` prompt gate: the transcripts are then addressable by
    ``promptMetadata`` ``from`` paths, the ``get_metadata`` builtin, and —
    the main event — ``source: "metadata"`` function parameters, which carry
    them out-of-band of the model's context (e.g. to a summariser subagent).
    Empty values are omitted so absent facts never render as statements."""
    bridge_transcript = ctx.collector.render() if ctx.collector is not None else ""
    block = {
        "key": target.key,
        "targetNumber": ctx.destination or "",
        "parentTranscript": clip_transcript_for_metadata(ctx.transcript),
        "bridgeTranscript": clip_transcript_for_metadata(bridge_transcript),
        "consultTranscript": clip_transcript_for_metadata(ctx.consult_transcript),
    }
    return {k: v for k, v in block.items() if v}


def compose_takeover_prompt(new_agent: dict, ctx: BtaContext, target: BtaTarget) -> str:
    """Build the incoming agent's system prompt. Mirrors the
    ``transfer_agent`` builtin's composition (call_session.py). When the
    bridged segment was transcribed (``bridgedTransferTranscribe``), the
    human↔human conversation is carried too."""
    prompt = new_agent.get("prompt") or "You are a helpful assistant."
    prompt += (
        "\n\nYou have just taken over a live call. The caller was previously "
        "speaking with another agent and was then transferred to a human, who "
        "has now handed the call back to you."
    )
    if not target.include_history:
        prompt += " Treat this as a fresh conversation: disregard any prior context."
        return prompt
    if ctx.transcript:
        prompt += (
            "\n\n# Conversation between the caller and the previous agent\n"
            + ctx.transcript
        )
    bridge_transcript = ctx.collector.render() if ctx.collector is not None else ""
    if bridge_transcript:
        prompt += (
            "\n\n# Conversation between the caller and the human transfer target\n"
            + bridge_transcript
        )
    elif ctx.transcript:
        prompt += (
            "\n\n(The conversation the caller had with the human after the "
            "transfer was not recorded.)"
        )
    return prompt


# Strong references to in-flight summariser tasks (asyncio only keeps weak
# ones); discarded on completion.
_summary_tasks: set = set()

# Strong references for detached one-shot coroutines (P10). asyncio holds
# only weak references to tasks, so a bare ``ensure_future`` whose result
# nobody awaits can be collected before it runs.
_detached_tasks: set = set()


def _detach(coro) -> "asyncio.Task":
    """Fire-and-forget a coroutine, holding a reference until it finishes."""
    task = asyncio.ensure_future(coro)
    _detached_tasks.add(task)
    task.add_done_callback(_detached_tasks.discard)
    return task


def prefire_summary(
    target: BtaTarget, transfer_block: dict, call_metadata: dict, call: api_client.CallRecord
) -> "asyncio.Future[dict]":
    """Fire the map entry's ``summaryAgent`` (a headless text agent) with the
    carried transcripts, without waiting for it. Returns a future resolving to
    the ``transfer_summary`` builtin's result shape — always a value, never an
    exception, so a summariser failure can't leak into the takeover path.

    The invocation is byte-compatible with the playbook pattern (a
    ``summarise_call`` subagent function whose params are ``source: metadata``
    reads of ``aplisay.transfer.*``): the same summariser definition works
    pre-fired or agent-invoked. Usage is billed against the takeover call.
    """
    future: "asyncio.Future[dict]" = asyncio.get_running_loop().create_future()
    input_args = {
        k: v
        for k, v in transfer_block.items()
        if k in ("parentTranscript", "bridgeTranscript", "consultTranscript")
    }

    async def run() -> None:
        try:
            result = await api_client.invoke_subagent(
                str(target.summary_agent_id),
                input_args,
                call_metadata,
                organisation_id=call.organisationId,
                call_id=call.id,
            )
            summary = result
            if isinstance(result, dict):
                summary = result.get("summary") or result.get("result") or result
            future.set_result({"status": "ready", "summary": summary})
            logger.bind(call_id=call.id).info("hand-back summary ready")
        except Exception as e:  # noqa: BLE001
            logger.bind(call_id=call.id, error=str(e)).warning(
                "hand-back summaryAgent failed"
            )
            future.set_result({"status": "failed", "error": str(e)})

    task = asyncio.create_task(run())
    _summary_tasks.add(task)
    task.add_done_callback(_summary_tasks.discard)
    return future


async def prepare_takeover(
    ctx: BtaContext, target: BtaTarget, *, platform: str, session_id: str
) -> TakeoverPayload:
    """Resolve the target agent and reserve the continuation call record.

    Raises on any failure — callers must leave the bridge intact when this
    throws (the humans are still talking; a failed takeover must not drop
    their call).
    """
    new_agent = await api_client.get_internal_agent_by_id(
        target.agent_id, expected_organisation_id=ctx.organisation_id
    )
    if (new_agent.get("type") or "interactive-audio") != "interactive-audio":
        raise RuntimeError(
            f"bridgedTransferToAgent target {target.agent_id} is type "
            f"{new_agent.get('type')} and cannot take over a live call"
        )
    model_name = new_agent.get("modelName") or ""
    if not model_name.startswith("pipecat:"):
        raise RuntimeError(
            f"bridgedTransferToAgent target {target.agent_id} uses {model_name}; "
            "a pipecat call can only be taken over by a pipecat: agent"
        )

    prompt = compose_takeover_prompt(new_agent, ctx, target)
    aplisay_meta = dict((ctx.metadata or {}).get("aplisay") or {})
    transfer_block = transfer_metadata_block(ctx, target)
    call_metadata = {
        **(ctx.metadata or {}),
        "aplisay": {
            **aplisay_meta,
            "model": model_name,
            "bridgedTransferToAgent": {"key": target.key},
            # Carried context for the takeover agent and its tools —
            # aplisay.transfer.{parentTranscript,bridgeTranscript,
            # consultTranscript,key,targetNumber}.
            "transfer": transfer_block,
        },
    }
    call = await api_client.create_call(
        {
            "parentId": ctx.parent_call_id,
            "userId": ctx.user_id,
            "organisationId": ctx.organisation_id,
            "instanceId": ctx.instance_id,
            "agentId": new_agent.get("id"),
            "platform": platform,
            "platformCallId": session_id,
            "calledId": ctx.called_id,
            "callerId": ctx.caller_id,
            "modelName": model_name,
            "options": new_agent.get("options") or {},
            "metadata": call_metadata,
        }
    )
    # Reserve the concurrency slot; a busy rejection aborts the takeover
    # with the human bridge still up.
    await api_client.start_call(call)

    # Pre-fire the entry's summariser (when configured) so the summary is
    # cooking while the unbridge + re-attach happens; the takeover agent
    # collects it with the ``transfer_summary`` builtin. Never blocks or
    # fails the takeover.
    summary_future = None
    if target.summary_agent_id:
        summary_future = prefire_summary(target, transfer_block, call_metadata, call)

    # The composed prompt rides in the agent dict so the standard
    # ``_run_session`` entry point (which reads ``agent["prompt"]``) uses it.
    agent_for_run = dict(new_agent)
    agent_for_run["prompt"] = prompt
    return TakeoverPayload(
        agent=agent_for_run,
        instance=ctx.instance,
        call=call,
        summary_future=summary_future,
    )


def new_takeover_session_id(prefix: str) -> str:
    return f"{prefix}-bta-{uuid.uuid4()}"


async def _end_call_quiet(call: api_client.CallRecord, reason: str) -> None:
    try:
        await api_client.end_call(call, reason=reason)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"bridgedTransferToAgent: end_call after failure failed: {e}")


async def arm_voiceblender_bta_watch(
    gateway: Any, gw_session: Any, ctx: BtaContext, *, platform: str
) -> None:
    """Arm the voiceblender post-bridge watch: route the transfer-target
    leg's VSI ``dtmf.received`` events through a sequence matcher; on a
    match, reserve the continuation call, stash the TakeoverPayload, and
    run the gateway-side takeover (drop target, un-room the caller leg,
    re-attach a Pipecat agent). When transcription is enabled, start the
    container's native STT on both bridged legs and route the ``stt.text``
    finals into the transcript collector. The watch — and the bridged-
    segment call record — die with either bridged leg."""
    from . import bridge_transcript as bt

    target_leg = getattr(gw_session, "bridge_peer_leg_id", None)
    caller_leg = gw_session.leg_id
    if not target_leg:
        logger.warning(
            "bridgedTransferToAgent: voiceblender bridge has no recorded "
            "target leg; watch not armed"
        )
        return

    async def on_match(key: str) -> None:
        target = ctx.targets[key]
        session_id = new_takeover_session_id("vb")
        logger.bind(key=key, agent_id=target.agent_id, session_id=session_id).info(
            "bridgedTransferToAgent: DTMF match — starting takeover"
        )
        payload = await prepare_takeover(ctx, target, platform=platform, session_id=session_id)
        payload.extra["leg_id"] = caller_leg
        gateway.register_takeover_session(session_id, payload)
        try:
            await gw_session.takeover_to_agent(agent_ws_session_id=session_id)
        except Exception:
            gateway.clear_takeover_session(session_id)
            await _end_call_quiet(payload.call, "bridged transfer-to-agent takeover failed")
            raise
        if ctx.transcribe:
            await gateway.stop_leg_stt(caller_leg)
        gateway.clear_bta_watcher(target_leg, caller_leg)
        await end_bridged_record(
            ctx, f"Transfer target handed call back to agent {target.agent_id}"
        )

    matcher: Optional[DtmfSequenceMatcher] = None
    if ctx.targets:
        matcher = DtmfSequenceMatcher(
            list(ctx.targets), on_match, timeout_s=ctx.dtmf_timeout_s
        )

    def on_gone() -> None:
        if matcher is not None:
            matcher.cancel()
        gateway.clear_bta_watcher(target_leg, caller_leg)
        # End the bridged-segment record from a detached task (this
        # callback runs synchronously inside the VSI event loop).
        _detach(end_bridged_record(ctx, "Bridged call ended"))

    async def _drop_digit(_digit: str) -> None:
        return

    gateway.register_bta_watcher(
        target_leg,
        caller_leg,
        matcher.feed if matcher is not None else _drop_digit,
        on_gone,
    )

    # Native per-leg STT for the human↔human transcript. Best-effort: a
    # failed STT start must not break the bridge (or the DTMF watch).
    if ctx.transcribe and ctx.collector is not None:
        collector = ctx.collector

        async def _caller_text(text: str) -> None:
            await collector.add(bt.CALLER, text)

        async def _target_text(text: str) -> None:
            await collector.add(bt.TARGET, text)

        gateway.register_stt_watcher(caller_leg, _caller_text)
        gateway.register_stt_watcher(target_leg, _target_text)
        for leg_id in (caller_leg, target_leg):
            try:
                await gateway.start_leg_stt(
                    leg_id,
                    provider=ctx.transcribe.get("provider") or "elevenlabs",
                    language=ctx.transcribe.get("language"),
                )
            except Exception as e:  # noqa: BLE001
                logger.bind(leg_id=leg_id).warning(
                    f"bridgedTransferTranscribe: native STT start failed: {e}"
                )


async def run_sipbridge_bta_watch(
    websocket: Any, gateway: Any, gw_session: Any, ctx: BtaContext, *, platform: str
) -> None:
    """Post-bridge watch loop for sipbridge, run by the /sipbridge/agent WS
    handler AFTER the pipeline has ended (the bridge kept the WS open in
    control-only mode). Reads Pipecat protobuf frames straight off the
    socket:

    - ``source: "transfer_target"`` DTMF events feed the takeover matcher;
      a match POSTs the unbridge (the bridge then closes this WS and dials
      a fresh one for the takeover session).
    - stereo AudioRawFrames (the ``tap_audio`` transcription tap; L =
      caller, R = target) are split and fed to one STT stream per side,
      built from the agent's configured STT vendor.

    Returns when the WS closes — takeover or plain end-of-bridge alike —
    ending the bridged-segment call record on the way out."""
    from pipecat.frames.frames import AudioRawFrame, InputTransportMessageFrame
    from pipecat.serializers.protobuf import ProtobufFrameSerializer
    from starlette.websockets import WebSocketDisconnect

    from . import bridge_transcript as bt

    async def on_match(key: str) -> None:
        target = ctx.targets[key]
        session_id = new_takeover_session_id("sb")
        logger.bind(key=key, agent_id=target.agent_id, session_id=session_id).info(
            "bridgedTransferToAgent: DTMF match — starting takeover"
        )
        payload = await prepare_takeover(ctx, target, platform=platform, session_id=session_id)
        gateway.register_takeover_session(session_id, payload)
        try:
            await gw_session.unbridge(agent_ws_session_id=session_id)
        except Exception:
            gateway.clear_takeover_session(session_id)
            await _end_call_quiet(payload.call, "bridged transfer-to-agent takeover failed")
            raise
        await end_bridged_record(
            ctx, f"Transfer target handed call back to agent {target.agent_id}"
        )
        # The bridge tears this monitor WS down as part of the unbridge;
        # the receive loop below unwinds on the disconnect.

    matcher: Optional[DtmfSequenceMatcher] = None
    if ctx.targets:
        matcher = DtmfSequenceMatcher(
            list(ctx.targets), on_match, timeout_s=ctx.dtmf_timeout_s
        )

    # Transcription tap consumers — one STT stream per bridged human,
    # using the agent's configured STT vendor. Best-effort: a failed STT
    # build must not break the DTMF watch.
    caller_stt: Optional[bt.SttStream] = None
    target_stt: Optional[bt.SttStream] = None
    if ctx.transcribe and ctx.collector is not None:
        collector = ctx.collector
        try:
            from .voice_session import build_stt_service

            async def _caller_text(text: str) -> None:
                await collector.add(bt.CALLER, text)

            async def _target_text(text: str) -> None:
                await collector.add(bt.TARGET, text)

            caller_stt = bt.SttStream(build_stt_service(ctx.agent), _caller_text)
            target_stt = bt.SttStream(build_stt_service(ctx.agent), _target_text)
            await caller_stt.start()
            await target_stt.start()
        except Exception as e:  # noqa: BLE001
            logger.warning(f"bridgedTransferTranscribe: STT tap setup failed: {e}")
            caller_stt = target_stt = None

    # Bridged-segment recording rides the same stereo tap (WP1.5).
    recorder = await maybe_start_bridge_recorder(ctx)

    serializer = ProtobufFrameSerializer()
    logger.bind(
        keys=sorted(ctx.targets.keys()),
        transcribe=bool(caller_stt),
        recording=recorder is not None,
    ).info("bridged transfer: sipbridge monitor loop running")
    try:
        while True:
            data = await websocket.receive_bytes()
            try:
                frame = await serializer.deserialize(data)
            except Exception:  # noqa: BLE001
                continue
            if isinstance(frame, AudioRawFrame):
                if getattr(frame, "num_channels", 1) == 2:
                    if recorder is not None:
                        await recorder.append_pcm(
                            frame.audio, frame.sample_rate, 2
                        )
                    if caller_stt is not None:
                        left, right = bt.split_stereo(frame.audio)
                        await caller_stt.feed(left)
                        await target_stt.feed(right)
                continue
            if not isinstance(frame, InputTransportMessageFrame):
                continue
            message = frame.message
            if (
                matcher is not None
                and isinstance(message, dict)
                and message.get("type") == "dtmf"
                and message.get("source") == "transfer_target"
                and message.get("digit")
            ):
                await matcher.feed(str(message["digit"]))
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        raise
    except Exception as e:  # noqa: BLE001
        logger.warning(f"bridged transfer: sipbridge monitor loop ended: {e}")
    finally:
        if matcher is not None:
            matcher.cancel()
        for stream in (caller_stt, target_stt):
            if stream is not None:
                await stream.stop()
        # Idempotent — a takeover already ended it with its own reason.
        await end_bridged_record(ctx, "Bridged call ended")
        await finalise_bridge_recorder(recorder, ctx)
        logger.info("bridged transfer: sipbridge monitor loop finished")
