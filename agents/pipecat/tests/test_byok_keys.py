"""BYOK (Bring Your Own Key) — the per-call ``organisationKeys`` bag
(docs/byok.md).

Covers the worker-side contract:

- ``_resolve_provider_key`` precedence: an organisation key wins over the
  worker env; a present-but-null/empty entry fails CLOSED (``ByokKeyError``,
  never the platform env key); an absent slug falls through to the existing
  ``_require_env`` behaviour; and neither anywhere raises the usual missing
  key error.
- Model-id provider-segment → canonical slug mapping.
- The pipeline STT/TTS construction sites consume the bag (and only the
  BYOK-registered vendors do — Google STT is service-account auth).
- The bag never rides inside agent dicts: ``build_transfer_agent_dict``
  and ``prepare_takeover`` carry it out-of-band, and ``CallSession``
  strips it off fetched instance/agent documents at construction.
"""

from __future__ import annotations

import asyncio

import pytest

from pipecat_aplisay import api_client
from pipecat_aplisay.voice_session import (
    ByokKeyError,
    _model_provider_slug,
    _resolve_provider_key,
    build_stt_service,
    build_tts_service,
)

ORG_KEY = "org-supplied-key"
ENV_KEY = "platform-env-key"


@pytest.fixture
def no_provider_env(monkeypatch):
    """Guarantee the platform env keys are ABSENT, so a successful service
    construction proves the org key was used."""
    for name in (
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GEMINI_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENAI_API_KEY",
        "ULTRAVOX_API_KEY",
        "DEEPGRAM_API_KEY",
        "CARTESIA_API_KEY",
        "ELEVENLABS_API_KEY",
        "ELEVEN_API_KEY",
    ):
        monkeypatch.delenv(name, raising=False)


class TestResolveProviderKey:
    def test_org_key_wins_over_env(self, monkeypatch):
        monkeypatch.setenv("OPENAI_API_KEY", ENV_KEY)
        assert (
            _resolve_provider_key({"openai": ORG_KEY}, "openai", "OPENAI_API_KEY")
            == ORG_KEY
        )

    def test_null_org_entry_fails_closed_even_with_env(self, monkeypatch):
        # A stored key that failed to decrypt arrives as null. The platform
        # env key must NOT be silently substituted (docs/byok.md principle 3).
        monkeypatch.setenv("OPENAI_API_KEY", ENV_KEY)
        with pytest.raises(ByokKeyError):
            _resolve_provider_key({"openai": None}, "openai", "OPENAI_API_KEY")

    def test_empty_org_entry_fails_closed(self, monkeypatch):
        monkeypatch.setenv("DEEPGRAM_API_KEY", ENV_KEY)
        with pytest.raises(ByokKeyError):
            _resolve_provider_key({"deepgram": "  "}, "deepgram", "DEEPGRAM_API_KEY")

    def test_absent_slug_falls_through_to_env(self, monkeypatch):
        monkeypatch.setenv("CARTESIA_API_KEY", ENV_KEY)
        # A bag for OTHER providers leaves this one on platform behaviour.
        assert (
            _resolve_provider_key({"openai": ORG_KEY}, "cartesia", "CARTESIA_API_KEY")
            == ENV_KEY
        )
        assert _resolve_provider_key(None, "cartesia", "CARTESIA_API_KEY") == ENV_KEY
        assert _resolve_provider_key({}, "cartesia", "CARTESIA_API_KEY") == ENV_KEY

    def test_env_aliases_still_honoured(self, monkeypatch, no_provider_env):
        monkeypatch.setenv("ELEVEN_API_KEY", ENV_KEY)
        assert (
            _resolve_provider_key(
                {}, "elevenlabs", "ELEVENLABS_API_KEY", "ELEVEN_API_KEY"
            )
            == ENV_KEY
        )

    def test_missing_both_raises_the_env_error(self, no_provider_env):
        with pytest.raises(KeyError):
            _resolve_provider_key({}, "openai", "OPENAI_API_KEY")

    def test_byok_error_message_is_tenant_safe(self, monkeypatch):
        # The message reaches tenants via /webrtc/offer error details: it must
        # name neither key material nor the platform env var names.
        monkeypatch.setenv("OPENAI_API_KEY", ENV_KEY)
        with pytest.raises(ByokKeyError) as exc:
            _resolve_provider_key({"openai": ""}, "openai", "OPENAI_API_KEY")
        message = str(exc.value)
        assert "OPENAI_API_KEY" not in message
        assert ENV_KEY not in message
        assert "openai" in message


