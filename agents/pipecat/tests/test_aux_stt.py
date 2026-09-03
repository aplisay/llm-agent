"""Auxiliary ("second opinion") STT — ``options.stt.aux`` (aux_stt.py).

Option parsing, the agent/vendor stand-in, and the tap's behaviour driven
through a real Pipecat pipeline (``pipecat.tests.utils.run_test``) with the
side STT pipeline replaced by a fake: frames pass through untouched, audio is
copied out and metered, finals are forwarded and counted, End/Cancel stop the
side pipeline, and an engine failure is contained.
"""

from __future__ import annotations

import asyncio

from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    InputAudioRawFrame,
    TextFrame,
)
from pipecat.tests.utils import run_test

from pipecat_aplisay.aux_stt import (
    AUX_STT_LOG_TYPE,
    AUX_STT_TECHNOLOGY,
    AuxSttTap,
    aux_stt_agent,
    aux_stt_vendor,
    parse_aux_stt_option,
)


def test_constants_match_platform_contract():
    assert AUX_STT_LOG_TYPE == "user-aux"
    assert AUX_STT_TECHNOLOGY == "stt-aux"


class TestParseAuxSttOption:
    def test_off_shapes(self):
        assert parse_aux_stt_option(None) is None
        assert parse_aux_stt_option({}) is None
        assert parse_aux_stt_option({"stt": {}}) is None
        assert parse_aux_stt_option({"stt": {"aux": False}}) is None
        assert parse_aux_stt_option({"stt": {"aux": None}}) is None
        assert parse_aux_stt_option({"stt": {"aux": {"enabled": False, "vendor": "google"}}}) is None
        # Malformed shapes are off, not errors (the server validates at save time).
        assert parse_aux_stt_option({"stt": {"aux": "yes"}}) is None
        assert parse_aux_stt_option({"stt": {"aux": ["google"]}}) is None
        assert parse_aux_stt_option({"stt": "deepgram"}) is None

    def test_on_shapes_normalise(self):
        assert parse_aux_stt_option({"stt": {"aux": True}}) == {"vendor": None, "language": None}
        assert parse_aux_stt_option({"stt": {"aux": {}}}) == {"vendor": None, "language": None}
        assert parse_aux_stt_option({"stt": {"aux": {"enabled": True}}}) == {
            "vendor": None,
            "language": None,
        }
        assert parse_aux_stt_option(
            {"stt": {"aux": {"vendor": " google ", "language": "en-GB"}}}
        ) == {"vendor": "google", "language": "en-GB"}
        # Blank strings are "unset".
        assert parse_aux_stt_option({"stt": {"aux": {"vendor": "  ", "language": ""}}}) == {
            "vendor": None,
            "language": None,
        }


class TestAuxSttAgent:
    AGENT = {
        "id": "a",
        "options": {
            "stt": {"vendor": "deepgram", "language": "en-US", "aux": {"vendor": "google"}},
            "tts": {"vendor": "cartesia", "language": "fr-FR", "voice": "v"},
        },
    }

    def test_aux_block_stands_in_for_stt_and_inherits_language(self):
        a = aux_stt_agent(self.AGENT, {"vendor": "google", "language": None})
        assert a["options"]["stt"] == {"vendor": "google", "language": "en-US"}
        assert a["options"]["tts"] == self.AGENT["options"]["tts"]
        # Input untouched.
        assert self.AGENT["options"]["stt"]["aux"] == {"vendor": "google"}

    def test_language_fallbacks(self):
        b = aux_stt_agent({"options": {"tts": {"language": "de-DE"}}}, {"vendor": None, "language": None})
        assert b["options"]["stt"] == {"language": "de-DE"}
        c = aux_stt_agent(self.AGENT, {"vendor": "google", "language": "es"})
        assert c["options"]["stt"] == {"vendor": "google", "language": "es"}
        assert aux_stt_agent({}, {"vendor": None, "language": None})["options"]["stt"] == {}

    def test_vendor_resolution(self):
        assert aux_stt_vendor({}, {"vendor": None, "language": None}) == {"vendor": "deepgram", "model": None}
        assert aux_stt_vendor({}, {"vendor": "Google", "language": None}) == {"vendor": "google", "model": None}
        assert aux_stt_vendor({}, {"vendor": "deepgram/nova-2:en", "language": None}) == {
            "vendor": "deepgram",
            "model": "deepgram/nova-2",
        }


# ---- the tap, through a real pipeline ---------------------------------------


