"""A speech stream must reach the caller intact through pipecat's output transport.

The end-to-end cases run the real BaseOutputTransport at real-time pace. Speech
samples carry a counter (BASE + n % WRAP for global sample n) and pauses are
zeros, so every inserted zero and every lost sample in what the transport wrote
can be counted.
"""

from __future__ import annotations

import asyncio
import itertools

import numpy as np
import pytest
from pipecat.frames.frames import (
    EndFrame,
    InterruptionFrame,
    SpeechOutputAudioRawFrame,
    StartFrame,
    TTSAudioRawFrame,
    TTSStartedFrame,
    TTSStoppedFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.tests.utils import SleepFrame, run_test
from pipecat.transports.base_output import BaseOutputTransport
from pipecat.transports.base_transport import TransportParams

from pipecat_aplisay.speech_stream_aligner import SpeechStreamAligner

RATE = 24000
CHUNK = RATE // 100 * 2 * 4              # the transport's default: 4 x 10 ms
WRAP = 16384
BASE = 2000
LEAD_S = 0.3                             # the stream runs this far ahead of playback
SPEECH = [(0.0, 1.0), (1.5, 2.2)]        # the pause between is longer than BOT_VAD_STOP_SECS
END_S = 2.4
STOPS = [0.4, 0.75, 1.8]                 # mid-speech TTSStoppedFrame, as OpenAI Live emits
DELTAS_MS = [27, 53, 18, 61]             # never a whole number of chunks


def _signal() -> np.ndarray:
    x = np.zeros(int(END_S * RATE), np.int16)
    for a, b in SPEECH:
        i, j = int(a * RATE), int(b * RATE)
        x[i:j] = (BASE + np.arange(i, j) % WRAP).astype(np.int16)
    return x


def _audit(x: np.ndarray) -> tuple[int, int]:
    """Samples of zeros inserted into speech, and speech samples lost."""
    inserted = lost = 0
    nz = np.flatnonzero(x != 0)
    for a, b in zip(nz, nz[1:]):
        zeros = b - a - 1
        expected = (int(x[b]) - int(x[a])) % WRAP - 1
        if zeros > expected:
            inserted += zeros - expected
        elif zeros < expected:
            lost += expected - zeros
    return inserted, lost


class _PacedOutput(BaseOutputTransport):
    def __init__(self) -> None:
        super().__init__(TransportParams(audio_out_enabled=True, audio_out_sample_rate=RATE))
        self.written = bytearray()
        self._due = None

    async def start(self, frame: StartFrame) -> None:
        await super().start(frame)
        await self.set_transport_ready(frame)

    async def write_audio_frame(self, frame, *args, **kwargs) -> bool:
        loop = asyncio.get_running_loop()
        self._due = max(self._due or 0.0, loop.time())
        self.written.extend(frame.audio)
        self._due += len(frame.audio) / 2 / frame.sample_rate
        await asyncio.sleep(max(0.0, self._due - loop.time()))
        return True


class _Stream(FrameProcessor):
    async def process_frame(self, frame, direction) -> None:
        await super().process_frame(frame, direction)
        await self.push_frame(frame, direction)
        if isinstance(frame, StartFrame):
            self.create_task(self._run(), "stream")

    async def _run(self) -> None:
        loop = asyncio.get_running_loop()
        t0 = loop.time()
        x = _signal()
        stops = list(STOPS)
        await self.push_frame(TTSStartedFrame())
        pos = 0
        for ms in itertools.cycle(DELTAS_MS):
            if pos >= len(x):
                break
            while stops and stops[0] <= pos / RATE:
                stops.pop(0)
                await self.push_frame(TTSStoppedFrame())
                await self.push_frame(TTSStartedFrame())
            await asyncio.sleep(max(0.0, t0 + pos / RATE - LEAD_S - loop.time()))
            chunk = x[pos : pos + ms * RATE // 1000]
            pos += len(chunk)
            await self.push_frame(SpeechOutputAudioRawFrame(chunk.tobytes(), RATE, 1))


async def _run_stream(with_aligner: bool) -> np.ndarray:
    out = _PacedOutput()
    chain = [_Stream()]
    if with_aligner:
        chain.append(SpeechStreamAligner(output_transport=out))
    task = PipelineTask(Pipeline([*chain, out]), params=PipelineParams(), idle_timeout_secs=None)
    runner = asyncio.create_task(PipelineRunner(handle_sigint=False).run(task))
    await asyncio.sleep(END_S + 0.8)
    await task.queue_frame(EndFrame())
    await asyncio.wait_for(runner, timeout=10)
    return np.frombuffer(bytes(out.written), np.int16)


class TestThroughTheTransport:
    def test_without_the_aligner_speech_is_cut(self) -> None:
        """The control: the transport pads and drops its remainder mid-speech."""
        inserted, lost = _audit(asyncio.run(_run_stream(with_aligner=False)))
        assert inserted > 0, "a mid-speech TTSStoppedFrame should have padded zeros in"
        assert lost > 0, "the pause should have dropped the start of the next speech"

    def test_with_the_aligner_speech_arrives_intact(self) -> None:
        inserted, lost = _audit(asyncio.run(_run_stream(with_aligner=True)))
        assert (inserted, lost) == (0, 0)


class _Output:
    """Stands in for transport.output(): the aligner reads only these two."""

    def __init__(self, rate: int = RATE, chunk: int = CHUNK) -> None:
        self.sample_rate = rate
        self.audio_chunk_size = chunk


def _speech(ms: int) -> SpeechOutputAudioRawFrame:
    return SpeechOutputAudioRawFrame(b"\x01\x00" * (RATE * ms // 1000), RATE, 1)


def _down(frames, output=None) -> list:
    """Frames that leave the aligner; run_test ends with an EndFrame, which sends what is held."""

    async def go():
        down, _up = await run_test(
            SpeechStreamAligner(output_transport=output or _Output()), frames_to_send=frames
        )
        return list(down)

    return asyncio.run(go())


def _ms(frame) -> int:
    return len(frame.audio) // 2 * 1000 // RATE


class TestAlignment:
    def test_speech_leaves_in_whole_chunks_and_the_rest_waits(self) -> None:
        down = _down([_speech(27), _speech(53), _speech(18)])
        *aligned, held = down
        assert [_ms(f) for f in aligned] == [80], "98 ms in: two chunks by the second frame"
        assert _ms(held) == 18, "the rest waits for more audio, sent only at the end"

    def test_tts_stopped_does_not_flush_a_speech_stream(self) -> None:
        down = _down([_speech(30), TTSStoppedFrame()])
        assert [type(f) for f in down] == [TTSStoppedFrame, SpeechOutputAudioRawFrame]

    def test_other_audio_keeps_its_place_behind_held_speech(self) -> None:
        tts = TTSAudioRawFrame(b"\x02\x00" * 480, RATE, 1)
        down = _down([_speech(30), tts])
        assert [type(f) for f in down] == [SpeechOutputAudioRawFrame, TTSAudioRawFrame]
        assert _ms(down[0]) == 30

    def test_an_interruption_drops_what_is_held(self) -> None:
        # A system frame overtakes queued ones, so let the speech land first.
        down = _down([_speech(30), SleepFrame(sleep=0.1), InterruptionFrame(), _speech(40)])
        audio = [f for f in down if isinstance(f, SpeechOutputAudioRawFrame)]
        assert [_ms(f) for f in audio] == [40]

    def test_a_rate_mismatch_passes_through(self) -> None:
        down = _down([_speech(30)], output=_Output(rate=16000))
        assert [_ms(f) for f in down] == [30]
