"""options.backgroundAudio on the Pipecat worker: the parser, the gate, the
loop and fades, and the injector's frames. See docs/background-audio.md."""

from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace

import numpy as np
import pytest
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    FunctionCallFromLLM,
    FunctionCallResultFrame,
    FunctionCallsStartedFrame,
    OutputAudioRawFrame,
    SpeechOutputAudioRawFrame,
    TTSAudioRawFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection
from pipecat.tests.utils import run_test

from pipecat_aplisay.background_audio import (
    FADE_IN_SECS,
    FADE_OUT_SECS,
    WORKING_MAX_SECS,
    BackgroundAudioInjector,
    BackgroundConfig,
    BackgroundGate,
    LoopReader,
    background_config_from_options,
    scaled_asset,
)

RATE = 16000
CHUNK = 1280  # 40 ms at 16 kHz, the SIP transports' chunk


def _parse(raw):
    return background_config_from_options({"backgroundAudio": raw})


class TestParser:
    @pytest.mark.parametrize(
        "options",
        [None, {}, {"backgroundAudio": False}, {"backgroundAudio": {"enabled": False}},
         {"backgroundAudio": "office"}, {"backgroundAudio": ["office"]}, "not a dict"],
    )
    def test_off(self, options) -> None:
        assert background_config_from_options(options) is None

    def test_true_and_empty_give_defaults(self) -> None:
        assert _parse(True) == BackgroundConfig("office", 0.10, "thinking", 600)
        assert _parse({}) == BackgroundConfig("office", 0.10, "thinking", 600)

    def test_levels_modes_and_clamps(self) -> None:
        assert _parse({"volume": "low"}).volume == 0.05
        assert _parse({"volume": "HIGH"}).volume == 0.20
        assert _parse({"volume": "loud"}).volume == 0.10
        assert _parse({"when": "silent"}).when == "silent"
        assert _parse({"when": "Always"}).when == "always"
        assert _parse({"when": "never"}).when == "thinking"
        assert _parse({"delayMs": -5}).delay_ms == 0
        assert _parse({"delayMs": 99999}).delay_ms == 10000
        assert _parse({"delayMs": True}).delay_ms == 600
        assert _parse({"delayMs": "300"}).delay_ms == 600
        assert _parse({"delayMs": float("nan")}).delay_ms == 600
        assert _parse({"sound": "cafe"}).sound == "office"

    def test_halves_round_up_as_on_livekit(self) -> None:
        assert _parse({"delayMs": 250.5}).delay_ms == 251
        assert _parse({"delayMs": 250.4}).delay_ms == 250


def _live_gate(**over) -> BackgroundGate:
    gate = BackgroundGate(BackgroundConfig(**{"delay_ms": 600, **over}))
    gate.initializing = False
    return gate


