"""``formatted`` and the Deepgram options on the Pipecat worker: the mapping,
what the Deepgram service sends, and how the side blocks carry the fields.
See docs/stt-formatting.md. Mirrors agents/livekit/test/stt-formatting.test.ts."""

import asyncio
import urllib.parse
from contextlib import asynccontextmanager

import pytest

from pipecat_aplisay.aux_stt import aux_stt_agent, output_stt_agent, parse_aux_stt_option, parse_output_stt_option
from pipecat_aplisay.stt_formatting import deepgram_formatting, pick_stt_formatting
from pipecat_aplisay.voice_session import build_stt_service


@pytest.fixture
def deepgram_key(monkeypatch):
    monkeypatch.setenv("DEEPGRAM_API_KEY", "test-key")


def _agent(stt: dict) -> dict:
    return {"options": {"stt": stt}}


def test_formatted_bundle_has_no_numerals():
    assert deepgram_formatting({"formatted": True}, long_pause=False) == {
        "smart_format": True,
        "punctuate": True,
        "no_delay": True,
    }


def test_the_caller_side_aux_engine_waits_1500_ms_for_a_pause():
    assert deepgram_formatting({"formatted": True}, long_pause=True)["endpointing"] == 1500


def test_unset_or_false_sends_nothing():
    assert deepgram_formatting({}, long_pause=True) == {}
    assert deepgram_formatting({"formatted": False}, long_pause=True) == {}
    assert deepgram_formatting(None, long_pause=False) == {}


def test_block_options_win_over_the_bundle():
    assert deepgram_formatting(
        {"formatted": True, "smart_format": False, "endpointing": False, "numerals": True}, long_pause=True
    ) == {"smart_format": False, "punctuate": True, "no_delay": True, "endpointing": False, "numerals": True}


def test_wrong_types_are_dropped():
    # bool is an int subclass, so endpointing=True must not pass as a number.
    assert pick_stt_formatting({"formatted": "yes", "endpointing": True, "numerals": False}) == {"numerals": False}
    assert pick_stt_formatting({"endpointing": -1}) == {}


def test_unset_keeps_the_service_defaults(deepgram_key):
    kwargs = build_stt_service(_agent({}))._build_connect_kwargs()
    assert kwargs["smart_format"] == "false"
    assert kwargs["punctuate"] == "true"
    assert "endpointing" not in kwargs
    assert "request_options" not in kwargs


def test_formatted_primary(deepgram_key):
    kwargs = build_stt_service(_agent({"formatted": True, "language": "en-GB"}))._build_connect_kwargs()
    assert kwargs["smart_format"] == "true"
    assert kwargs["punctuate"] == "true"
    assert kwargs["numerals"] == "false"
    assert kwargs["language"] == "en-GB"
    assert "endpointing" not in kwargs
    assert kwargs["request_options"] == {"additional_query_parameters": {"no_delay": "true"}}


def test_formatted_aux_engine(deepgram_key):
    kwargs = build_stt_service(_agent({"formatted": True}), long_pause=True)._build_connect_kwargs()
    assert kwargs["endpointing"] == "1500"
    assert kwargs["request_options"]["additional_query_parameters"]["no_delay"] == "true"


def test_endpointing_false_is_sent(deepgram_key):
    kwargs = build_stt_service(_agent({"endpointing": False}))._build_connect_kwargs()
    assert kwargs["endpointing"] == "false"


def test_the_sdk_puts_no_delay_on_the_url(deepgram_key, monkeypatch):
    """The SDK's connect() has no no_delay argument; it must still reach the URL."""
    import deepgram.listen.v1.client as sdk_client
    import deepgram.listen.v1.raw_client as raw_client

    seen: dict = {}

    class _Stop(Exception):
        pass

    @asynccontextmanager
    async def fake_connect(url, **_):
        seen["url"] = url
        raise _Stop()
        yield  # pragma: no cover

    # The SDK has opened the socket from either module across versions; patch both so no test reaches the network.
    monkeypatch.setattr(sdk_client, "websockets_client_connect", fake_connect, raising=False)
    monkeypatch.setattr(raw_client, "websockets_client_connect", fake_connect, raising=False)
    service = build_stt_service(_agent({"formatted": True}), long_pause=True)

    async def connect_once():
        with pytest.raises(_Stop):
            async with service._client.listen.v1.connect(**service._build_connect_kwargs()):
                pass  # pragma: no cover

    asyncio.run(connect_once())
    query = urllib.parse.parse_qs(urllib.parse.urlparse(seen["url"]).query)
    assert query["no_delay"] == ["true"]
    assert query["smart_format"] == ["true"]
    assert query["endpointing"] == ["1500"]


def test_side_blocks_carry_the_fields_and_do_not_inherit_them():
    options = {
        "stt": {"formatted": True, "endpointing": 300, "aux": {"vendor": "deepgram", "formatted": True}},
        "tts": {"output": {"no_delay": False}},
    }
    aux = parse_aux_stt_option(options)
    assert aux == {"vendor": "deepgram", "language": None, "formatted": True}
    output = parse_output_stt_option(options)
    assert output == {"vendor": None, "language": None, "no_delay": False}
    agent = {"options": options}
    assert aux_stt_agent(agent, aux)["options"]["stt"] == {"vendor": "deepgram", "formatted": True}
    assert output_stt_agent(agent, output)["options"]["stt"] == {"no_delay": False}