class TestModelProviderSlug:
    @pytest.mark.parametrize(
        "model_id,slug",
        [
            ("openai/gpt-4o", "openai"),
            ("anthropic/claude-sonnet-4-5", "anthropic"),
            ("google/gemini-2.0-flash-live-001", "google"),
            ("gemini/gemini-2.0-flash", "google"),
            ("ultravox/ultravox-v0.7", "ultravox"),
            ("fixie-ai/ultravox-v0.6", "ultravox"),
            ("OpenAI/gpt-4o", "openai"),
        ],
    )
    def test_known_segments(self, model_id, slug):
        assert _model_provider_slug(model_id) == slug

    def test_unknown_segment_is_none(self):
        assert _model_provider_slug("acme/whatever") is None


class TestServiceConstructionSites:
    def test_deepgram_stt_uses_org_key(self, no_provider_env):
        # No DEEPGRAM_API_KEY in the environment: construction can only
        # succeed if the org key was used.
        service = build_stt_service(
            {"options": {"stt": {"vendor": "deepgram"}}},
            org_keys={"deepgram": ORG_KEY},
        )
        assert service is not None

    def test_deepgram_stt_fails_closed_on_null_org_key(self, monkeypatch):
        monkeypatch.setenv("DEEPGRAM_API_KEY", ENV_KEY)
        with pytest.raises(ByokKeyError):
            build_stt_service(
                {"options": {"stt": {"vendor": "deepgram"}}},
                org_keys={"deepgram": None},
            )

    @pytest.mark.parametrize(
        "vendor,slug",
        [
            ("cartesia", "cartesia"),
            ("elevenlabs", "elevenlabs"),
            ("deepgram", "deepgram"),
        ],
    )
    def test_tts_vendors_use_org_key(self, no_provider_env, vendor, slug):
        service = build_tts_service(
            {"options": {"tts": {"vendor": vendor}}},
            org_keys={slug: ORG_KEY},
        )
        assert service is not None

    @pytest.mark.parametrize(
        "vendor,slug",
        [
            ("cartesia", "cartesia"),
            ("elevenlabs", "elevenlabs"),
            ("deepgram", "deepgram"),
        ],
    )
    def test_tts_vendors_fail_closed_on_null_org_key(
        self, monkeypatch, vendor, slug
    ):
        monkeypatch.setenv("CARTESIA_API_KEY", ENV_KEY)
        monkeypatch.setenv("ELEVENLABS_API_KEY", ENV_KEY)
        monkeypatch.setenv("DEEPGRAM_API_KEY", ENV_KEY)
        with pytest.raises(ByokKeyError):
            build_tts_service(
                {"options": {"tts": {"vendor": vendor}}},
                org_keys={slug: None},
            )

    def test_backward_compatible_signatures(self, monkeypatch):
        # bridged_transfer.py historically calls these with the agent alone;
        # org_keys must stay optional.
        monkeypatch.setenv("DEEPGRAM_API_KEY", ENV_KEY)
        assert build_stt_service({"options": {"stt": {"vendor": "deepgram"}}}) is not None


class TestPopOrganisationKeys:
    def test_pops_and_returns_bag(self):
        doc = {"id": "i1", "Agent": {"id": "a1"}, "organisationKeys": {"openai": ORG_KEY}}
        assert api_client.pop_organisation_keys(doc) == {"openai": ORG_KEY}
        assert "organisationKeys" not in doc

    def test_absent_or_malformed_is_empty(self):
        assert api_client.pop_organisation_keys({"id": "i1"}) == {}
        assert api_client.pop_organisation_keys(None) == {}
        assert api_client.pop_organisation_keys({"organisationKeys": "junk"}) == {}


def _call_record() -> api_client.CallRecord:
    return api_client.CallRecord(
        id="call-1",
        userId="user-1",
        organisationId="org-1",
        instanceId="inst-1",
        agentId="agent-1",
        persisted=False,
    )


class _StubGatewaySession:
    transport = None

    async def shutdown(self) -> None:  # pragma: no cover
        return None