class TestGate:
    def test_shut_until_ready(self) -> None:
        for when in ("thinking", "silent", "always"):
            gate = BackgroundGate(BackgroundConfig(when=when, delay_ms=0))
            gate.tools_started(["a"])
            assert gate.evaluate(0.0) == (False, None), when

    def test_thinking_waits_delay_ms_of_work_in_silence(self) -> None:
        # Times are exact binary fractions so the sums below are exact.
        gate = _live_gate(delay_ms=500)
        assert gate.evaluate(0.0) == (False, None)
        gate.tools_started(["call-1"])
        assert gate.evaluate(1.0) == (False, 0.5)
        assert gate.evaluate(1.25) == (False, 0.25)
        assert gate.evaluate(1.5) == (True, 0.0)
        gate.agent_audible = True
        assert gate.evaluate(1.75)[0] is False
        gate.agent_audible = False
        assert gate.evaluate(2.0)[0] is False, "the hold starts again"
        assert gate.evaluate(2.5)[0] is True
        gate.tool_finished("call-1")
        assert gate.evaluate(2.75)[0] is False

    def test_thinking_shut_while_the_caller_speaks(self) -> None:
        gate = _live_gate(delay_ms=0)
        gate.tools_started(["a"])
        gate.note_user_speaking(True, 0.0)
        assert gate.evaluate(5.0)[0] is False

    def test_turn_end_counts_as_work_until_the_agent_is_heard(self) -> None:
        gate = _live_gate()
        gate.note_user_speaking(True, 0.0)
        gate.note_user_speaking(False, 1.0)
        assert gate.evaluate(1.0)[0] is False
        assert gate.evaluate(1.6)[0] is True
        gate.note_agent_heard()
        assert gate.evaluate(2.0)[0] is False

    def test_turn_end_gives_up_after_the_backstop(self) -> None:
        gate = _live_gate(delay_ms=0)
        gate.note_user_speaking(True, 0.0)
        gate.note_user_speaking(False, 0.0)
        assert gate.evaluate(WORKING_MAX_SECS - 0.01)[0] is True
        assert gate.evaluate(WORKING_MAX_SECS)[0] is False

    def test_silent_plays_under_the_caller(self) -> None:
        gate = _live_gate(when="silent", delay_ms=300)
        assert gate.evaluate(0.0)[0] is False
        assert gate.evaluate(0.3)[0] is True
        gate.note_user_speaking(True, 0.4)
        assert gate.evaluate(0.4)[0] is True
        gate.agent_audible = True
        assert gate.evaluate(0.5)[0] is False

    def test_always_ignores_delay_and_speech(self) -> None:
        gate = _live_gate(when="always", delay_ms=10000)
        gate.agent_audible = True
        gate.note_user_speaking(True, 0.0)
        assert gate.evaluate(0.0) == (True, 0.0)

    @pytest.mark.parametrize("when", ["thinking", "silent", "always"])
    @pytest.mark.parametrize(
        "block",
        [
            lambda g: setattr(g, "transfer_state", "dialling"),
            lambda g: setattr(g, "transfer_state", "talking"),
            lambda g: setattr(g, "transfer_state", "something new"),
            lambda g: setattr(g, "bridged", True),
            lambda g: setattr(g, "handover_tone", True),
            lambda g: setattr(g, "ending", True),
        ],
        ids=["dialling", "talking", "unknown state", "bridged", "handover tone", "ending"],
    )
    def test_every_mode_is_blocked(self, when, block) -> None:
        gate = _live_gate(when=when, delay_ms=0)
        gate.tools_started(["a"])
        assert gate.evaluate(0.0)[0] is True
        block(gate)
        assert gate.evaluate(0.1) == (False, None)

    @pytest.mark.parametrize("state", ["none", "failed", "rejected"])
    def test_idle_transfer_states_do_not_block(self, state) -> None:
        gate = _live_gate(when="silent", delay_ms=0)
        gate.transfer_state = state
        assert gate.evaluate(0.0)[0] is True

    def test_a_completed_bridge_blocks_with_the_state_back_at_none(self) -> None:
        gate = _live_gate(when="silent", delay_ms=0)
        gate.transfer_state = "none"
        gate.bridged = True
        assert gate.evaluate(0.0)[0] is False


class TestAsset:
    def test_16k_is_the_committed_file_scaled(self) -> None:
        medium = scaled_asset("office", 16000, 0.10)
        assert medium.dtype == np.int16
        assert 10 * RATE < len(medium) < 30 * RATE
        assert scaled_asset("office", 16000, 0.10) is medium, "cached"
        high = scaled_asset("office", 16000, 0.20)
        assert int(np.abs(high).max()) < 8192

    def test_resampled_once_to_the_transport_rate(self) -> None:
        base = scaled_asset("office", 16000, 0.10)
        wide = scaled_asset("office", 24000, 0.10)
        assert len(wide) == round(len(base) * 1.5)
        # The level survives the resample.
        rms = lambda a: float(np.sqrt(np.mean(a.astype(np.float64) ** 2)))  # noqa: E731
        assert abs(rms(wide) - rms(base)) / rms(base) < 0.05


