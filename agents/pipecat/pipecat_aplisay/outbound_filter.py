"""Outbound destination authorisation for the Pipecat worker.

Every path that puts a leg out of the platform — blind and consultative
transfers, the WebRTC bridge/consult legs, and the last-resort ``fallback.number``
transfer — must clear this gate before a number is dialled.

The policy itself is NOT here. It lives server-side in llm-agent
(``lib/outbound-authorisation.js``), because only the API server can see the
egress ``Trunk``'s operator filter and the organisation's rating deck:

* on a non-chargeable egress (a registration B2BUA to the customer's own PBX, a
  BYO trunk) the agent's ``options.outboundCallFilter`` is authoritative, as it
  has always been, defaulting to UK geographic/mobile;
* on one of OUR chargeable carrier trunks the operator's per-trunk filter plus a
  rateable destination decide, and the agent's own filter may only narrow that —
  the tenant does not get to choose which destinations we pay a carrier for.

This module is a thin, FAIL-CLOSED client of that decision: any transport or
server error is a refusal, never an allow. Mirrors
``agents/livekit/lib/transfer-handler.ts``.
"""

from dataclasses import dataclass
from typing import Optional

from loguru import logger

from . import api_client


@dataclass
class OutboundDecision:
    """One authorisation decision, as returned by the platform."""

    allowed: bool
    code: str = "unavailable"
    reason: Optional[str] = None
    chargeable: bool = False
    trunk_id: Optional[str] = None
    destination: Optional[str] = None

    @property
    def failure_message(self) -> str:
        """Message to surface to the model as the transfer failure reason."""
        return self.reason or f"destination not authorised ({self.code})"


async def authorise_destination(
    *,
    number: str,
    agent: dict,
    caller_id: Optional[str] = None,
    aplisay_id: Optional[str] = None,
    registration_endpoint_id: Optional[str] = None,
    registration_originated: bool = False,
) -> OutboundDecision:
    """Ask llm-agent whether ``number`` may be dialled on this leg.

    A leg carrying a ``registration_endpoint_id`` egresses the customer's own
    B2BUA (never our carrier), so it is reported as registration-originated
    regardless of how the call itself arrived — matching the billing gate in
    ``_chargeable_outbound_trunk_id``.

    ``caller_id`` lets the platform resolve the egress trunk for a WebRTC-origin
    transfer, whose routing comes from the tool-supplied caller-ID rather than
    from any inbound trunk on the session.
    """
    dialled = (number or "").strip()
    if not dialled:
        return OutboundDecision(
            allowed=False, code="invalid_destination",
            reason="transfer requires a destination number",
        )

    try:
        raw = await api_client.authorise_outbound_destination(
            called_id=dialled,
            caller_id=caller_id,
            agent_options=agent.get("options") or {},
            organisation_id=agent.get("organisationId"),
            user_id=agent.get("userId"),
            aplisay_id=aplisay_id,
            registration_originated=bool(registration_endpoint_id) or registration_originated,
        )
    except Exception as e:  # noqa: BLE001 — fail closed on ANY failure
        logger.bind(destination=dialled, error=str(e)).error(
            "outbound destination authorisation failed; refusing transfer"
        )
        return OutboundDecision(
            allowed=False, code="unavailable",
            reason=f"destination {dialled} could not be authorised",
        )

    decision = OutboundDecision(
        allowed=bool(raw.get("allowed")),
        code=str(raw.get("code") or "unknown"),
        reason=raw.get("reason"),
        chargeable=bool(raw.get("chargeable")),
        trunk_id=raw.get("trunkId"),
        destination=raw.get("destination"),
    )
    if not decision.allowed:
        logger.bind(
            destination=dialled, code=decision.code,
            trunk_id=decision.trunk_id, chargeable=decision.chargeable,
        ).warning("transfer refused: destination not authorised")
    return decision
