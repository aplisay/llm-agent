"""Tests for the human-to-agent transfer helpers (``bridged_transfer.py``).

Covers:

- ``parse_bta_map``: option-shape parsing / lenient rejection.
- ``DtmfSequenceMatcher``: single-digit fire, multi-digit sequences,
  prefix-vs-exact disambiguation via the inter-digit timeout, stray-digit
  sliding, retransmission-safe single fire, and retry after a failed match
  handler.
- ``compose_takeover_prompt``: history carry on/off.
"""

from __future__ import annotations

import asyncio

from pipecat_aplisay.bridged_transfer import (
    BtaContext,
    BtaTarget,
    DtmfSequenceMatcher,
    compose_takeover_prompt,
    parse_bta_map,
)


AGENT_A = "11111111-2222-3333-4444-555555555555"
AGENT_B = "66666666-7777-8888-9999-000000000000"


class TestParseBtaMap:
    def test_absent_or_empty(self):
        assert parse_bta_map(None) is None
        assert parse_bta_map({}) is None
        assert parse_bta_map({"bridgedTransferToAgent": {}}) is None

    def test_string_and_object_forms(self):
        targets = parse_bta_map(
            {
                "bridgedTransferToAgent": {
                    "1": AGENT_A,
                    "*7": {"agent": AGENT_B, "includeHistory": False},
                }
            }
        )
        assert targets["1"].agent_id == AGENT_A
        assert targets["1"].include_history is True
        assert targets["*7"].agent_id == AGENT_B
        assert targets["*7"].include_history is False

    def test_malformed_entries_skipped(self):
        targets = parse_bta_map(
            {
                "bridgedTransferToAgent": {
                    "abc": AGENT_A,          # bad key chars
                    "123456789": AGENT_A,    # too long
                    "2": {},                 # no agent
                    "3": AGENT_B,            # good
                }
            }
        )
        assert list(targets) == ["3"]


class _Collector:
    def __init__(self):
        self.matches: list[str] = []
        self.fail_next = False

    async def on_match(self, key: str) -> None:
        if self.fail_next:
            self.fail_next = False
            raise RuntimeError("simulated takeover failure")
        self.matches.append(key)


def _run(coro):
    return asyncio.run(coro)


class TestDtmfSequenceMatcher:
    def test_single_digit_fires_immediately(self):
        async def run():
            c = _Collector()
            m = DtmfSequenceMatcher(["1", "2"], c.on_match, timeout_s=0.05)
            await m.feed("2")
            return c.matches

        assert _run(run()) == ["2"]

    def test_multi_digit_sequence(self):
        async def run():
            c = _Collector()
            m = DtmfSequenceMatcher(["*7"], c.on_match, timeout_s=0.05)
            await m.feed("*")
            await m.feed("7")
            return c.matches

        assert _run(run()) == ["*7"]

    def test_prefix_key_fires_after_timeout(self):
        async def run():
            c = _Collector()
            # "1" is a key but also a prefix of "12" — a lone press of 1
            # must fire only after the inter-digit timeout.
            m = DtmfSequenceMatcher(["1", "12"], c.on_match, timeout_s=0.05)
            await m.feed("1")
            assert c.matches == []
            await asyncio.sleep(0.15)
            return c.matches

        assert _run(run()) == ["1"]

    def test_longer_key_beats_prefix(self):
        async def run():
            c = _Collector()
            m = DtmfSequenceMatcher(["1", "12"], c.on_match, timeout_s=0.2)
            await m.feed("1")
            await m.feed("2")
            return c.matches

        assert _run(run()) == ["12"]

    def test_stray_digits_slide_out(self):
        async def run():
            c = _Collector()
            m = DtmfSequenceMatcher(["9"], c.on_match, timeout_s=0.05)
            await m.feed("4")
            await m.feed("2")
            await m.feed("9")
            return c.matches

        assert _run(run()) == ["9"]

    def test_fires_once(self):
        async def run():
            c = _Collector()
            m = DtmfSequenceMatcher(["5"], c.on_match, timeout_s=0.05)
            await m.feed("5")
            await m.feed("5")
            return c.matches

        assert _run(run()) == ["5"]

    def test_retry_after_failed_handler(self):
        async def run():
            c = _Collector()
            c.fail_next = True
            m = DtmfSequenceMatcher(["5"], c.on_match, timeout_s=0.05)
            await m.feed("5")  # handler raises; matcher re-arms
            assert c.matches == []
            await m.feed("5")
            return c.matches

        assert _run(run()) == ["5"]

    def test_non_matching_digit_never_fires(self):
        async def run():
            c = _Collector()
            m = DtmfSequenceMatcher(["1"], c.on_match, timeout_s=0.02)
            await m.feed("3")
            await asyncio.sleep(0.1)
            return c.matches

        assert _run(run()) == []


