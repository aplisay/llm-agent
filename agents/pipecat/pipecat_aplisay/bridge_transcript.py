"""Transcription of the human↔human segment of a bridged transfer
(``options.bridgedTransferTranscribe``).

After a bridged transfer the AI has left the call, so nothing transcribes
the caller↔transfer-target conversation. When the option is set the worker
collects a speaker-labelled transcript of that segment without moving the
media off the gateway fast path:

- **voiceblender** runs its native per-leg STT (``POST /v1/legs/{id}/stt``)
  and the transcripts arrive as ``stt.text`` VSI events per leg;
- **sipbridge** streams a decoded stereo *copy* of the bridge on the
  kept-open monitor WS (``tap_audio`` — left = caller, right = target) and
  the worker runs one :class:`SttStream` per channel using the agent's
  configured STT vendor.

Either way the entries land in a :class:`BridgeTranscriptCollector`, which
posts each final utterance to the bridged-segment call record's transaction
log as it arrives (``user`` = caller, ``agent`` = transfer target — the
B-party occupies the agent slot of a two-party transcript) and renders the
merged history for the takeover agent's prompt. See ``bridged_transfer.py``
and ``docs/call-transfers.md``.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Optional

from loguru import logger

from . import api_client

CALLER = "caller"
TARGET = "transfer target"

_SPEAKER_LOG_TYPE = {CALLER: "user", TARGET: "agent"}


def parse_transcribe_option(options: Optional[dict]) -> Optional[dict]:
    """Normalise ``options.bridgedTransferTranscribe`` to ``None`` (off) or
    ``{"provider": str, "language": Optional[str]}``. Lenient — the server
    validated the shape at save time."""
    raw = (options or {}).get("bridgedTransferTranscribe")
    if raw is None or raw is False:
        return None
    if raw is True:
        return {"provider": "elevenlabs", "language": None}
    if not isinstance(raw, dict) or raw.get("enabled") is False:
        return None
    return {
        "provider": str(raw.get("provider") or "elevenlabs"),
        "language": raw.get("language"),
    }


@dataclass
class BridgeTranscriptCollector:
    """Accumulates final utterances from the two bridged humans.

    ``call`` is the bridged-segment call record the entries are logged
    against; ``stream_log`` mirrors the CallSession convention (live POST
    per entry vs batch flushed by ``end_call``).
    """

    call: api_client.CallRecord
    stream_log: bool = False
    _entries: list[tuple[float, str, str]] = field(default_factory=list)

    async def add(self, speaker: str, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        self._entries.append((time.monotonic(), speaker, text))
        entry = {
            "userId": self.call.userId,
            "organisationId": self.call.organisationId,
            "callId": self.call.id,
            "type": _SPEAKER_LOG_TYPE.get(speaker, "user"),
            "data": text,
            "isFinal": True,
        }
        if self.stream_log:
            try:
                await api_client.create_transaction_log(entry)
            except Exception as e:  # noqa: BLE001
                logger.warning(f"bridge transcript log post failed: {e}")
        else:
            self.call.batched_transaction_logs.append(entry)

    def render(self) -> str:
        """Merged, chronologically ordered ``> caller:`` / ``> transfer
        target:`` lines — same shape as ``${parentTranscript}``."""
        return "".join(
            f"> {speaker}: {text}\n" for _, speaker, text in sorted(self._entries)
        )

    def __len__(self) -> int:
        return len(self._entries)


class _TranscriptionCollector:
    """Terminal FrameProcessor for an :class:`SttStream` pipeline —
    forwards each final TranscriptionFrame's text to a callback."""

    def __new__(cls, on_final: Callable[[str], Awaitable[None]]):
        from pipecat.frames.frames import TranscriptionFrame
        from pipecat.processors.frame_processor import FrameProcessor

        class _Impl(FrameProcessor):
            def __init__(self) -> None:
                super().__init__()
                self._on_final = on_final

            async def process_frame(self, frame, direction):  # noqa: ANN001
                await super().process_frame(frame, direction)
                if isinstance(frame, TranscriptionFrame):
                    try:
                        await self._on_final(frame.text)
                    except Exception as e:  # noqa: BLE001
                        logger.warning(f"bridge transcript collect failed: {e}")
                await self.push_frame(frame, direction)

        return _Impl()


