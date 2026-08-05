"""Tests for the pre-fired hand-back summariser (``summaryAgent``) and the
``transfer_summary`` builtin (docs/transfer-back-plan.md WP1.4)."""

from __future__ import annotations

import asyncio

from pipecat_aplisay import api_client
from pipecat_aplisay.bridged_transfer import (
    BtaContext,
    BtaTarget,
    parse_bta_map,
    prefire_summary,
    prepare_takeover,
)
from pipecat_aplisay.call_session import CallSession

AGENT_A = "11111111-2222-3333-4444-555555555555"
SUMMARISER = "99999999-8888-7777-6666-555555555555"


class _StubCall:
    id = "call-takeover-1"
    organisationId = "org-1"
    userId = "user-1"
    instanceId = "inst-1"


def _ctx() -> BtaContext:
    return BtaContext(
        targets={},
        agent={"id": "a", "options": {}},
        instance={"id": "inst-1"},
        parent_call_id="call-parent",
        organisation_id="org-1",
        user_id="user-1",
        instance_id="inst-1",
        caller_id="+441234567890",
        called_id="+441234567891",
        transcript="> caller: hi\n> agent: hello\n",
        destination="+447700900123",
    )


class TestParseSummaryAgent:
    def test_summary_agent_parsed(self):
        targets = parse_bta_map(
            {
                "bridgedTransferToAgent": {
                    "1": {"agent": AGENT_A, "summaryAgent": SUMMARISER},
                    "2": AGENT_A,
                }
            }
        )
        assert targets["1"].summary_agent_id == SUMMARISER
        assert targets["2"].summary_agent_id is None


class TestPrefireSummary:
    def test_resolves_ready(self, monkeypatch):
        async def run():
            captured = {}

            async def fake_invoke(target, input_args, metadata, *, organisation_id, call_id):
                captured.update(
                    target=target, input_args=input_args, metadata=metadata,
                    organisation_id=organisation_id, call_id=call_id,
                )
                return {"summary": "Tuesday valve swap agreed."}

            monkeypatch.setattr(api_client, "invoke_subagent", fake_invoke)
            target = BtaTarget(key="1", agent_id=AGENT_A, summary_agent_id=SUMMARISER)
            block = {
                "parentTranscript": "> caller: hi\n",
                "bridgeTranscript": "> transfer target: tuesday\n",
                "key": "1",
                "targetNumber": "+447700900123",
            }
            fut = prefire_summary(target, block, {"aplisay": {}}, _StubCall())
            result = await asyncio.wait_for(fut, 2)
            assert result == {"status": "ready", "summary": "Tuesday valve swap agreed."}
            # Same contract as the playbook summarise_call function: transcript
            # params only, billed against the takeover call.
            assert captured["target"] == SUMMARISER
            assert set(captured["input_args"]) == {"parentTranscript", "bridgeTranscript"}
            assert captured["call_id"] == "call-takeover-1"
            assert captured["organisation_id"] == "org-1"

        asyncio.run(run())

    def test_failure_resolves_failed_not_raises(self, monkeypatch):
        async def run():
            async def fake_invoke(*_a, **_k):
                raise RuntimeError("summariser exploded")

            monkeypatch.setattr(api_client, "invoke_subagent", fake_invoke)
            target = BtaTarget(key="1", agent_id=AGENT_A, summary_agent_id=SUMMARISER)
            fut = prefire_summary(target, {}, {}, _StubCall())
            result = await asyncio.wait_for(fut, 2)
            assert result["status"] == "failed"
            assert "summariser exploded" in result["error"]

        asyncio.run(run())


def _session(pending=None) -> CallSession:
    return CallSession(
        session_id="sb-bta-test",
        agent={"options": {}},
        instance={},
        sip_gateway=None,
        gateway_session=None,
        call=None,
        _pending_summary=pending,
    )


class TestTransferSummaryBuiltin:
    def test_none_when_not_configured(self):
        result = asyncio.run(_session()._on_transfer_summary({}))
        assert result["status"] == "none"

    def test_ready(self):
        async def run():
            fut = asyncio.get_running_loop().create_future()
            fut.set_result({"status": "ready", "summary": "done"})
            return await _session(fut)._on_transfer_summary({})

        assert asyncio.run(run()) == {"status": "ready", "summary": "done"}

    def test_pending_timeout_does_not_cancel(self):
        async def run():
            fut = asyncio.get_running_loop().create_future()
            session = _session(fut)
            first = await session._on_transfer_summary({"timeoutMs": 10})
            assert first["status"] == "pending"
            assert not fut.cancelled()
            fut.set_result({"status": "ready", "summary": "late"})
            second = await session._on_transfer_summary({"timeoutMs": 10})
            return second

        assert asyncio.run(run()) == {"status": "ready", "summary": "late"}


class TestPrepareTakeoverPrefire:
    def test_prefire_wired_through_payload(self, monkeypatch):
        async def run():
            async def fake_get_agent(agent_id, expected_organisation_id=None):
                return {
                    "id": agent_id,
                    "type": "interactive-audio",
                    "modelName": "pipecat:openai/gpt-4o",
                    "prompt": "You book follow-ups.",
                    "options": {},
                }

            created = {}

            async def fake_create_call(body):
                created.update(body)
                return _StubCall()

            async def fake_start_call(_call):
                return None

            async def fake_invoke(target, input_args, metadata, **_kw):
                return {"summary": "ok"}

            monkeypatch.setattr(api_client, "get_internal_agent_by_id", fake_get_agent)
            monkeypatch.setattr(api_client, "create_call", fake_create_call)
            monkeypatch.setattr(api_client, "start_call", fake_start_call)
            monkeypatch.setattr(api_client, "invoke_subagent", fake_invoke)

            target = BtaTarget(key="1", agent_id=AGENT_A, summary_agent_id=SUMMARISER)
            payload = await prepare_takeover(
                _ctx(), target, platform="pipecat", session_id="sb-bta-x"
            )
            assert payload.summary_future is not None
            result = await asyncio.wait_for(payload.summary_future, 2)
            assert result == {"status": "ready", "summary": "ok"}
            # aplisay.transfer seeding present on the takeover call metadata
            transfer = created["metadata"]["aplisay"]["transfer"]
            assert transfer["key"] == "1"
            assert transfer["targetNumber"] == "+447700900123"
            assert transfer["parentTranscript"].startswith("> caller: hi")

        asyncio.run(run())

    def test_no_summary_agent_no_prefire(self, monkeypatch):
        async def run():
            async def fake_get_agent(agent_id, expected_organisation_id=None):
                return {
                    "id": agent_id,
                    "type": "interactive-audio",
                    "modelName": "pipecat:openai/gpt-4o",
                    "prompt": "x",
                    "options": {},
                }

            async def fake_create_call(_body):
                return _StubCall()

            async def fake_start_call(_call):
                return None

            def boom(*_a, **_k):
                raise AssertionError("invoke_subagent must not be called")

            monkeypatch.setattr(api_client, "get_internal_agent_by_id", fake_get_agent)
            monkeypatch.setattr(api_client, "create_call", fake_create_call)
            monkeypatch.setattr(api_client, "start_call", fake_start_call)
            monkeypatch.setattr(api_client, "invoke_subagent", boom)

            payload = await prepare_takeover(
                _ctx(),
                BtaTarget(key="1", agent_id=AGENT_A),
                platform="pipecat",
                session_id="sb-bta-y",
            )
            assert payload.summary_future is None

        asyncio.run(run())