def _ctx(transcript: str = "> caller: hi\n> agent: hello\n") -> BtaContext:
    return BtaContext(
        targets={},
        agent={"id": "a", "options": {}},
        instance={"id": "i"},
        parent_call_id="call-1",
        organisation_id="org-1",
        user_id="user-1",
        instance_id="i",
        caller_id="+441234567890",
        called_id="+441234567891",
        transcript=transcript,
    )


class TestComposeTakeoverPrompt:
    def test_history_carried_by_default(self):
        prompt = compose_takeover_prompt(
            {"prompt": "You are the billing agent."},
            _ctx(),
            BtaTarget(key="1", agent_id=AGENT_A, include_history=True),
        )
        assert "You are the billing agent." in prompt
        assert "> caller: hi" in prompt
        assert "taken over a live call" in prompt

    def test_history_suppressed(self):
        prompt = compose_takeover_prompt(
            {"prompt": "You are the billing agent."},
            _ctx(),
            BtaTarget(key="1", agent_id=AGENT_A, include_history=False),
        )
        assert "> caller: hi" not in prompt
        assert "fresh conversation" in prompt


# ---- aplisay.transfer metadata seeding (docs/transfer-back-plan.md) ----

from pipecat_aplisay.bridged_transfer import (  # noqa: E402
    clip_transcript_for_metadata,
    transfer_metadata_block,
)


class _RenderStub:
    def __init__(self, text: str):
        self._text = text

    def render(self) -> str:
        return self._text


class TestTransferMetadataBlock:
    def test_full_block(self):
        ctx = _ctx()
        ctx.destination = "+447700900123"
        ctx.collector = _RenderStub("> caller: yes\n> transfer target: tuesday\n")
        ctx.consult_transcript = "> agent: can you take a call?\n> user: sure\n"
        block = transfer_metadata_block(
            ctx, BtaTarget(key="1", agent_id=AGENT_A, include_history=True)
        )
        assert block["key"] == "1"
        assert block["targetNumber"] == "+447700900123"
        assert block["parentTranscript"].startswith("> caller: hi")
        assert block["bridgeTranscript"].startswith("> caller: yes")
        assert block["consultTranscript"].startswith("> agent: can you take a call?")

    def test_empty_values_omitted(self):
        ctx = _ctx(transcript="")
        block = transfer_metadata_block(
            ctx, BtaTarget(key="*7", agent_id=AGENT_A, include_history=False)
        )
        # includeHistory does NOT gate metadata seeding — but absent values
        # must be absent keys, never empty strings.
        assert block == {"key": "*7"}

    def test_seeded_even_when_history_suppressed(self):
        ctx = _ctx()
        ctx.collector = _RenderStub("> caller: yes\n")
        block = transfer_metadata_block(
            ctx, BtaTarget(key="1", agent_id=AGENT_A, include_history=False)
        )
        assert "parentTranscript" in block
        assert "bridgeTranscript" in block

    def test_tail_truncation(self):
        long = "".join(f"> caller: line {i}\n" for i in range(5000))
        clipped = clip_transcript_for_metadata(long, limit=1000)
        assert clipped.startswith("(… earlier conversation truncated)")
        assert clipped.endswith("line 4999\n")
        assert len(clipped) <= 1000 + len("(… earlier conversation truncated)\n")

    def test_short_transcript_unclipped(self):
        assert clip_transcript_for_metadata("> caller: hi\n") == "> caller: hi\n"


