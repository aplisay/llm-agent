"""Fixed-message failover for Pipecat — ``options.fallback.message``.

Sits between ``fallback.model`` and ``fallback.number`` in the failover chain
(see ``docs/agent-failover.md``): when the agent could not be brought up, play
the operator's announcement at the caller rather than leaving them in dead air
or sending them straight to a transfer.

Two properties shape everything here.

**The audio is cached, so playout makes no vendor call.** The announcement
cannot vary for a given configuration, so it is synthesised once, stored in GCS
keyed by a digest of its own content, and replayed from then on. That is not
just a latency win: a cache hit calls no TTS vendor, so it meters no usage, so
it needs no ``Call`` record, so it never reserves an agent concurrency slot.
Which matters enormously, because the single most useful moment to play a fixed
message is when the concurrency limiter is what rejected the call — a playout
that took a slot would defeat the feature it implements. See
``lib/fallback-message/CONTRACT.md``.

**This path runs when things are already broken**, and often when the host is
loaded — load being one of the likelier reasons a session failed to start. So
it stays cheap and it never raises: every failure degrades to "the caller does
not get the announcement", leaving the chain free to try ``fallback.number``,
rather than turning one failure into two.

Mirrors ``agents/livekit/lib/fallback-message.ts`` — keep the resolution rules
and playout semantics in step across stacks. The one deliberate difference is
on a cache miss: LiveKit collects the whole utterance and then plays it, while
here the TTS is spliced into the playout pipeline and the caller hears it as it
renders, with a tap capturing the audio for the write-back. Pipecat's streaming
TTS services deliver audio out of band (``run_tts`` yields ``None`` and the
frames arrive on a separate receive loop), so a pipeline is required to capture
them at all; getting the lower latency for free is why this shape is kept.
"""

from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
from typing import Any, Optional