class TestLoopReader:
    def test_wraps_and_carries_on(self) -> None:
        samples = np.array([1, 2, 3, 4, 5], dtype=np.int16)
        reader = LoopReader(samples, RATE, pos=3)
        reader.gain = 1.0
        reader.set_open(True)
        out = np.frombuffer(reader.chunk(7), dtype=np.int16)
        assert out.tolist() == [4, 5, 1, 2, 3, 4, 5]
        assert reader.pos == 0
        assert np.frombuffer(reader.chunk(2), dtype=np.int16).tolist() == [1, 2]

    def test_fade_in_then_copy_then_fade_out(self) -> None:
        reader = LoopReader(np.full(RATE, 10000, dtype=np.int16), RATE)
        assert reader.silent
        reader.set_open(True)
        half = np.frombuffer(reader.chunk(int(RATE * FADE_IN_SECS / 2)), dtype=np.int16)
        assert reader.gain == pytest.approx(0.5, abs=1e-3)
        assert 0 < half[0] < 10 and half[-1] > half[0]
        reader.chunk(int(RATE * FADE_IN_SECS / 2))
        assert reader.gain == 1.0
        assert np.all(np.frombuffer(reader.chunk(800), dtype=np.int16) == 10000)
        reader.set_open(False)
        out = np.frombuffer(reader.chunk(int(RATE * FADE_OUT_SECS)), dtype=np.int16)
        assert reader.gain == 0.0
        assert out[-1] == 0
        assert reader.silent

    def test_mix_adds_and_clips(self) -> None:
        reader = LoopReader(np.array([1000, -1000, 20000, -20000], dtype=np.int16), RATE)
        reader.gain = 1.0
        reader.set_open(True)
        agent = np.array([100, 100, 20000, -20000], dtype=np.int16).tobytes()
        out = np.frombuffer(reader.mix(agent), dtype=np.int16)
        assert out.tolist() == [1100, -900, 32767, -32768]


def _transport(rate: int = RATE, chunk: int = CHUNK):
    return SimpleNamespace(sample_rate=rate, audio_chunk_size=chunk)


def _injector(when: str = "always", *, state: str = "none", transport=None, **probes):
    return BackgroundAudioInjector(
        BackgroundConfig(when=when, delay_ms=0),
        get_transfer_state=lambda: SimpleNamespace(state=state),
        output_transport=transport,
        **probes,
    )


async def _collect(inj: BackgroundAudioInjector, seconds: float, *, during=None) -> list:
    """Run the injector's sender for ``seconds``; return what it pushed."""
    pushed: list = []

    async def record(frame, direction=FrameDirection.DOWNSTREAM):
        pushed.append((frame, direction))

    inj.push_frame = record  # type: ignore[method-assign]
    task = asyncio.create_task(inj._run())
    try:
        if during is not None:
            await during()
        await asyncio.sleep(seconds)
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass
    return [frame for frame, _ in pushed]