def _session(agent: dict, instance: dict, **kwargs):
    from pipecat_aplisay.call_session import CallSession

    return CallSession(
        session_id="s1",
        agent=agent,
        instance=instance,
        sip_gateway=None,  # type: ignore[arg-type]
        gateway_session=_StubGatewaySession(),  # type: ignore[arg-type]
        call=_call_record(),
        **kwargs,
    )


class TestCallSessionStripsBag:
    def test_bag_popped_off_instance_document(self):
        instance = {
            "id": "inst-1",
            "streamLog": False,
            "Agent": {"id": "agent-1"},
            "organisationKeys": {"openai": ORG_KEY},
        }
        session = _session(
            {"id": "agent-1", "modelName": "pipecat:openai/gpt-4o"}, instance
        )
        assert session.organisation_keys == {"openai": ORG_KEY}
        assert "organisationKeys" not in instance
        assert "organisationKeys" not in session.instance

    def test_bag_popped_off_agent_dict(self):
        agent = {
            "id": "agent-1",
            "modelName": "pipecat:openai/gpt-4o",
            "organisationKeys": {"deepgram": ORG_KEY},
        }
        session = _session(agent, {"streamLog": False})
        assert session.organisation_keys == {"deepgram": ORG_KEY}
        assert "organisationKeys" not in session.agent

    def test_explicitly_passed_bag_wins_and_docs_still_stripped(self):
        # Consult/takeover constructors pop the bag themselves and pass it in;
        # a (stale) bag on the docs is stripped but not adopted.
        instance = {"streamLog": False, "organisationKeys": {"openai": "stale"}}
        session = _session(
            {"id": "agent-1", "modelName": "pipecat:openai/gpt-4o"},
            instance,
            organisation_keys={"openai": ORG_KEY},
        )
        assert session.organisation_keys == {"openai": ORG_KEY}
        assert "organisationKeys" not in instance


class TestTransferAgentDictNeverCarriesBag:
    def test_build_transfer_agent_dict_excludes_organisation_keys(self):
        from pipecat_aplisay.call_session import build_transfer_agent_dict

        parent_agent = {
            "id": "agent-1",
            "userId": "user-1",
            "organisationId": "org-1",
            "modelName": "pipecat:openai/gpt-4o",
            "options": {"tts": {"voice": "x"}},
            # Should never be here in practice (CallSession strips it), but
            # even a poisoned parent dict must not leak into the consult leg.
            "organisationKeys": {"openai": ORG_KEY},
        }
        transfer_agent = build_transfer_agent_dict(
            parent_agent=parent_agent,
            transfer_agent_prompt="You are consulting.",
        )
        assert "organisationKeys" not in transfer_agent
        assert ORG_KEY not in str(transfer_agent)

    def test_prepare_takeover_carries_bag_outside_agent_dict(self, monkeypatch):
        from pipecat_aplisay.bridged_transfer import (
            BtaContext,
            BtaTarget,
            prepare_takeover,
        )

        async def fake_fetch(agent_id: str, expected_organisation_id=None) -> dict:
            return {
                "id": agent_id,
                "type": "interactive-audio",
                "modelName": "pipecat:openai/gpt-4o",
                "prompt": "You take over.",
                "options": {},
                "organisationKeys": {"openai": ORG_KEY},
            }

        async def fake_create_call(call_data: dict) -> api_client.CallRecord:
            # The reserved continuation call must not embed key material.
            assert ORG_KEY not in str(call_data)
            return _call_record()

        async def fake_start_call(call) -> None:
            return None

        monkeypatch.setattr(api_client, "get_internal_agent_by_id", fake_fetch)
        monkeypatch.setattr(api_client, "create_call", fake_create_call)
        monkeypatch.setattr(api_client, "start_call", fake_start_call)

        ctx = BtaContext(
            targets={"1": BtaTarget(key="1", agent_id="target-agent")},
            agent={"id": "agent-1", "options": {}},
            instance={"id": "inst-1"},
            parent_call_id="call-0",
            organisation_id="org-1",
            user_id="user-1",
            instance_id="inst-1",
            caller_id="+441234",
            called_id="+445678",
            transcript="",
        )
        payload = asyncio.run(
            prepare_takeover(
                ctx, ctx.targets["1"], platform="pipecat", session_id="sb-bta-1"
            )
        )
        assert payload.organisation_keys == {"openai": ORG_KEY}
        assert "organisationKeys" not in payload.agent
