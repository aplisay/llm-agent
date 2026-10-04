"""Neuphonic TTS with the language code Neuphonic expects and each utterance's leading silence
trimmed. See docs/neuphonic.md."""

from __future__ import annotations

import base64
import json

import numpy as np
from pipecat.frames.frames import TTSAudioRawFrame
from pipecat.services.neuphonic.tts import NeuphonicTTSService
from pipecat.transcriptions.language import Language

#: Samples no louder than this are silence (about -44 dBFS). The hiss on the noisiest stock voices
#: peaks near 180.
SILENCE_THRESHOLD = 200
#: Audio kept before the first sample above the threshold, so a soft onset (s, f, h) is not clipped.
SILENCE_MARGIN_MS = 50


class LeadingSilenceTrimmer:
    """Drops the silence Neuphonic starts each utterance with (up to 1.7 s) from its 16-bit PCM.

    Audio is held until a sample is louder than SILENCE_THRESHOLD, then passed on from
    SILENCE_MARGIN_MS before it. Later silence is kept, and ``end()`` returns audio that never got
    that loud.
    """

    def __init__(self, sample_rate: int):
        self._margin = 2 * (sample_rate * SILENCE_MARGIN_MS // 1000)
        self._reset()

    def _reset(self) -> None:
        self._held = b""
        self._scanned = 0
        self._passing = False

    def push(self, audio: bytes) -> bytes:
        """The part of ``audio``, with anything held before it, that can be played now."""
        if self._passing:
            return audio
        self._held += audio
        # A chunk can end inside a sample; the scan waits for its second byte.
        end = len(self._held) - len(self._held) % 2
        if end <= self._scanned:
            return b""
        samples = np.frombuffer(self._held, dtype="<i2", count=(end - self._scanned) // 2, offset=self._scanned)
        loud = np.flatnonzero(np.abs(samples.astype(np.int32)) > SILENCE_THRESHOLD)
        if loud.size == 0:
            self._scanned = end
            return b""
        self._passing = True
        out = self._held[max(0, self._scanned + 2 * int(loud[0]) - self._margin) :]
        self._held = b""
        return out

    def end(self) -> bytes:
        """The end of the utterance: returns what is still held and starts afresh for the next one."""
        held = self._held
        self._reset()
        return held


class AplisayNeuphonicTTSService(NeuphonicTTSService):
    def language_to_service_language(self, language: Language) -> str | None:
        # Neuphonic takes lowercase base codes. Pipecat 1.10 maps Language.HI to "HI", which
        # Neuphonic accepts but does not speak as Hindi, and warns on every regional tag.
        return str(language.value).split("-")[0].lower()

    async def _receive_messages(self):
        # Pipecat's loop with each utterance trimmed; Neuphonic flags an utterance's last message
        # "stop". No stop_ttfb_metrics() here: TTSService stops TTFB at the first frame it plays,
        # so TTFA includes the time audio is held.
        websocket = self._websocket
        if websocket is None:
            return
        trimmer = LeadingSilenceTrimmer(self.sample_rate)
        async for message in websocket:
            if not isinstance(message, str):
                continue
            data = json.loads(message).get("data") or {}
            audio = trimmer.push(base64.b64decode(data["audio"])) if data.get("audio") else b""
            if data.get("stop"):
                audio += trimmer.end()
            if audio:
                context_id = self.get_active_audio_context_id()
                frame = TTSAudioRawFrame(audio, self.sample_rate, 1, context_id=context_id)
                await self.append_to_audio_context(context_id, frame)
