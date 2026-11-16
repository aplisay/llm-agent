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


# --- the last final at teardown -------------------------------------------------

from pipecat_aplisay.bridge_transcript import SttStream  # noqa: E402
from pipecat_aplisay.stt_formatting import side_drain_secs  # noqa: E402


def test_side_drain_secs_only_for_a_long_pause():
    assert side_drain_secs({"formatted": True}, long_pause=True) == 2.0
    assert side_drain_secs({"formatted": True}, long_pause=False) == 0.0
    assert side_drain_secs({}, long_pause=True) == 0.0
    assert side_drain_secs({"endpointing": 800}, long_pause=True) == 0.0
    assert side_drain_secs({"endpointing": 2000}, long_pause=False) == 2.0


class _QueueRecorder:
    def __init__(self, on_queue=None):
        self.queued: list = []
        self._on_queue = on_queue

    async def queue_frames(self, frames):
        self.queued.extend(frames)
        if self._on_queue:
            self._on_queue()


def test_drain_asks_for_the_held_words_and_waits_for_the_final():
    from pipecat.frames.frames import VADUserStoppedSpeakingFrame

    async def run():
        stream = SttStream("stt", lambda _t: asyncio.sleep(0))
        stream._collector.pending = True
        stream._task = _QueueRecorder(on_queue=stream._collector.final_seen.set)
        started = asyncio.get_running_loop().time()
        await stream.drain(2.0)
        assert [type(f) for f in stream._task.queued] == [VADUserStoppedSpeakingFrame]
        assert asyncio.get_running_loop().time() - started < 0.5

    asyncio.run(run())


def test_drain_does_nothing_without_pending_speech_and_gives_up_at_the_timeout():
    async def run():
        idle = SttStream("stt", lambda _t: asyncio.sleep(0))
        idle._task = _QueueRecorder()
        await idle.drain(2.0)
        assert idle._task.queued == []

        held = SttStream("stt", lambda _t: asyncio.sleep(0))
        held._collector.pending = True
        held._task = _QueueRecorder()  # no final ever arrives
        started = asyncio.get_running_loop().time()
        await held.drain(0.2)
        assert 0.15 < asyncio.get_running_loop().time() - started < 1.0

    asyncio.run(run())


def test_the_tap_drains_before_it_stops():
    from pipecat.frames.frames import InputAudioRawFrame
    from pipecat.tests.utils import run_test

    from pipecat_aplisay.aux_stt import AuxSttTap

    calls: list = []

    class _Stream:
        def __init__(self, *_a, **_k):
            pass

        async def start(self):
            pass

        async def feed(self, _pcm):
            pass

        async def drain(self, timeout):
            calls.append(("drain", timeout))

        async def stop(self):
            calls.append(("stop",))

    async def run():
        tap = AuxSttTap(
            stt_factory=lambda: "stt",
            on_final=lambda _t: asyncio.sleep(0),
            stream_factory=_Stream,
            drain_secs=2.0,
        )
        frame = InputAudioRawFrame(audio=b"\x00\x00" * 160, sample_rate=8000, num_channels=1)
        await run_test(tap, frames_to_send=[frame], expected_down_frames=[InputAudioRawFrame])
        await asyncio.sleep(0.05)
        assert calls == [("drain", 2.0), ("stop",)]

    asyncio.run(run())