class SttStream:
    """A minimal STT-only Pipecat pipeline: feed PCM16 in, get final
    transcription text out via ``on_final``. One instance per bridged leg on
    the sipbridge topology (mono 16 kHz, the tap contract), and the side
    pipeline behind the auxiliary STT tap (``aux_stt.py``), which starts it at
    the call's own input format."""

    def __init__(
        self,
        stt_service: Any,
        on_final: Callable[[str], Awaitable[None]],
        *,
        sample_rate: int = 16000,
        num_channels: int = 1,
    ) -> None:
        self._stt = stt_service
        self._collector = _TranscriptionCollector(on_final)
        self._sample_rate = sample_rate
        self._num_channels = num_channels
        self._task: Optional[Any] = None
        self._runner_task: Optional[asyncio.Task] = None

    async def start(self) -> None:
        from pipecat.pipeline.pipeline import Pipeline
        from pipecat.pipeline.runner import PipelineRunner
        from pipecat.pipeline.task import PipelineParams, PipelineTask

        pipeline = Pipeline([self._stt, self._collector])
        # F1: this is an STT-only side pipeline — no VAD, no bot — so it
        # never emits the Bot/UserSpeakingFrames pipecat's idle watchdog
        # counts. With the framework default (idle_timeout_secs=300,
        # cancel_on_idle_timeout=True) it cancelled itself five minutes
        # in, and aux/output transcription silently stopped on exactly
        # the long calls most worth transcribing.
        self._task = PipelineTask(
            pipeline,
            params=PipelineParams(
                audio_in_sample_rate=self._sample_rate,
                audio_out_sample_rate=self._sample_rate,
            ),
            idle_timeout_secs=None,
        )
        runner = PipelineRunner(handle_sigint=False)
        self._runner_task = asyncio.create_task(runner.run(self._task))

    async def feed(self, pcm16: bytes) -> None:
        if self._task is None or not pcm16:
            return
        from pipecat.frames.frames import InputAudioRawFrame

        await self._task.queue_frames(
            [
                InputAudioRawFrame(
                    audio=pcm16,
                    sample_rate=self._sample_rate,
                    num_channels=self._num_channels,
                )
            ]
        )

    async def stop(self) -> None:
        task = self._task
        self._task = None
        if task is not None:
            try:
                await task.cancel()
            except Exception as e:  # noqa: BLE001
                logger.debug(f"SttStream cancel raised: {e}")
        if self._runner_task is not None:
            try:
                await asyncio.wait_for(self._runner_task, timeout=5.0)
            except (asyncio.TimeoutError, asyncio.CancelledError):
                pass
            except Exception as e:  # noqa: BLE001
                logger.debug(f"SttStream runner exit raised: {e}")
            self._runner_task = None


def split_stereo(audio: bytes) -> tuple[bytes, bytes]:
    """De-interleave s16le stereo into (left, right) mono byte strings.
    Left = caller, right = transfer target (the sipbridge tap contract).

    Strided memoryview slicing rather than a Python loop (P9): this runs
    once per 20 ms frame per bridged call, and the loop body was four
    slice assignments per sample — 320 iterations a frame, 50 frames a
    second, on the event loop.
    """
    if len(audio) < 4:
        return b"", b""
    usable = len(audio) - (len(audio) % 4)
    # cast("h") requires the buffer length to be a multiple of the item
    # size, so trim to whole frames first.
    samples = memoryview(audio)[:usable].cast("h")
    return samples[0::2].tobytes(), samples[1::2].tobytes()
