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
        targets[key] = BtaTarget(
            key=key,
            agent_id=str(agent_id),
            include_history=True if include_history is None else bool(include_history),
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
                lambda: asyncio.ensure_future(self._on_timeout(exact)),
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
    session's pipeline — and its call record — end shortly after)."""

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


def bta_context_from_session(session: Any, targets: dict[str, BtaTarget]) -> BtaContext:
    """Snapshot a parent CallSession into a :class:`BtaContext`."""
    aplisay_meta = dict((session.call.metadata or {}).get("aplisay") or {})
    options = session.agent.get("options") or {}
    timeout_ms = options.get("dtmfTimeout")
    try:
        timeout_s = max(0.25, float(timeout_ms) / 1000.0) if timeout_ms is not None else 1.5
    except (TypeError, ValueError):
        timeout_s = 1.5
    return BtaContext(
        targets=targets,
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
    )


def compose_takeover_prompt(new_agent: dict, ctx: BtaContext, target: BtaTarget) -> str:
    """Build the incoming agent's system prompt. Mirrors the
    ``transfer_agent`` builtin's composition (call_session.py)."""
    prompt = new_agent.get("prompt") or "You are a helpful assistant."
    prompt += (
        "\n\nYou have just taken over a live call. The caller was previously "
        "speaking with another agent and was then transferred to a human, who "
        "has now handed the call back to you."
    )
    if target.include_history and ctx.transcript:
        prompt += (
            "\n\n# Conversation between the caller and the previous agent\n"
            + ctx.transcript
            + "\n\n(The conversation the caller had with the human after the "
            "transfer was not recorded.)"
        )
    elif not target.include_history:
        prompt += " Treat this as a fresh conversation: disregard any prior context."
    return prompt


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
            "metadata": {
                **(ctx.metadata or {}),
                "aplisay": {
                    **aplisay_meta,
                    "model": model_name,
                    "bridgedTransferToAgent": {"key": target.key},
                },
            },
        }
    )
    # Reserve the concurrency slot; a busy rejection aborts the takeover
    # with the human bridge still up.
    await api_client.start_call(call)

    # The composed prompt rides in the agent dict so the standard
    # ``_run_session`` entry point (which reads ``agent["prompt"]``) uses it.
    agent_for_run = dict(new_agent)
    agent_for_run["prompt"] = prompt
    return TakeoverPayload(agent=agent_for_run, instance=ctx.instance, call=call)


def new_takeover_session_id(prefix: str) -> str:
    return f"{prefix}-bta-{uuid.uuid4()}"


async def _end_call_quiet(call: api_client.CallRecord, reason: str) -> None:
    try:
        await api_client.end_call(call, reason=reason)
    except Exception as e:  # noqa: BLE001
        logger.warning(f"bridgedTransferToAgent: end_call after failure failed: {e}")


def arm_voiceblender_bta_watch(gateway: Any, gw_session: Any, ctx: BtaContext, *, platform: str) -> None:
    """Arm the voiceblender post-bridge watch: route the transfer-target
    leg's VSI ``dtmf.received`` events through a sequence matcher; on a
    match, reserve the continuation call, stash the TakeoverPayload, and
    run the gateway-side takeover (drop target, un-room the caller leg,
    re-attach a Pipecat agent). The watch dies with either bridged leg."""
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
        gateway.clear_bta_watcher(target_leg, caller_leg)

    matcher = DtmfSequenceMatcher(
        list(ctx.targets), on_match, timeout_s=ctx.dtmf_timeout_s
    )

    def on_gone() -> None:
        matcher.cancel()
        gateway.clear_bta_watcher(target_leg, caller_leg)

    gateway.register_bta_watcher(target_leg, caller_leg, matcher.feed, on_gone)


async def run_sipbridge_bta_watch(
    websocket: Any, gateway: Any, gw_session: Any, ctx: BtaContext, *, platform: str
) -> None:
    """Post-bridge watch loop for sipbridge, run by the /sipbridge/agent WS
    handler AFTER the pipeline has ended (the bridge kept the WS open in
    control-only mode). Reads Pipecat protobuf frames straight off the
    socket, feeds ``source: "transfer_target"`` DTMF events through the
    matcher, and on a match POSTs the unbridge (the bridge then closes this
    WS and dials a fresh one for the takeover session). Returns when the
    WS closes — takeover or plain end-of-bridge alike."""
    from pipecat.frames.frames import InputTransportMessageFrame
    from pipecat.serializers.protobuf import ProtobufFrameSerializer
    from starlette.websockets import WebSocketDisconnect

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
        # The bridge tears this monitor WS down as part of the unbridge;
        # the receive loop below unwinds on the disconnect.

    matcher = DtmfSequenceMatcher(
        list(ctx.targets), on_match, timeout_s=ctx.dtmf_timeout_s
    )
    serializer = ProtobufFrameSerializer()
    logger.bind(keys=sorted(ctx.targets.keys())).info(
        "bridgedTransferToAgent: sipbridge monitor loop running"
    )
    try:
        while True:
            data = await websocket.receive_bytes()
            try:
                frame = await serializer.deserialize(data)
            except Exception:  # noqa: BLE001
                continue
            if not isinstance(frame, InputTransportMessageFrame):
                continue
            message = frame.message
            if (
                isinstance(message, dict)
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
        logger.warning(f"bridgedTransferToAgent: sipbridge monitor loop ended: {e}")
    finally:
        matcher.cancel()
        logger.info("bridgedTransferToAgent: sipbridge monitor loop finished")
