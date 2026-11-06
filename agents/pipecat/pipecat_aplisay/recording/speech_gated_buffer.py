"""Record both sides without cutting zeros into either one's speech.

``AudioBufferProcessor`` keeps the user and bot tracks level by padding the one
that is behind with zeros, unless its speaker is speaking. It takes that from
User/BotStarted/StoppedSpeakingFrame, which some services raise late: OpenAI
Live starts the user turn on its first transcript word, up to 1.5 s into the
speech. Here a speaker counts as speaking while their own audio has been loud
within ``HANGOVER_S``, so padding only ever lands in a pause.
"""

from __future__ import annotations

import time
from typing import Any, Optional

import numpy as np
from pipecat.frames.frames import Frame, InputAudioRawFrame, OutputAudioRawFrame
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor

HANGOVER_S = 0.5
ACTIVE_DBFS = -45.0
_ACTIVE_RMS = 32768.0 * 10.0 ** (ACTIVE_DBFS / 20.0)


class _Activity:
    """Whether one side has been loud recently."""

    def __init__(self) -> None:
        self._loud_at: Optional[float] = None

    def note(self, audio: bytes) -> None:
        samples = np.frombuffer(audio[: len(audio) - len(audio) % 2], dtype=np.int16)
        if samples.size and np.sqrt(np.mean(samples.astype(np.float64) ** 2)) > _ACTIVE_RMS:
            self._loud_at = time.monotonic()

    @property
    def active(self) -> bool:
        return self._loud_at is not None and time.monotonic() - self._loud_at < HANGOVER_S


class SpeechGatedAudioBufferProcessor(AudioBufferProcessor):
    """An ``AudioBufferProcessor`` that judges who is speaking from the audio."""

    def __init__(self, **kwargs: Any) -> None:
        self._user_activity = _Activity()
        self._bot_activity = _Activity()
        self._carry_user = b""
        self._carry_bot = b""
        self._stopping = False
        super().__init__(**kwargs)

    async def _process_recording(self, frame: Frame) -> None:
        if isinstance(frame, InputAudioRawFrame):
            self._user_activity.note(frame.audio)
        elif isinstance(frame, OutputAudioRawFrame):
            self._bot_activity.note(frame.audio)
        # The parent sets these from speaking frames too; resetting them before
        # every frame means only the audio decides when an audio frame lands.
        self._user_speaking = self._user_activity.active
        self._bot_speaking = self._bot_activity.active
        await super()._process_recording(frame)

    def _align_track_buffers(self) -> None:
        user, bot = self._user_audio_buffer, self._bot_audio_buffer
        if len(user) == len(bot) or self._stopping:
            return super()._align_track_buffers()
        shorter_active = self._user_activity.active if len(user) < len(bot) else self._bot_activity.active
        if not shorter_active:
            return super()._align_track_buffers()
        # Padding the shorter track here would put zeros inside its speaker's
        # speech; send the common length and carry the rest into the next block.
        n = min(len(user), len(bot))
        self._carry_user, self._carry_bot = bytes(user[n:]), bytes(bot[n:])
        del user[n:]
        del bot[n:]

    def _reset_primary_audio_buffers(self) -> None:
        super()._reset_primary_audio_buffers()
        if self._carry_user or self._carry_bot:
            self._user_audio_buffer.extend(self._carry_user)
            self._bot_audio_buffer.extend(self._carry_bot)
            self._carry_user = self._carry_bot = b""

    async def stop_recording(self) -> None:
        # The last block pads as usual: nothing follows to carry into.
        self._stopping = True
        try:
            await super().stop_recording()
        finally:
            self._stopping = False