# ---- Bridged-segment transcription (bridge_transcript.py) ----

from pipecat_aplisay.bridge_transcript import (  # noqa: E402
    CALLER,
    TARGET,
    BridgeTranscriptCollector,
    parse_transcribe_option,
    split_stereo,
)


class TestParseTranscribeOption:
    def test_shapes(self):
        assert parse_transcribe_option(None) is None
        assert parse_transcribe_option({}) is None
        assert parse_transcribe_option({"bridgedTransferTranscribe": False}) is None
        assert parse_transcribe_option({"bridgedTransferTranscribe": True}) == {
            "provider": "elevenlabs",
            "language": None,
        }
        assert parse_transcribe_option(
            {"bridgedTransferTranscribe": {"provider": "deepgram", "language": "en"}}
        ) == {"provider": "deepgram", "language": "en"}
        assert (
            parse_transcribe_option({"bridgedTransferTranscribe": {"enabled": False}})
            is None
        )


class TestSplitStereo:
    def test_deinterleave(self):
        import struct

        # L samples 1,2,3; R samples -1,-2,-3
        stereo = struct.pack("<6h", 1, -1, 2, -2, 3, -3)
        left, right = split_stereo(stereo)
        assert struct.unpack("<3h", left) == (1, 2, 3)
        assert struct.unpack("<3h", right) == (-1, -2, -3)

    def test_odd_lengths(self):
        assert split_stereo(b"") == (b"", b"")
        assert split_stereo(b"\x01\x00") == (b"", b"")


class _FakeCall:
    def __init__(self):
        self.id = "bridged-call-1"
        self.userId = "u"
        self.organisationId = "o"
        self.batched_transaction_logs = []


class TestBridgeTranscriptCollector:
    def test_batched_entries_and_render(self):
        call = _FakeCall()
        collector = BridgeTranscriptCollector(call=call, stream_log=False)

        async def run():
            await collector.add(CALLER, "hello, I need help")
            await collector.add(TARGET, "sure, what's the account number?")
            await collector.add(CALLER, "  ")  # blank — dropped

        asyncio.run(run())
        assert len(collector) == 2
        assert [e["type"] for e in call.batched_transaction_logs] == ["user", "agent"]
        rendered = collector.render()
        assert rendered.index("> caller: hello") < rendered.index(
            "> transfer target: sure"
        )


class TestTakeoverPromptWithBridgeTranscript:
    def test_bridge_section_included(self):
        ctx = _ctx()
        call = _FakeCall()
        collector = BridgeTranscriptCollector(call=call, stream_log=False)
        asyncio.run(collector.add(TARGET, "press one to go back to the bot"))
        ctx.collector = collector
        prompt = compose_takeover_prompt(
            {"prompt": "You are the billing agent."},
            ctx,
            BtaTarget(key="1", agent_id=AGENT_A, include_history=True),
        )
        assert "# Conversation between the caller and the previous agent" in prompt
        assert "# Conversation between the caller and the human transfer target" in prompt
        assert "press one to go back" in prompt
        assert "was not recorded" not in prompt

    def test_fresh_start_omits_bridge_section(self):
        ctx = _ctx()
        call = _FakeCall()
        collector = BridgeTranscriptCollector(call=call, stream_log=False)
        asyncio.run(collector.add(TARGET, "press one"))
        ctx.collector = collector
        prompt = compose_takeover_prompt(
            {"prompt": "You are the billing agent."},
            ctx,
            BtaTarget(key="1", agent_id=AGENT_A, include_history=False),
        )
        assert "transfer target" not in prompt.split("fresh conversation")[1] if "fresh conversation" in prompt else True
        assert "# Conversation" not in prompt