class TestSending:
    def test_whole_plain_chunks_at_the_transport_rate(self) -> None:
        async def run():
            inj = _injector(transport=_transport())
            frames = await _collect(inj, 0.5)
            assert len(frames) >= 8
            for frame in frames:
                assert type(frame) is OutputAudioRawFrame
                assert frame.sample_rate == RATE
                assert frame.num_channels == 1
                assert len(frame.audio) == CHUNK
            # Paced at the deadline: about one chunk per 40 ms, no burst.
            assert len(frames) <= 0.5 / 0.04 + 2

        asyncio.run(run())

    def test_follows_the_transport_rate(self) -> None:
        async def run():
            frames = await _collect(_injector(transport=_transport(24000, 1920)), 0.2)
            assert frames and all(f.sample_rate == 24000 and len(f.audio) == 1920 for f in frames)

        asyncio.run(run())

    def test_nothing_before_the_rate_is_known(self) -> None:
        async def run():
            transport = SimpleNamespace(sample_rate=0, audio_chunk_size=0)
            inj = _injector(transport=transport)

            async def later():
                await asyncio.sleep(0.3)
                assert inj._reader is None
                transport.sample_rate = RATE
                transport.audio_chunk_size = CHUNK

            frames = await _collect(inj, 0.2, during=later)
            assert frames, "starts once the rate is known"
            assert all(f.sample_rate == RATE for f in frames)

        asyncio.run(run())

    def test_nothing_while_shut_and_no_ticker(self) -> None:
        async def run():
            inj = _injector("thinking", transport=_transport())
            calls = 0
            evaluate = inj._evaluate

            def counting(now):
                nonlocal calls
                calls += 1
                return evaluate(now)

            inj._evaluate = counting  # type: ignore[method-assign]
            frames = await _collect(inj, 0.6)
            assert frames == []
            assert calls <= 2, f"woke {calls} times with nothing to do"

        asyncio.run(run())

    def test_blocked_by_transfer_and_bridge(self) -> None:
        async def run():
            assert await _collect(_injector(state="dialling", transport=_transport()), 0.3) == []
            assert await _collect(_injector(state="talking", transport=_transport()), 0.3) == []
            bridged = _injector(transport=_transport(), is_bridged=lambda: True)
            assert await _collect(bridged, 0.3) == []
            handover = _injector(transport=_transport(), handover_tone_active=lambda: True)
            assert await _collect(handover, 0.3) == []

        asyncio.run(run())

    def test_transfer_end_is_seen_by_polling(self) -> None:
        async def run():
            state = SimpleNamespace(state="dialling")
            inj = BackgroundAudioInjector(
                BackgroundConfig(when="always"),
                get_transfer_state=lambda: state,
                output_transport=_transport(),
            )

            async def end_transfer():
                await asyncio.sleep(0.2)
                state.state = "failed"

            frames = await _collect(inj, 0.5, during=end_transfer)
            assert frames

        asyncio.run(run())

    def test_no_gap_fill_while_agent_audio_is_queued(self) -> None:
        async def run():
            inj = _injector(transport=_transport())

            async def speak():
                await asyncio.sleep(0.15)
                # One second of agent audio handed downstream at once.
                inj._on_agent_audio(
                    TTSAudioRawFrame(audio=bytes(2 * RATE), sample_rate=RATE, num_channels=1),
                    time.monotonic(),
                )
                pushed_before = len(sent)
                await asyncio.sleep(0.5)
                assert len(sent) == pushed_before, "gap fill held back under the speech"

            sent: list = []

            async def record(frame, direction=FrameDirection.DOWNSTREAM):
                sent.append(frame)

            inj.push_frame = record  # type: ignore[method-assign]
            task = asyncio.create_task(inj._run())
            await speak()
            await asyncio.sleep(0.6)
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            assert len(sent) > 0

        asyncio.run(run())


def _ready(inj: BackgroundAudioInjector, samples: np.ndarray, *, full: bool = True) -> LoopReader:
    reader = LoopReader(samples, RATE)
    if full:
        reader.gain = 1.0
    inj._reader = reader
    inj._gate.initializing = False
    return reader