class _FakeStream:
    """Stand-in for SttStream: records what it is fed and emits a final
    transcript through ``on_final`` after ``final_after`` feeds."""

    instances: list["_FakeStream"] = []

    def __init__(self, stt_service, on_final, *, sample_rate, num_channels, final_after=2, text=" hello there "):
        self.stt_service = stt_service
        self.on_final = on_final
        self.sample_rate = sample_rate
        self.num_channels = num_channels
        self.final_after = final_after
        self.text = text
        self.fed: list[bytes] = []
        self.started = False
        self.stopped = False
        _FakeStream.instances.append(self)

    async def start(self):
        self.started = True

    async def feed(self, pcm16: bytes):
        self.fed.append(pcm16)
        if len(self.fed) == self.final_after:
            await self.on_final(self.text)

    async def stop(self):
        self.stopped = True


def _audio(ms: int, rate: int = 8000) -> InputAudioRawFrame:
    """`ms` of s16le mono silence at `rate`."""
    return InputAudioRawFrame(audio=b"\x00\x00" * (rate * ms // 1000), sample_rate=rate, num_channels=1)


def _tap(**kw) -> tuple[AuxSttTap, list, list]:
    finals: list[str] = []
    usage: list[tuple[str, int]] = []

    async def on_final(text):
        finals.append(text)

    tap = AuxSttTap(
        stt_factory=kw.pop("stt_factory", lambda: "fake-stt"),
        on_final=on_final,
        on_usage=lambda unit, qty: usage.append((unit, qty)),
        stream_factory=kw.pop("stream_factory", _FakeStream),
        **kw,
    )
    return tap, finals, usage


class TestAuxSttTap:
    def setup_method(self):
        _FakeStream.instances.clear()

    def test_passthrough_copy_meter_and_finals(self):
        async def run():
            tap, finals, usage = _tap()
            f1, f2, f3 = _audio(20), _audio(20), _audio(10)
            text = TextFrame("not audio")
            # Input audio is a system frame (processed immediately) while the
            # TextFrame is a data frame (queued), so it arrives after the audio.
            down, _up = await run_test(
                tap,
                frames_to_send=[f1, text, f2, f3],
                expected_down_frames=[InputAudioRawFrame, InputAudioRawFrame, InputAudioRawFrame, TextFrame],
            )
            # Every frame passed through untouched (same objects, same bytes).
            assert [d for d in down if isinstance(d, InputAudioRawFrame)] == [f1, f2, f3]
            assert [d for d in down if isinstance(d, TextFrame)] == [text]
            assert f1.audio == b"\x00\x00" * 160

            # One side pipeline, started lazily at the call's own input format,
            # fed a copy of each audio frame in order.
            assert len(_FakeStream.instances) == 1
            side = _FakeStream.instances[0]
            assert side.started and side.stopped, "started on first audio, stopped on EndFrame"
            assert side.stt_service == "fake-stt"
            assert (side.sample_rate, side.num_channels) == (8000, 1)
            assert side.fed == [f1.audio, f2.audio, f3.audio]

            # The final was forwarded, trimmed, and counted in characters.
            assert finals == ["hello there"]
            assert ("characters", len("hello there")) in usage
            # Audio streamed = 50 ms, reported in whole milliseconds, no drift.
            # The fake returns its first transcript while the 2nd frame is being
            # fed, so: frame 1 (20 ms) was held back and released with that
            # transcript, then frames 2 and 3 (20 + 10 ms) reported directly.
            assert [q for u, q in usage if u == "milliseconds"] == [20, 20, 10]
            assert tap.usage == {"milliseconds": 50, "characters": len("hello there")}

        asyncio.run(run())

    def test_cancel_stops_side_pipeline(self):
        async def run():
            tap, _finals, _usage = _tap()
            await run_test(
                tap,
                frames_to_send=[_audio(20), CancelFrame()],
                expected_down_frames=[InputAudioRawFrame, CancelFrame],
                send_end_frame=False,
            )
            await asyncio.sleep(0)  # let the scheduled stop run
            assert _FakeStream.instances[0].stopped

        asyncio.run(run())

    def test_engine_that_never_transcribes_is_not_metered(self):
        async def run():
            # e.g. rejected credentials: audio streams into the side pipeline, nothing comes back.
            tap, finals, usage = _tap(stream_factory=lambda *a, **k: _FakeStream(*a, final_after=99, **k))
            await run_test(
                tap,
                frames_to_send=[_audio(20), _audio(20), _audio(20)],
                expected_down_frames=[InputAudioRawFrame] * 3,
            )
            await asyncio.sleep(0)
            assert finals == []
            assert usage == [], "streamed audio the engine never turned into a transcript is not billed"
            assert tap.usage["milliseconds"] == 60, "…but it is still visible as streamed audio"

        asyncio.run(run())

    def test_engine_build_failure_is_contained(self):
        async def run():
            def boom():
                raise RuntimeError("Unsupported STT vendor 'nope' for pipeline mode")

            tap, finals, usage = _tap(stt_factory=boom)
            f1, f2 = _audio(20), _audio(20)
            down, _ = await run_test(
                tap,
                frames_to_send=[f1, f2],
                expected_down_frames=[InputAudioRawFrame, InputAudioRawFrame],
            )
            # The call carries on: audio still flows, nothing metered, no finals.
            assert [d for d in down if isinstance(d, InputAudioRawFrame)] == [f1, f2]
            assert finals == [] and usage == []
            assert _FakeStream.instances == []

        asyncio.run(run())

    def test_format_change_mid_call_drops_mismatched_frames(self):
        async def run():
            tap, _finals, usage = _tap()
            await run_test(
                tap,
                frames_to_send=[_audio(20, 8000), _audio(20, 16000), _audio(20, 8000)],
                expected_down_frames=[InputAudioRawFrame] * 3,
            )
            side = _FakeStream.instances[0]
            assert len(side.fed) == 2, "the 16 kHz frame was not fed to an 8 kHz engine"
            assert sum(q for u, q in usage if u == "milliseconds") == 40

        asyncio.run(run())

    def test_transcript_handler_errors_do_not_stop_the_tap(self):
        async def run():
            calls = []

            async def failing_on_final(text):
                calls.append(text)
                raise RuntimeError("log post failed")

            tap = AuxSttTap(
                stt_factory=lambda: "fake",
                on_final=failing_on_final,
                on_usage=lambda *_: None,
                stream_factory=lambda *a, **k: _FakeStream(*a, final_after=1, **k),
            )
            await run_test(
                tap,
                frames_to_send=[_audio(20), _audio(20), _audio(20)],
                expected_down_frames=[InputAudioRawFrame] * 3,
            )
            assert calls == [" hello there ".strip()]
            assert len(_FakeStream.instances[0].fed) == 3

        asyncio.run(run())


class TestVoiceSessionWiring:
    def test_tap_built_only_when_configured_and_callback_present(self):
        from pipecat_aplisay.voice_session import _aux_stt_tap_for

        async def on_transcript(_text):
            pass

        assert _aux_stt_tap_for({"options": {}}, on_transcript, None) is None
        assert _aux_stt_tap_for({"options": {"stt": {"aux": {}}}}, None, None) is None
        tap = _aux_stt_tap_for({"options": {"stt": {"aux": {"vendor": "google"}}}}, on_transcript, None)
        assert isinstance(tap, AuxSttTap)

    def test_usage_callback_carries_the_aux_vendor(self):
        from pipecat_aplisay.voice_session import _aux_stt_tap_for

        seen = []

        async def on_transcript(_text):
            pass

        tap = _aux_stt_tap_for(
            {"options": {"stt": {"vendor": "deepgram", "aux": {"vendor": "google"}}}},
            on_transcript,
            lambda unit, qty, vendor: seen.append((unit, qty, vendor)),
        )
        tap._on_usage("milliseconds", 20)
        assert seen == [("milliseconds", 20, {"vendor": "google", "model": None})]


class TestCallSessionHandoff:
    def test_aux_usage_lands_on_the_usage_observer_as_stt_aux(self):
        from pipecat_aplisay.call_session import CallSession
        from pipecat_aplisay.usage import UsageMeteringObserver

        session = CallSession.__new__(CallSession)
        session._usage_observer = UsageMeteringObserver(services={})
        CallSession._on_aux_usage(session, "milliseconds", 1500, {"vendor": "google", "model": None})
        CallSession._on_aux_usage(session, "characters", 11, {"vendor": "google", "model": None})
        rows = {(m["technology"], m["unit"]): m for m in session._usage_observer._meters.values()}
        assert rows[("stt-aux", "milliseconds")]["quantity"] == 1500
        assert rows[("stt-aux", "milliseconds")]["provider"] == "google"
        assert rows[("stt-aux", "characters")]["quantity"] == 11

    def test_aux_usage_before_observer_exists_is_ignored(self):
        from pipecat_aplisay.call_session import CallSession

        session = CallSession.__new__(CallSession)
        CallSession._on_aux_usage(session, "milliseconds", 1, {"vendor": "google", "model": None})

    def test_aux_transcript_logs_user_aux_final(self):
        from pipecat_aplisay.call_session import CallSession

        sent = []

        async def _send_message(message, *, is_final=True):
            sent.append((message, is_final))

        session = CallSession.__new__(CallSession)
        session._send_message = _send_message
        asyncio.run(CallSession._on_aux_transcript(session, "hello there"))
        assert sent == [({"user-aux": "hello there"}, True)]