from loguru import logger
from pipecat.frames.frames import (
    EndFrame,
    Frame,
    OutputAudioRawFrame,
    TTSAudioRawFrame,
    TTSSpeakFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineTask
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .fallback_message import (
    ResolvedFallbackMessage,
    decode_wav,
    encode_wav,
    fallback_message_key,
    fetch_cached_message,
    resolve_fallback_message,
    store_cached_message,
)
from .output_rate_guard import OutputRateGuard

#: Chunk size for replaying cached audio. 20 ms is the SIP convention.
_FRAME_MS = 20

#: Hard ceiling on the whole step, so a hung vendor or a stalled transport
#: cannot pin a failed call open. The caller is already waiting on a call that
#: did not work; give up and let the chain move on to ``fallback.number``.
_PLAYOUT_TIMEOUT_SECS = 45.0


@dataclass(frozen=True)
class FixedMessageAudio:
    pcm: bytes
    sample_rate: int
    #: True when this came from GCS rather than a fresh vendor call.
    cached: bool


class _AudioTap(FrameProcessor):
    """Pass-through processor that copies rendered TTS audio into a buffer.

    Placed immediately after the TTS service and *before* the rate guard, so it
    captures the vendor's native sample rate rather than the transport's. The
    contract stores whatever the TTS emitted (see CONTRACT.md), which keeps the
    cached object independent of the transport that happened to render it first
    — a 16 kHz SIP leg and a 24 kHz WebRTC session share one cache entry.
    """

    def __init__(self) -> None:
        super().__init__()
        self._chunks: list[bytes] = []
        self._sample_rate: Optional[int] = None

    @property
    def audio(self) -> Optional[FixedMessageAudio]:
        if not self._chunks or not self._sample_rate:
            return None
        return FixedMessageAudio(
            pcm=b"".join(self._chunks), sample_rate=self._sample_rate, cached=False
        )

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        if isinstance(frame, (TTSAudioRawFrame, OutputAudioRawFrame)) and frame.audio:
            # Mono is assumed throughout; a stereo TTS would be captured wrong,
            # but no supported vendor renders stereo speech.
            if self._sample_rate is None:
                self._sample_rate = frame.sample_rate
            if frame.sample_rate == self._sample_rate:
                self._chunks.append(bytes(frame.audio))
        await self.push_frame(frame, direction)


def fixed_message_for(agent: dict) -> Optional[ResolvedFallbackMessage]:
    """Resolve ``options.fallback.message``, or ``None`` when unconfigured.

    A realtime agent's ``options.tts`` describes the model's own voice, not a
    TTS, so its vendor/voice are not inherited — see
    :func:`resolve_fallback_message`. Keep this decision identical to LiveKit's
    ``fallbackMessageFor``: it feeds the cache key, and disagreeing would split
    the shared cache in two.
    """
    from .voice_mode import resolve_voice_mode

    options = agent.get("options") or {}
    fallback = options.get("fallback") or {}
    inherit = resolve_voice_mode(agent.get("modelName") or "", options) == "pipeline"
    return resolve_fallback_message(
        fallback.get("message"), options, inherit_agent_tts=inherit
    )


def _build_message_tts(agent: dict, resolved: ResolvedFallbackMessage) -> Any:
    """Build a TTS service for the announcement.

    The message may name its own ``vendor``/``voice``/``language`` — the whole
    point being that it can be spoken by a stack known to work when the agent's
    own is what just failed. Rather than reimplement vendor selection, we hand
    ``build_tts_service`` a *synthetic agent* whose ``options.tts`` carries the
    message's resolved settings. Every vendor the pipeline supports is therefore
    supported here for free, and stays supported as vendors are added, with no
    second catalogue to keep in step.
    """
    from .voice_session import build_tts_service

    options = dict(agent.get("options") or {})
    tts_opts = dict(options.get("tts") or {})
    if resolved.vendor:
        tts_opts["vendor"] = resolved.vendor
    if resolved.voice:
        tts_opts["voice"] = resolved.voice
    if resolved.language:
        tts_opts["language"] = resolved.language
    options["tts"] = tts_opts

    synthetic = dict(agent)
    synthetic["options"] = options
    return build_tts_service(synthetic)


def _audio_frames(audio: FixedMessageAudio) -> list[OutputAudioRawFrame]:
    """Slice cached PCM into transport-sized frames."""
    bytes_per_frame = int(audio.sample_rate * _FRAME_MS / 1000) * 2  # 16-bit mono
    return [
        OutputAudioRawFrame(
            audio=audio.pcm[offset : offset + bytes_per_frame],
            sample_rate=audio.sample_rate,
            num_channels=1,
        )
        for offset in range(0, len(audio.pcm), bytes_per_frame)
    ]


async def run_fixed_message(transport: Any, agent: dict) -> bool:
    """Play the agent's fixed announcement on ``transport``.

    Returns True when the caller heard it. False means the chain should carry
    on to ``fallback.number`` exactly as if no message were configured.

    Never raises.
    """
    resolved = fixed_message_for(agent)
    if not resolved:
        return False

    logger.bind(
        vendor=resolved.vendor, voice=resolved.voice, chars=len(resolved.text)
    ).info("playing fixed fallback message")

    # P10: run the playout as a task and judge it on the clock, rather
    # than relying on ``wait_for`` to raise. Since Python 3.12 wait_for
    # resumes the cancelled coroutine inline and returns ITS result if it
    # completes — and ``WorkerRunner.run`` swallows the CancelledError,
    # so it always did. The timeout branch below was therefore
    # unreachable and a playout that overran was reported as a success,
    # which in the fallback chain means "the caller heard the
    # announcement" when they may not have.
    task = asyncio.ensure_future(_play(transport, agent, resolved))
    done, _pending = await asyncio.wait({task}, timeout=_PLAYOUT_TIMEOUT_SECS)
    if not done:
        logger.warning(
            f"fixed fallback message timed out after {_PLAYOUT_TIMEOUT_SECS}s"
        )
        task.cancel()
        # Let the cancellation land, but never wait on it here — this
        # runs on the caller's setup-failure path.
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await asyncio.wait({task}, timeout=1.0)
        return False
    try:
        return task.result()
    except asyncio.CancelledError:
        return False
    except Exception as e:  # noqa: BLE001
        logger.error(f"fixed fallback message failed: {e}")
        return False


async def _play(transport: Any, agent: dict, resolved: ResolvedFallbackMessage) -> bool:
    key = fallback_message_key(resolved)
    cached_bytes = await fetch_cached_message(key)

    audio: Optional[FixedMessageAudio] = None
    if cached_bytes:
        try:
            decoded = decode_wav(cached_bytes)
            audio = FixedMessageAudio(
                pcm=decoded.pcm, sample_rate=decoded.sample_rate, cached=True
            )
        except Exception as e:  # noqa: BLE001
            # A corrupt object must not condemn the caller to silence: fall
            # through and re-synthesise. The bad object stays until something
            # overwrites or expires it, which is harmless — the store is
            # content-addressed, so the next writer produces identical audio.
            logger.warning(f"cached fallback message failed to decode; re-synthesising: {e}")

    # Defence in depth against the transport's latching resampler: every frame
    # reaching output() carries the transport's own rate, so a cached object at
    # some other rate cannot silence the leg. See output_rate_guard.py, which
    # names this exact case ("a fallback TTS voice").
    rate_guard = OutputRateGuard(output_transport=transport.output())

    tap: Optional[_AudioTap] = None
    if audio is not None:
        processors: list = [rate_guard, transport.output()]
        frames: list = _audio_frames(audio)
    else:
        tap = _AudioTap()
        processors = [_build_message_tts(agent, resolved), tap, rate_guard, transport.output()]
        frames = [TTSSpeakFrame(resolved.text)]

    # F1: the framework's 300 s idle watchdog stays on. This playout is
    # bounded far more tightly by run_fixed_message's own ceiling, and it
    # was never one of the cases the watchdog broke — only the STT-only
    # and relay-only side pipelines opt out.
    task = PipelineTask(Pipeline(processors))
    # EndFrame is queued behind the audio, so it reaches the output transport
    # only after everything ahead of it has been rendered — the graceful
    # termination pattern, which is what stops the announcement being cut off.
    await task.queue_frames([*frames, EndFrame()])
    await PipelineRunner(handle_sigint=False).run(task)

    if tap is not None:
        fresh = tap.audio
        if fresh is None or not fresh.pcm:
            logger.error("fixed fallback message synthesis produced no audio")
            return False
        # Write back after the caller has been served, never before: they are
        # already holding a failed call and must not wait on GCS. A lost write
        # just means the next call re-synthesises.
        await store_cached_message(key, encode_wav(fresh.pcm, fresh.sample_rate))
        logger.bind(size=len(fresh.pcm), sample_rate=fresh.sample_rate).info(
            "fixed fallback message synthesised and played"
        )
        return True

    logger.bind(
        size=len(audio.pcm) if audio else 0,
        sample_rate=audio.sample_rate if audio else 0,
        cached=True,
    ).info("fixed fallback message played")
    return True