class TestAgentAudio:
    def test_playout_clock(self) -> None:
        inj = _injector("thinking", transport=_transport())
        now = 100.0
        inj._on_agent_audio(TTSAudioRawFrame(audio=bytes(2 * RATE), sample_rate=RATE, num_channels=1), now)
        assert inj._queued_until == pytest.approx(101.0)
        assert inj._audible_until == pytest.approx(101.0)
        inj._on_agent_audio(TTSAudioRawFrame(audio=bytes(RATE), sample_rate=RATE, num_channels=1), now + 0.1)
        assert inj._queued_until == pytest.approx(101.5)

    def test_silence_in_a_speech_stream_is_not_the_agent_talking(self) -> None:
        inj = _injector("thinking", transport=_transport())
        inj._gate.note_user_speaking(True, 0.0)
        inj._gate.note_user_speaking(False, 1.0)
        inj._on_agent_audio(
            SpeechOutputAudioRawFrame(audio=bytes(2 * RATE), sample_rate=RATE, num_channels=1), 2.0
        )
        assert inj._queued_until == pytest.approx(3.0)
        assert inj._audible_until == 0.0
        assert inj._gate._turn_ended_at == 1.0, "still waiting for the reply"

    def test_always_mixes_into_agent_audio(self) -> None:
        inj = _injector("always", transport=_transport())
        _ready(inj, np.full(RATE, 1000, dtype=np.int16))
        frame = TTSAudioRawFrame(
            audio=np.full(320, 500, dtype=np.int16).tobytes(), sample_rate=RATE, num_channels=1
        )
        out = inj._on_agent_audio(frame, time.monotonic())
        assert out is frame
        assert np.all(np.frombuffer(out.audio, dtype=np.int16) == 1500)

    def test_mixing_clips(self) -> None:
        inj = _injector("always", transport=_transport())
        _ready(inj, np.full(RATE, 20000, dtype=np.int16))
        loud = np.array([20000, -20000] * 160, dtype=np.int16).tobytes()
        out = inj._on_agent_audio(TTSAudioRawFrame(audio=loud, sample_rate=RATE, num_channels=1), 0.0)
        values = np.frombuffer(out.audio, dtype=np.int16)
        assert values[0] == 32767 and values[1] == 0

    def test_skips_frames_at_another_rate(self) -> None:
        inj = _injector("always", transport=_transport())
        _ready(inj, np.full(RATE, 1000, dtype=np.int16))
        audio = bytes(960)
        out = inj._on_agent_audio(TTSAudioRawFrame(audio=audio, sample_rate=24000, num_channels=1), 0.0)
        assert out.audio == audio

    def test_thinking_fades_out_under_the_first_speech(self) -> None:
        inj = _injector("thinking", transport=_transport())
        _ready(inj, np.full(RATE, 1000, dtype=np.int16))
        inj._gate.tools_started(["a"])
        frame = TTSAudioRawFrame(audio=bytes(2 * 320), sample_rate=RATE, num_channels=1)
        out = np.frombuffer(inj._on_agent_audio(frame, time.monotonic()).audio, dtype=np.int16)
        assert 900 < out[0] <= 1000, "starts at full level"
        assert out[-1] < out[0], "and falls"

    def test_speech_stream_silence_is_carried_in_a_plain_frame(self) -> None:
        inj = _injector("silent", transport=_transport())
        _ready(inj, np.full(RATE, 1000, dtype=np.int16))
        frame = SpeechOutputAudioRawFrame(audio=bytes(640), sample_rate=RATE, num_channels=1)
        out = inj._on_agent_audio(frame, time.monotonic())
        assert type(out) is OutputAudioRawFrame
        assert np.all(np.frombuffer(out.audio, dtype=np.int16) == 1000)

    def test_speech_stream_silence_is_left_alone_while_the_bot_speaks(self) -> None:
        inj = _injector("always", transport=_transport())
        _ready(inj, np.full(RATE, 1000, dtype=np.int16))
        inj._bot_speaking = True
        frame = SpeechOutputAudioRawFrame(audio=bytes(640), sample_rate=RATE, num_channels=1)
        out = inj._on_agent_audio(frame, time.monotonic())
        assert out is frame and out.audio == bytes(640)


def test_frames_drive_the_gate() -> None:
    """Tool calls, the caller's turn and bot speech reach the gate as frames."""

    async def run():
        inj = _injector("thinking")
        call = FunctionCallFromLLM(function_name="lookup", tool_call_id="t1", arguments={}, context=None)
        await run_test(
            inj,
            frames_to_send=[
                UserStartedSpeakingFrame(),
                UserStoppedSpeakingFrame(),
                FunctionCallsStartedFrame(function_calls=[call]),
            ],
            expected_down_frames=[UserStartedSpeakingFrame, UserStoppedSpeakingFrame, FunctionCallsStartedFrame],
        )
        assert inj._gate._tools == {"t1"}
        assert inj._gate._turn_ended_at is not None
        assert inj._gate.user_speaking is False

        await run_test(
            inj,
            frames_to_send=[
                FunctionCallResultFrame(function_name="lookup", tool_call_id="t1", arguments={}, result="ok"),
            ],
            expected_down_frames=[FunctionCallResultFrame],
        )
        assert inj._gate._tools == set()

        await run_test(
            inj,
            frames_to_send=[BotStartedSpeakingFrame()],
            frames_to_send_direction=FrameDirection.UPSTREAM,
            expected_up_frames=[BotStartedSpeakingFrame],
        )
        assert inj._bot_speaking is True

    asyncio.run(run())
