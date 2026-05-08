"""Per-call orchestration — sections 7 (lifecycle) and 9.1 (fallback).

Wraps a single agent session around a :class:`GatewaySession` and drives the
contract:

- Concurrency reservation via ``call.start()`` before the run stage.
- Build the voice session (realtime or pipeline).
- Run the Pipecat ``PipelineTask``.
- On any disconnect / error, end the call with the right reason from the
  taxonomy in section 7.3 and flush invocation logs.
- Fallback loop per section 9.1: try ``modelName`` → ``fallback.model`` →
  ``fallback.agent`` → ``fallback.number`` (last-resort blind transfer).

The :class:`SipGateway` indirection means this module does not know whether the
SIP leg is a Daily room, a FreeSWITCH bridge, or anything else.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from loguru import logger
from pipecat.pipeline.runner import PipelineRunner

from . import api_client
from .agent_tools import build_agent_tools
from .constants import DISCONNECT_REASONS, PLATFORM
from .sip_gateway.base import (
    GatewaySession,
    GatewaySessionParams,
    InboundCallContext,
    OutboundCallParams,
    SipGateway,
    TransferRequest,
)
from .voice_session import build_voice_session


@dataclass
class TransferState:
    state: str = "none"
    description: str = "No transfer in progress"


@dataclass
class CallSession:
    """Top-level handle for a running call."""

    session_id: str
    agent: dict
    instance: dict
    sip_gateway: SipGateway
    gateway_session: GatewaySession
    call: api_client.CallRecord
    transfer_state: TransferState = field(default_factory=TransferState)
    _runner: Optional[PipelineRunner] = None
    _wants_hangup: bool = False
    _shutdown: asyncio.Event = field(default_factory=asyncio.Event)

    async def run(self, *, system_prompt: str) -> None:
        """Run the agent session with fallback handling."""
        active_agent = self.agent
        active_model = active_agent["modelName"]
        used_fallback_model = False
        used_fallback_agent = False

        while True:
            fallback_cfg = (active_agent.get("options") or {}).get("fallback") or {}
            try:
                await self._run_once(active_agent, active_model, system_prompt)
                return
            except api_client.AgentConcurrencyLimitExceededBusyError:
                # Map upstream — caller signals SIP busy / 429 to its caller.
                raise
            except Exception as e:  # noqa: BLE001
                logger.error(f"voice session failed: {e}; evaluating fallback")
                if not fallback_cfg:
                    raise

                # 1. Agent-level fallback
                if (
                    not used_fallback_agent
                    and fallback_cfg.get("agent")
                    and fallback_cfg["agent"] != active_agent.get("id")
                ):
                    try:
                        next_agent = await api_client.get_agent_by_id(fallback_cfg["agent"])
                        active_agent = next_agent
                        active_model = next_agent["modelName"]
                        used_fallback_agent = True
                        used_fallback_model = False
                        continue
                    except Exception as inner:  # noqa: BLE001
                        logger.warning(f"fallback agent failed: {inner}")

                # 2. Model-level fallback
                if (
                    not used_fallback_model
                    and fallback_cfg.get("model")
                    and fallback_cfg["model"] != active_model
                ):
                    used_fallback_model = True
                    active_model = fallback_cfg["model"]
                    continue

                # 3. Number-level fallback (blind transfer)
                if fallback_cfg.get("number"):
                    try:
                        await self.gateway_session.transfer(
                            TransferRequest(
                                destination=fallback_cfg["number"],
                                operation="blind",
                                can_refer=False,
                                force_bridged=True,
                            )
                        )
                        return
                    except Exception as inner:  # noqa: BLE001
                        logger.error(f"fallback transfer failed: {inner}")
                        raise inner

                raise

    async def _run_once(self, agent: dict, model_name: str, system_prompt: str) -> None:
        metadata = self.call.metadata
        tools = build_agent_tools(
            agent=agent,
            metadata=metadata,
            send_message=self._send_message,
            on_hangup=self._on_hangup,
            on_transfer=self._on_transfer,
            get_transfer_state=lambda: {"state": self.transfer_state.state, "description": self.transfer_state.description},
        )

        task = await build_voice_session(
            transport=self.gateway_session.transport,
            model_name=model_name,
            agent=agent,
            metadata=metadata,
            tools=tools,
            system_prompt=system_prompt,
        )

        # Mandatory maxDuration enforcement — section 7.2.
        max_duration_secs = _parse_duration((agent.get("options") or {}).get("maxDuration"))

        runner = PipelineRunner(handle_sigint=False)
        self._runner = runner

        timeout_task: Optional[asyncio.Task] = None
        if max_duration_secs:
            timeout_task = asyncio.create_task(self._timeout_watchdog(max_duration_secs))

        try:
            await runner.run(task)
            # Normal completion when transport disconnects or pipeline ends.
            await self._end(DISCONNECT_REASONS["ORIGINAL_PARTICIPANT"])
        finally:
            if timeout_task and not timeout_task.done():
                timeout_task.cancel()

    async def _timeout_watchdog(self, seconds: int) -> None:
        try:
            await asyncio.sleep(seconds)
            logger.warning({"seconds": seconds}, "max duration reached, ending call")
            await self._end(DISCONNECT_REASONS["SESSION_TIMEOUT"])
            await self.gateway_session.shutdown()
        except asyncio.CancelledError:
            pass

    # ---- Tool callbacks ----

    async def _send_message(self, message: dict) -> None:
        """Forward a transaction-log entry. Live-stream or batch per instance flag."""
        try:
            type_, data = next(iter(message.items()))
        except StopIteration:
            return
        if type_ == "status":
            return

        entry = {
            "userId": self.call.userId,
            "organisationId": self.call.organisationId,
            "callId": self.call.id,
            "type": type_,
            "data": data if isinstance(data, str) else _json_dumps_safe(data),
            "isFinal": True,
        }
        if self.instance.get("streamLog"):
            try:
                await api_client.create_transaction_log(entry)
            except Exception as e:  # noqa: BLE001
                logger.warning(f"transaction log post failed: {e}")
        else:
            self.call.batched_transaction_logs.append(entry)

    async def _on_hangup(self) -> None:
        self._wants_hangup = True
        await self._end(DISCONNECT_REASONS["AGENT_INITIATED_HANGUP"])
        await self.gateway_session.shutdown()

    async def _on_transfer(self, args: dict) -> dict:
        try:
            self.transfer_state = TransferState("dialling", f"Transferring to {args.get('number')}")
            await self.gateway_session.transfer(
                TransferRequest(
                    destination=args["number"],
                    operation=args.get("operation", "blind"),
                    caller_id_override=args.get("callerId"),
                    can_refer=False,  # Daily transfer is always blind today
                    force_bridged=bool(args.get("forceBridged")),
                )
            )
            self.transfer_state = TransferState("talking", "Transfer connected")
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            logger.error(f"transfer failed: {e}")
            self.transfer_state = TransferState("failed", str(e))
            return {"error": str(e)}

    # ---- Lifecycle ----

    async def _end(self, reason: str) -> None:
        try:
            await api_client.end_call(self.call, reason=reason)
        except Exception as e:  # noqa: BLE001
            logger.error(f"end_call failed: {e}")


# ---- Helpers ----


def _parse_duration(value: Any) -> Optional[int]:
    if not value:
        return None
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        v = value.strip().lower()
        if v.endswith("s"):
            v = v[:-1]
        try:
            return int(float(v))
        except ValueError:
            return None
    return None


def _json_dumps_safe(value: Any) -> str:
    import json

    try:
        return json.dumps(value, default=str)
    except Exception:  # noqa: BLE001
        return str(value)


# ---- Constructors ----


async def setup_inbound_call(
    sip_gateway: SipGateway,
    inbound: InboundCallContext,
    *,
    instance: dict,
    agent: dict,
) -> CallSession:
    session_params = GatewaySessionParams(session_id=inbound.session_id)
    gw_session = await sip_gateway.setup_inbound(inbound, session_params)
    call = await api_client.create_call(
        {
            "userId": agent["userId"],
            "organisationId": agent["organisationId"],
            "instanceId": instance["id"],
            "agentId": agent["id"],
            "platform": PLATFORM,
            "platformCallId": inbound.session_id,
            "calledId": inbound.called_id,
            "callerId": inbound.caller_id,
            "modelName": agent["modelName"],
            "options": agent.get("options") or {},
            "metadata": {
                **(instance.get("metadata") or {}),
                "aplisay": {
                    "callerId": inbound.caller_id,
                    "calledId": inbound.called_id,
                    "callId": inbound.call_id,
                    "model": agent["modelName"],
                },
            },
        }
    )
    await api_client.start_call(call)
    return CallSession(
        session_id=inbound.session_id,
        agent=agent,
        instance=instance,
        sip_gateway=sip_gateway,
        gateway_session=gw_session,
        call=call,
    )


async def setup_outbound_call(
    sip_gateway: SipGateway,
    *,
    session_id: str,
    call_id: str,
    instance: dict,
    agent: dict,
    caller_id: str,
    called_id: str,
    aplisay_id: Optional[str],
    extra_session_params: Optional[dict] = None,
) -> CallSession:
    """Note: the originate side reserves the concurrency slot at the JS layer.

    The JS handler creates the Call record and calls ``call.start()`` before
    dispatching, so we re-fetch the existing Call here rather than creating a
    new one.
    """
    params = OutboundCallParams(
        caller_id=caller_id,
        called_id=called_id,
        call_id=call_id,
        aplisay_id=aplisay_id,
    )
    session_params = GatewaySessionParams(session_id=session_id)
    if extra_session_params:
        for k, v in extra_session_params.items():
            setattr(session_params, k, v)
    gw_session = await sip_gateway.originate(params, session_params)

    # The Call record was created in lib/handlers/pipecat.js. The Python worker
    # needs a representation to drive end(); reconstruct it from the agent /
    # instance the dispatcher passed.
    call = api_client.CallRecord(
        id=call_id,
        userId=agent["userId"],
        organisationId=agent["organisationId"],
        instanceId=instance["id"],
        agentId=agent["id"],
        metadata={
            "aplisay": {"callerId": caller_id, "calledId": called_id, "callId": call_id, "model": agent["modelName"]},
            "aplisayId": aplisay_id,
            "outbound": True,
        },
        options={"outbound": True},
    )
    return CallSession(
        session_id=session_id,
        agent=agent,
        instance=instance,
        sip_gateway=sip_gateway,
        gateway_session=gw_session,
        call=call,
    )
