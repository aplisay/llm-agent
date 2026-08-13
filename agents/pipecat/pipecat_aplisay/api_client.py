"""REST callbacks back into the llm-agent agent-db API.

Section 8 of docs/livekit-agent-architecture.md is authoritative. Endpoints,
header names, and idempotency behaviour mirror the LiveKit worker's
``api-client.ts`` so the same REST server can serve both implementations.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Any, Optional

import httpx
from loguru import logger
from pydantic import BaseModel


class ApiRequestError(Exception):
    def __init__(self, status: int, body: Any, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.body = body or {}
        self.code = self.body.get("code") if isinstance(self.body, dict) else None
        self.scope = self.body.get("scope") if isinstance(self.body, dict) else None
        self.details = self.body.get("details") if isinstance(self.body, dict) else None


class AgentConcurrencyLimitExceededBusyError(Exception):
    code = "AGENT_CONCURRENCY_LIMIT_EXCEEDED"
    status = 429

    def __init__(
        self,
        scope: Optional[str] = None,
        details: Any = None,
        original_error: Optional[str] = None,
    ) -> None:
        scope_suffix = f" [{scope}]" if scope else ""
        original = f" - {original_error}" if original_error else ""
        super().__init__(f"busy: AGENT_CONCURRENCY_LIMIT_EXCEEDED{scope_suffix}{original}")
        self.scope = scope
        self.details = details


def _base_url() -> str:
    base = os.environ.get("SERVICE_BASE_URI")
    if not base:
        raise RuntimeError("SERVICE_BASE_URI environment variable is required")
    return base


def _shared_token() -> Optional[str]:
    return os.environ.get("SHARED_API_TOKEN")


async def _request(
    method: str,
    endpoint: str,
    *,
    params: Optional[dict] = None,
    body: Any = None,
    timeout: float = 30.0,
) -> Any:
    url = f"{_base_url()}{endpoint}"
    headers = {"Content-Type": "application/json"}
    token = _shared_token()
    if token:
        headers["x-shared-token"] = token

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.request(method, url, params=params, json=body, headers=headers)
    except httpx.ConnectError as e:
        # DNS / TCP failure reaching the llm-agent REST server. Most common
        # cause in dev is SERVICE_BASE_URI unset, pointed at an unresolvable
        # placeholder, or set to https:// against a plain-HTTP server (a
        # WRONG_VERSION_NUMBER error surfaces as ConnectError too).
        msg = (
            f"cannot reach llm-agent REST server at {url}: {e}. "
            "Check SERVICE_BASE_URI (scheme + host) on the worker and that "
            "the llm-agent server is running and reachable from this host."
        )
        logger.bind(url=url, method=method, error=str(e)).error(msg)
        raise ApiRequestError(502, {"error": msg}, msg) from e
    except httpx.RequestError as e:
        # Other transport-level failures (timeout, TLS handshake errors, etc).
        msg = f"transport error calling {method} {url}: {e}"
        logger.bind(url=url, method=method, error=str(e)).error(msg)
        raise ApiRequestError(502, {"error": msg}, msg) from e

    if resp.status_code >= 400:
        text = resp.text
        try:
            parsed = resp.json()
        except Exception:  # noqa: BLE001
            parsed = {"raw": text}

        log_fn = (
            logger.info if resp.status_code == 404 else logger.warning if resp.status_code < 500 else logger.error
        )
        log_fn(
            f"API request failed: {method} {url} -> {resp.status_code} {text[:200]}"
        )
        raise ApiRequestError(resp.status_code, parsed, f"API request failed: {resp.status_code}")

    if resp.headers.get("content-type", "").startswith("application/json"):
        return resp.json()
    return resp.text


# ---- Lookup ----


def pop_organisation_keys(doc: Any) -> dict:
    """Remove and return the BYOK provider-key bag from a fetched document.

    The agent-db API delivers the organisation's decrypted provider keys
    per call as a top-level ``organisationKeys`` object — a sibling of
    ``Agent`` on the instance document, and a property of the agent json
    from ``/api/agent-db/agent`` (see docs/byok.md). Callers pop it off
    immediately after the fetch so the instance / agent dicts they store,
    serialise, or log never carry key material. Returns ``{}`` when the
    document has no bag (the server omits it when empty).
    """
    if not isinstance(doc, dict):
        return {}
    bag = doc.pop("organisationKeys", None)
    return bag if isinstance(bag, dict) else {}


async def get_instance_by_id(instance_id: str) -> dict:
    # The returned document may carry a top-level ``organisationKeys`` bag
    # (BYOK); callers that build sessions pop it via pop_organisation_keys.
    return await _request("GET", "/api/agent-db/instance", params={"instanceId": instance_id})


async def get_instance_by_number(number: str) -> dict:
    return await _request("GET", "/api/agent-db/instance", params={"number": number})


async def get_agent_by_id(agent_id: str) -> dict:
    return await _request("GET", f"/api/agents/{agent_id}")


async def get_internal_agent_by_id(
    agent_id: str, expected_organisation_id: Optional[str] = None
) -> dict:
    """Fetch a full agent definition (including keys) via the internal agent-db API.

    Used for in-call ``transfer_agent`` handover. Always pass the calling
    call's organisation id so the server can refuse cross-tenant fetches —
    mirrors ``getInternalAgentById`` in the LiveKit worker's api-client.ts.

    The returned agent json may carry an ``organisationKeys`` property (the
    incoming agent's own BYOK bag) — callers must pop it off with
    :func:`pop_organisation_keys` before storing or embedding the dict.
    """
    params: dict = {"agentId": agent_id}
    if expected_organisation_id:
        params["expectedOrganisationId"] = expected_organisation_id
    return await _request("GET", "/api/agent-db/agent", params=params)


async def invoke_subagent(
    agent_id: str,
    input_args: dict,
    metadata: Optional[dict],
    *,
    organisation_id: str,
    call_id: Optional[str] = None,
) -> Any:
    """Invoke a ``text`` type agent as a subagent via the internal agent-db API.

    Returns the subagent's result payload (the arguments it passed to its
    builtin ``result`` function). The server bounds the invocation with its
    own SUBAGENT_TIMEOUT (default 60s), so the HTTP timeout here is set a
    little above that.
    """
    data = await _request(
        "POST",
        "/api/agent-db/subagent",
        body={
            "agentId": agent_id,
            "input": input_args,
            "metadata": metadata,
            "organisationId": organisation_id,
            "callId": call_id,
        },
        timeout=75.0,
    )
    return (data or {}).get("result") if isinstance(data, dict) else data


async def authorise_outbound_destination(
    *,
    called_id: str,
    caller_id: Optional[str] = None,
    agent_options: Optional[dict] = None,
    organisation_id: Optional[str] = None,
    user_id: Optional[str] = None,
    aplisay_id: Optional[str] = None,
    outbound_trunk_id: Optional[str] = None,
    registration_originated: bool = False,
) -> dict:
    """Authorise one outbound destination against the platform's policy.

    Returns the decision dict (``allowed``, ``code``, ``reason``, ``chargeable``,
    ``trunkId``, ``destination``). Raises on transport/server failure — the caller
    (``outbound_filter.authorise_destination``) treats that as a REFUSAL, since the
    policy it enforces (per-trunk operator filter + destination rating on our own
    carrier trunks) cannot be evaluated here.
    """
    return await _request(
        "POST",
        "/api/agent-db/outbound-authorisation",
        body={
            "calledId": called_id,
            "callerId": caller_id,
            "agentOptions": agent_options or {},
            "organisationId": organisation_id,
            "userId": user_id,
            "aplisayId": aplisay_id,
            "outboundTrunkId": outbound_trunk_id,
            "registrationOriginated": bool(registration_originated),
        },
    )


async def get_phone_number(number: str) -> Optional[dict]:
    """Look up a provisioned PhoneNumber (DDI/trunk number) by E.164 number.

    Returns the row (``number``, ``outbound``, ``aplisayId``, ``instanceId``,
    ...) or ``None`` if not found. Used to resolve the egress trunk + validate
    the caller-ID for a WebRTC-origin transfer — mirrors the PhoneNumber lookup
    in LiveKit's ``transfer-handler.ts`` ``validateAndResolveCallerId``.
    """
    try:
        result = await _request(
            "GET", "/api/agent-db/phone-numbers", params={"number": number}
        )
    except ApiRequestError:
        return None
    # Route returns a bare array of rows.
    if isinstance(result, list):
        return result[0] if result else None
    items = result.get("items") if isinstance(result, dict) else None
    return items[0] if items else None


async def get_phone_endpoint_by_id(endpoint_id: str) -> Optional[dict]:
    try:
        result = await _request("GET", "/api/agent-db/phone-endpoints", params={"id": endpoint_id})
    except ApiRequestError:
        return None
    items = result.get("items") if isinstance(result, dict) else None
    return items[0] if items else None


async def get_phone_endpoint_by_number(
    number: str, trunk_id: Optional[str] = None
) -> Optional[dict]:
    params: dict = {"number": number}
    if trunk_id:
        params["trunkId"] = trunk_id
    try:
        result = await _request("GET", "/api/agent-db/phone-endpoints", params=params)
    except ApiRequestError as e:
        if "Trunk mismatch" in str(e):
            raise
        return None
    items = result.get("items") if isinstance(result, dict) else None
    return items[0] if items else None


async def set_phone_endpoint_provisioned(number: str, provisioned: bool) -> None:
    try:
        await _request(
            "PATCH",
            f"/api/agent-db/phone-endpoints/{number}",
            body={"provisioned": provisioned},
        )
    except ApiRequestError as e:
        logger.error(f"failed to update phone provisioning state: {e}")


# ---- Call lifecycle ----


class CallRecord(BaseModel):
    id: str
    userId: str
    organisationId: str
    instanceId: str
    agentId: str
    metadata: dict = {}
    options: dict = {}

    # Set False for browser / WebRTC sessions where the worker fabricates a
    # stub Call locally instead of POSTing /api/agent-db/call. end_call() is a
    # no-op for non-persisted records.
    persisted: bool = True

    # Internal — accumulates batched logs when streamLog is False; flushed at end.
    batched_transaction_logs: list = []
    end_called: bool = False


async def create_call(call_data: dict) -> CallRecord:
    raw = await _request("POST", "/api/agent-db/call", body=call_data)
    record = CallRecord(
        id=raw["id"],
        userId=raw["userId"],
        organisationId=raw["organisationId"],
        instanceId=raw["instanceId"],
        agentId=raw["agentId"],
        metadata=raw.get("metadata") or {},
        options=raw.get("options") or {},
    )
    return record


async def start_call(call: CallRecord) -> None:
    try:
        await _request(
            "POST",
            f"/api/agent-db/call/{call.id}/start",
            body={"userId": call.userId, "organisationId": call.organisationId},
        )
    except ApiRequestError as err:
        if err.status == 429 and err.code == "AGENT_CONCURRENCY_LIMIT_EXCEEDED":
            raise AgentConcurrencyLimitExceededBusyError(
                scope=err.scope,
                details=err.details,
                original_error=(err.body or {}).get("error") if isinstance(err.body, dict) else None,
            )
        raise


async def end_call(call: CallRecord, reason: Optional[str] = None) -> None:
    if call.end_called:
        return
    call.end_called = True
    # Non-persisted stub records (browser sessions) were never POSTed to the
    # server; there's nothing for /call/:id/end to find. Calling it would 404.
    if not call.persisted:
        logger.debug(f"end_call: skipping non-persisted call {call.id}")
        return
    body: dict = {
        "reason": reason,
        "userId": call.userId,
        "organisationId": call.organisationId,
    }
    if call.batched_transaction_logs:
        body["transactionLogs"] = [
            _serialise_log(entry) for entry in call.batched_transaction_logs
        ]
    try:
        await _request("POST", f"/api/agent-db/call/{call.id}/end", body=body)
    except ApiRequestError as e:
        logger.error(f"call.end failed: {e}")
        raise


async def end_call_by_id(call_id: str, reason: Optional[str] = None) -> None:
    await _request("POST", f"/api/agent-db/call/{call_id}/end", body={"reason": reason})


# ---- Logging ----


def _serialise_log(entry: dict) -> dict:
    out = dict(entry)
    created = out.get("createdAt")
    if isinstance(created, datetime):
        out["createdAt"] = created.astimezone(timezone.utc).isoformat()
    return out


async def create_transaction_log(entry: dict) -> None:
    if entry.get("type") == "status":
        return
    body = _serialise_log(entry)
    await _request("POST", "/api/agent-db/transaction-log", body=body)


async def save_invocation_log(payload: dict) -> None:
    await _request("POST", "/api/agent-db/invocation-log", body=payload)


async def save_usage(records: Any) -> None:
    """Post one or more usage meters (LLM tokens, TTS characters, STT audio, …)
    to the platform usage ledger. Accepts a single record dict or a list."""
    body = {"records": records} if isinstance(records, list) else records
    await _request("POST", "/api/agent-db/usage", body=body)


# ---- Recording metadata ----


async def set_call_recording_data(
    call_id: str, recording_id: str, encryption_key: Optional[str] = None
) -> None:
    body: dict = {"recordingId": recording_id}
    if encryption_key:
        body["encryptionKey"] = encryption_key
    await _request("PUT", f"/api/agent-db/call/{call_id}/recording", body=body)
