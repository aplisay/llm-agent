"""The recording must not cut zeros into either speaker's speech.

User speech carries a counter (BASE + n % WRAP), so zeros inserted into it can
be counted in the user track. Agent frames arrive 30 ms ahead in 40 ms pieces,
as the output transport hands them on; user frames arrive in 20 ms pieces.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import numpy as np
from pipecat.frames.frames import (
    InputAudioRawFrame,
    SpeechOutputAudioRawFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.audio import audio_buffer_processor as abp

from pipecat_aplisay.recording import speech_gated_buffer as sgb
from pipecat_aplisay.recording.speech_gated_buffer import SpeechGatedAudioBufferProcessor

REC = 16000
BOT = 24000
WRAP = 16384
BASE = 2000
SPEECH = (0.5, 2.5)
END = 3.0


def _user_signal() -> np.ndarray:
    x = np.zeros(int(END * REC), np.int16)
    i, j = int(SPEECH[0] * REC), int(SPEECH[1] * REC)
    x[i:j] = (BASE + np.arange(i, j) % WRAP).astype(np.int16)
    return x


def _inserted(x: np.ndarray) -> int:
    nz = np.flatnonzero(x != 0)
    total = 0
    for a, b in zip(nz, nz[1:]):
        extra = (b - a - 1) - ((int(x[b]) - int(x[a])) % WRAP - 1)
        total += max(0, extra)
    return total


def _schedule(flags):
    """(time, frame) for the whole call, in arrival order."""
    user = _user_signal()
    events = []
    for k in range(0, len(user), REC // 50):
        events.append((k / REC, InputAudioRawFrame(user[k : k + REC // 50].tobytes(), REC, 1)))
    piece = BOT * 40 // 1000
    for k in range(0, int(END * BOT), piece):
        events.append((max(0.0, k / BOT - 0.03), SpeechOutputAudioRawFrame(bytes(piece * 2), BOT, 1)))
    events.extend(flags)
    events.sort(key=lambda e: e[0])
    return events


async def _record(processor_cls, flags, buffer_s: float, monkeypatch) -> np.ndarray:
    clock = [0.0]
    fake = SimpleNamespace(monotonic=lambda: clock[0])
    monkeypatch.setattr(abp, "time", fake)
    monkeypatch.setattr(sgb, "time", fake)

    proc = processor_cls(num_channels=2, sample_rate=REC, buffer_size=int(REC * 2 * buffer_s))
    proc._sample_rate = REC
    out = bytearray()

    @proc.event_handler("on_audio_data")
    async def _on(_p, audio, _sr, _ch):
        out.extend(audio)

    await proc.start_recording()
    for t, frame in _schedule(flags):
        clock[0] = t
        await proc._process_recording(frame)
    await proc.stop_recording()
    await asyncio.sleep(0.05)
    return np.frombuffer(bytes(out), np.int16).reshape(-1, 2)[:, 0]


LATE_FLAG = [(SPEECH[0] + 1.2, UserStartedSpeakingFrame()), (SPEECH[1] + 0.1, UserStoppedSpeakingFrame())]
ON_TIME = [(SPEECH[0], UserStartedSpeakingFrame()), (SPEECH[1] + 0.1, UserStoppedSpeakingFrame())]


class TestLateSpeakingFlags:
    def test_the_stock_processor_cuts_into_speech_before_the_flag(self, monkeypatch) -> None:
        """The control: the turn starts 1.2 s into the speech, as OpenAI Live's does."""
        user = asyncio.run(_record(abp.AudioBufferProcessor, LATE_FLAG, 10.0, monkeypatch))
        assert _inserted(user) > 0

    def test_the_gated_processor_leaves_speech_whole(self, monkeypatch) -> None:
        user = asyncio.run(_record(SpeechGatedAudioBufferProcessor, LATE_FLAG, 10.0, monkeypatch))
        assert _inserted(user) == 0

    def test_without_any_flags_speech_is_still_whole(self, monkeypatch) -> None:
        user = asyncio.run(_record(SpeechGatedAudioBufferProcessor, [], 10.0, monkeypatch))
        assert _inserted(user) == 0


class TestBlockBoundaries:
    def test_the_stock_processor_pads_a_speaker_at_a_block_end(self, monkeypatch) -> None:
        """The control: flags on time, but blocks of 0.25 s end mid-speech."""
        user = asyncio.run(_record(abp.AudioBufferProcessor, ON_TIME, 0.25, monkeypatch))
        assert _inserted(user) > 0

    def test_the_gated_processor_carries_instead(self, monkeypatch) -> None:
        user = asyncio.run(_record(SpeechGatedAudioBufferProcessor, ON_TIME, 0.25, monkeypatch))
        assert _inserted(user) == 0

    def test_nothing_is_lost_or_added_overall(self, monkeypatch) -> None:
        """Carried audio reaches the next block; the call's length is unchanged."""
        user = asyncio.run(_record(SpeechGatedAudioBufferProcessor, ON_TIME, 0.25, monkeypatch))
        speech = user[user != 0]
        assert len(speech) == int((SPEECH[1] - SPEECH[0]) * REC)
        assert abs(len(user) / REC - END) < 0.1, len(user) / REC
