"""Background sound for ``options.backgroundAudio``. See docs/background-audio.md.

Mirrors agents/livekit/lib/background-audio.ts: keep the option shape, the
levels and the gate rules in step with it and with
lib/background-audio-options.js.
"""

from __future__ import annotations

import asyncio
import math
import random
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

import numpy as np
from loguru import logger
from pipecat.audio.utils import is_silence
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    Frame,
    FunctionCallCancelFrame,
    FunctionCallResultFrame,
    FunctionCallsStartedFrame,
    InterruptionFrame,
    OutputAudioRawFrame,
    SpeechOutputAudioRawFrame,
    StartFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .fallback_message.wav import decode_wav

# Gains against the asset's -20 dBFS mean level: -46, -40 and -34 dBFS.
_VOLUME = {"low": 0.05, "medium": 0.10, "high": 0.20}
_WHEN = ("thinking", "silent", "always")
_MAX_DELAY_MS = 10000
_ASSET_DIR = Path(__file__).parent / "assets" / "background"
_ASSET_RATE = 16000
FADE_IN_SECS = 0.3
FADE_OUT_SECS = 0.12
# Backstop for the "turn ended, no reply yet" signal: a turn the model ignores
# would otherwise count as work for the rest of the call.
WORKING_MAX_SECS = 20.0
# Polled only while blocked, to see a transfer or the handover tone end.
_BLOCKED_POLL_SECS = 0.25
_RATE_POLL_SECS = 0.05
# States in which nothing is in flight. Any other state blocks the sound.
_IDLE_TRANSFER_STATES = ("none", "failed", "rejected")


@dataclass(frozen=True)
class BackgroundConfig:
    """Resolved settings. Not the public interface: see background_config_from_options."""

    sound: str = "office"
    volume: float = _VOLUME["medium"]
    when: str = "thinking"
    delay_ms: int = 600


def background_config_from_options(options: Any) -> Optional[BackgroundConfig]:
    """Parse ``options.backgroundAudio``: ``true``, or a dict with ``sound``,
    ``volume``, ``when`` and ``delayMs``. ``None`` when the option is off. Bad
    values fall back to the defaults or are clamped: save-time validation is
    the real check."""
    raw = options.get("backgroundAudio") if isinstance(options, dict) else None
    if raw is True:
        return BackgroundConfig()
    if not isinstance(raw, dict) or raw.get("enabled") is False:
        return None

    def lower(value: Any) -> str:
        return value.lower() if isinstance(value, str) else ""

    when = lower(raw.get("when"))
    delay = raw.get("delayMs")
    if isinstance(delay, bool) or not isinstance(delay, (int, float)) or not math.isfinite(delay):
        delay_ms = BackgroundConfig.delay_ms
    else:
        # floor(x + 0.5) rounds halves up, as Math.round does on the LiveKit side.
        delay_ms = int(math.floor(min(_MAX_DELAY_MS, max(0.0, float(delay))) + 0.5))
    return BackgroundConfig(
        sound="office",
        volume=_VOLUME.get(lower(raw.get("volume")), _VOLUME["medium"]),
        when=when if when in _WHEN else "thinking",
        delay_ms=delay_ms,
    )


class BackgroundGate:
    """The open/shut decision, with no I/O and the clock passed in.

    ``agent_audible``, ``transfer_state``, ``bridged``, ``handover_tone`` and
    ``ending`` are set by the caller before each :meth:`evaluate`.
    """

    def __init__(self, config: BackgroundConfig) -> None:
        self._config = config
        self.agent_audible = False
        self.user_speaking = False
        self.transfer_state = "none"
        self.bridged = False
        self.handover_tone = False
        self.ending = False
        self.initializing = True
        self._tools: set[str] = set()
        self._turn_ended_at: Optional[float] = None
        self._satisfied_since: Optional[float] = None

    def reconfigure(self, config: BackgroundConfig) -> None:
        self._config = config
        self._satisfied_since = None

    def note_user_speaking(self, speaking: bool, now: float) -> None:
        if self.user_speaking and not speaking:
            self._turn_ended_at = now
        self.user_speaking = speaking

    def note_agent_heard(self) -> None:
        self._turn_ended_at = None

    def tools_started(self, tool_call_ids: Iterable[str]) -> None:
        self._tools.update(tool_call_ids)

    def tool_finished(self, tool_call_id: str) -> None:
        self._tools.discard(tool_call_id)

    @property
    def blocked(self) -> bool:
        # A completed WebRTC bridge sets the transfer state back to "none", so
        # the bridge itself must block too, or the sound plays over a human.
        return (
            self.ending
            or self.bridged
            or self.handover_tone
            or self.transfer_state not in _IDLE_TRANSFER_STATES
        )

    def _working(self, now: float) -> bool:
        if self._tools:
            return True
        # Pipecat has no "thinking" state, so the reply gap is taken from the
        # caller's turn ending until agent audio is heard.
        return self._turn_ended_at is not None and now - self._turn_ended_at < WORKING_MAX_SECS

    def _satisfied(self, now: float) -> bool:
        if self._config.when == "always":
            return True
        if self._config.when == "silent":
            return not self.agent_audible
        return self._working(now) and not self.agent_audible and not self.user_speaking

    def evaluate(self, now: float) -> tuple[bool, Optional[float]]:
        """``(open, wait)``. While shut, ``wait`` is the seconds until
        ``delayMs`` has been held, or ``None`` if nothing is pending."""
        if self.blocked or self.initializing or not self._satisfied(now):
            self._satisfied_since = None
            return False, None
        delay = 0.0 if self._config.when == "always" else self._config.delay_ms / 1000.0
        if self._satisfied_since is None:
            self._satisfied_since = now
        held = now - self._satisfied_since
        if held >= delay:
            return True, 0.0
        return False, delay - held


_assets: dict[tuple[str, int, float], np.ndarray] = {}


def scaled_asset(sound: str, rate: int, volume: float) -> np.ndarray:
    """The sound at ``rate`` and ``volume`` as int16, shared by every call in
    the process. Blocking: call it in a thread the first time."""
    key = (sound, rate, volume)
    cached = _assets.get(key)
    if cached is not None:
        return cached
    decoded = decode_wav((_ASSET_DIR / f"{sound}-16k.wav").read_bytes())
    samples = np.frombuffer(decoded.pcm, dtype=np.int16).astype(np.float32)
    if decoded.sample_rate != rate:
        import soxr

        # Resample with the far end wrapped round each side, so the filter
        # sees a continuous signal and the loop seam stays free of a click.
        pad = min(len(samples), decoded.sample_rate // 10)
        padded = np.concatenate([samples[-pad:], samples, samples[:pad]])
        out = soxr.resample(padded, decoded.sample_rate, rate, quality="HQ")
        ratio = rate / decoded.sample_rate
        start = int(round(pad * ratio))
        samples = out[start : start + int(round(len(samples) * ratio))]
    scaled = np.clip(np.round(samples * volume), -32768, 32767).astype(np.int16)
    _assets[key] = scaled
    return scaled


class LoopReader:
    """Reads the pre-scaled sound in a loop, with a linear fade. Gain is applied
    per sample only while a fade runs; at full level a chunk is a slice copy."""

    def __init__(self, samples: np.ndarray, rate: int, pos: int = 0) -> None:
        self._samples = samples
        self._bytes = samples.tobytes()
        self.rate = rate
        self.pos = pos % len(samples)
        self.gain = 0.0
        self._target = 0.0
        self._in_step = 1.0 / (rate * FADE_IN_SECS)
        self._out_step = 1.0 / (rate * FADE_OUT_SECS)

    def set_samples(self, samples: np.ndarray) -> None:
        """Another volume of the same sound, at the same rate."""
        self._samples = samples
        self._bytes = samples.tobytes()
        self.pos %= len(samples)

    def set_open(self, open_: bool) -> None:
        self._target = 1.0 if open_ else 0.0

    @property
    def silent(self) -> bool:
        """Fully faded out with the gate shut: nothing left to send."""
        return self.gain == 0.0 and self._target == 0.0

    @property
    def _full(self) -> bool:
        return self.gain == 1.0 and self._target == 1.0

    def _take(self, n: int) -> np.ndarray:
        total = len(self._samples)
        end = self.pos + n
        if end <= total:
            out = self._samples[self.pos : end]
        else:
            out = np.concatenate([self._samples[self.pos :], np.resize(self._samples, end - total)])
        self.pos = end % total
        return out

    def _faded(self, n: int) -> np.ndarray:
        """The next ``n`` samples as float, with the fade stepped per sample."""
        segment = self._take(n).astype(np.float32)
        if self.gain == self._target:
            return segment * self.gain
        step = self._in_step if self._target > self.gain else -self._out_step
        gains = np.clip(self.gain + step * np.arange(1, n + 1, dtype=np.float64), 0.0, 1.0)
        # Snap the end: summed float steps stop just short of 0 or 1.
        last = float(gains[-1])
        self.gain = 1.0 if last > 1.0 - 1e-9 else 0.0 if last < 1e-9 else last
        return segment * gains.astype(np.float32)

    def chunk(self, n: int) -> bytes:
        """``n`` samples to send on their own."""
        if self._full:
            start = self.pos
            end = start + n
            total = len(self._samples)
            self.pos = end % total
            if end <= total:
                return self._bytes[2 * start : 2 * end]
            return self._bytes[2 * start :] + np.resize(self._samples, end - total).tobytes()
        return np.round(self._faded(n)).astype(np.int16).tobytes()

    def mix(self, audio: bytes) -> bytes:
        """``audio`` with the next samples of the sound added, clipped."""
        n = len(audio) // 2
        sound = self._take(n).astype(np.int32) if self._full else np.round(self._faded(n)).astype(np.int32)
        out = np.frombuffer(audio, dtype=np.int16, count=n).astype(np.int32) + sound
        np.clip(out, -32768, 32767, out=out)
        return out.astype(np.int16).tobytes()


class BackgroundAudioInjector(FrameProcessor):
    """Plays the background sound to this leg's caller.

    Sits after the rate guard (and the speech aligner) and before the cushion
    interrupt, the output audit tap and ``transport.output()``. In the gaps it
    pushes whole transport chunks of plain ``OutputAudioRawFrame`` at their
    deadlines; under agent audio it mixes into the passing frames. Never built
    when the option is off.
    """

    def __init__(
        self,
        config: BackgroundConfig,
        *,
        get_transfer_state: Callable[[], Any],
        is_bridged: Optional[Callable[[], bool]] = None,
        handover_tone_active: Optional[Callable[[], bool]] = None,
        is_ending: Optional[Callable[[], bool]] = None,
        output_transport: Any = None,
    ) -> None:
        super().__init__()
        self._config = config
        self._get_transfer_state = get_transfer_state
        self._is_bridged = is_bridged or (lambda: False)
        self._handover_tone_active = handover_tone_active or (lambda: False)
        self._is_ending = is_ending or (lambda: False)
        self._output_transport = output_transport
        self._gate = BackgroundGate(config)
        self._reader: Optional[LoopReader] = None
        self._task: Optional[asyncio.Task] = None
        self._wake = asyncio.Event()
        self._bot_speaking = False
        # When the agent audio already handed downstream finishes playing, and
        # when the last audible part of it does. Agent audio arrives faster
        # than real time, so these clocks, not frame arrival, say when it ends.
        self._queued_until = 0.0
        self._audible_until = 0.0
        self._open = False
        self._silenced = False
        self._plays = 0
        self._sent_chunks = 0

    def bind_output(self, output_transport: Any) -> None:
        self._output_transport = output_transport

    async def configure(self, config: Optional[BackgroundConfig]) -> None:
        """Apply the incoming agent's settings after an in-place handover.

        ``None`` (that agent has no option) fades the sound out and keeps it
        off. The processor stays in the pipeline, sending nothing.
        """
        self._silenced = config is None
        if config is not None and config != self._config:
            reader = self._reader
            if reader is not None and config.volume != self._config.volume:
                samples = await asyncio.to_thread(scaled_asset, config.sound, reader.rate, config.volume)
                reader.set_samples(samples)
            self._config = config
            self._gate.reconfigure(config)
        logger.info(
            f"background audio reconfigured: {'off' if config is None else config.when}"
        )
        self._wake_up()

    def _out_rate(self) -> Optional[int]:
        # The transport's own rate only: a frame at any other rate latches its
        # resampler and silences the call. See confidence_tone._out_rate.
        rate = getattr(self._output_transport, "sample_rate", None)
        return rate if isinstance(rate, int) and rate > 0 else None

    def _chunk_bytes(self) -> int:
        size = getattr(self._output_transport, "audio_chunk_size", 0)
        return size if isinstance(size, int) and size > 0 else 0

    def _wake_up(self) -> None:
        self._wake.set()

    # ---- Frames ----

    async def process_frame(self, frame: Frame, direction: FrameDirection) -> None:
        await super().process_frame(frame, direction)
        now = time.monotonic()

        if isinstance(frame, StartFrame):
            if self._task is None:
                self._task = self.create_task(self._run())
        elif isinstance(frame, (EndFrame, CancelFrame)):
            self._gate.ending = True
            await self._stop()
        elif isinstance(frame, UserStartedSpeakingFrame):
            self._gate.note_user_speaking(True, now)
            self._wake_up()
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self._gate.note_user_speaking(False, now)
            self._wake_up()
        elif isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
            self._wake_up()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            self._wake_up()
        elif isinstance(frame, FunctionCallsStartedFrame):
            self._gate.tools_started(fc.tool_call_id for fc in frame.function_calls)
            self._wake_up()
        elif isinstance(frame, (FunctionCallResultFrame, FunctionCallCancelFrame)):
            self._gate.tool_finished(frame.tool_call_id)
            self._wake_up()
        elif isinstance(frame, InterruptionFrame):
            # The transport drops its queued audio on an interruption.
            self._queued_until = now
            self._audible_until = now
            self._wake_up()
        elif (
            direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, OutputAudioRawFrame)
            and frame.audio
        ):
            frame = self._on_agent_audio(frame, now)

        await self.push_frame(frame, direction)

    def _on_agent_audio(self, frame: OutputAudioRawFrame, now: float) -> OutputAudioRawFrame:
        """Advance the playout clocks; mix the sound in if it is playing."""
        rate = frame.sample_rate or 0
        channels = frame.num_channels or 1
        if rate <= 0:
            return frame
        secs = len(frame.audio) / 2 / channels / rate
        self._queued_until = max(self._queued_until, now) + secs
        speech_stream = isinstance(frame, SpeechOutputAudioRawFrame)
        # A speech stream carries its silences too: those are not the agent talking.
        audible = not (speech_stream and is_silence(frame.audio))
        if audible:
            self._audible_until = self._queued_until
            self._gate.note_agent_heard()

        reader = self._reader
        if reader is None or rate != reader.rate or channels != 1:
            return frame
        reader.set_open(self._evaluate(now)[0])
        if reader.silent:
            return frame
        if not speech_stream:
            frame.audio = reader.mix(frame.audio)
            return frame
        if audible:
            # Speech: the sound only fades out under it (or plays on in always).
            frame.audio = reader.mix(frame.audio)
            return frame
        if self._bot_speaking:
            # The transport ends the bot's turn on silent speech frames. Mixed,
            # they would not be silent and the turn would never end.
            return frame
        # Silence in a speech stream, with the bot's turn over: carry the sound
        # in a plain frame, which the transport does not count as bot speech.
        out = OutputAudioRawFrame(audio=reader.mix(frame.audio), sample_rate=rate, num_channels=1)
        out.transport_destination = frame.transport_destination
        return out

    # ---- Gate ----

    def _evaluate(self, now: float) -> tuple[bool, Optional[float]]:
        gate = self._gate
        try:
            gate.transfer_state = getattr(self._get_transfer_state(), "state", "none") or "none"
        except Exception:  # noqa: BLE001
            gate.transfer_state = "unknown"
        gate.bridged = bool(self._is_bridged())
        gate.handover_tone = bool(self._handover_tone_active())
        gate.ending = gate.ending or bool(self._is_ending())
        gate.agent_audible = self._bot_speaking or now < self._audible_until
        open_, wait = (False, None) if self._silenced else gate.evaluate(now)
        if open_ != self._open:
            self._open = open_
            if open_:
                self._plays += 1
            logger.debug(f"background audio {'on' if open_ else 'off'} ({self._config.when})")
        return open_, wait

    def _idle_timeout(self, now: float, wait: Optional[float]) -> Optional[float]:
        # An open gate reports a wait of 0: that is not something to wait for.
        candidates = [wait] if wait else []
        if self._queued_until > now:
            candidates.append(self._queued_until - now)
        if self._audible_until > now:
            candidates.append(self._audible_until - now)
        if self._gate.blocked and not self._gate.ending:
            candidates.append(_BLOCKED_POLL_SECS)
        return max(0.001, min(candidates)) if candidates else None

    async def _idle(self, timeout: Optional[float]) -> None:
        self._wake.clear()
        try:
            await asyncio.wait_for(self._wake.wait(), timeout)
        except TimeoutError:
            pass

    # ---- Sending ----

    async def _prepare(self) -> Optional[LoopReader]:
        """Wait for the transport's rate, then load the sound at that rate."""
        while self._out_rate() is None or self._chunk_bytes() == 0:
            if self._gate.ending:
                return None
            await asyncio.sleep(_RATE_POLL_SECS)
        rate = self._out_rate()
        assert rate is not None
        cfg = self._config
        samples = await asyncio.to_thread(scaled_asset, cfg.sound, rate, cfg.volume)
        # A random start, so callers do not all hear the same few seconds.
        return LoopReader(samples, rate, random.randrange(len(samples)))

    async def _run(self) -> None:
        try:
            reader = await self._prepare()
        except Exception as e:  # noqa: BLE001
            # A missing or bad asset costs the sound, never the call.
            logger.error(f"background audio: not started: {e}")
            return
        if reader is None:
            return
        self._reader = reader
        self._gate.initializing = False
        logger.info(
            f"background audio ready: when={self._config.when} volume={self._config.volume} "
            f"delayMs={self._config.delay_ms} rate={reader.rate}"
        )
        next_deadline: Optional[float] = None
        while True:
            now = time.monotonic()
            open_, wait = self._evaluate(now)
            reader.set_open(open_)
            if reader.silent or now < self._queued_until:
                # Nothing to send, or agent audio queued that the sound would
                # delay: no ticker, no silence frames.
                next_deadline = None
                await self._idle(self._idle_timeout(now, wait))
                continue
            size = self._chunk_bytes()
            rate = self._out_rate()
            if size == 0 or rate != reader.rate:
                await asyncio.sleep(_RATE_POLL_SECS)
                continue
            chunk_secs = size / 2 / rate
            # Push each chunk at its deadline, not early: an early chunk queues
            # ahead of the agent's next speech and delays it.
            if next_deadline is None:
                next_deadline = now
            else:
                next_deadline += chunk_secs
                delay = next_deadline - now
                if delay > 0:
                    await asyncio.sleep(delay)
                else:
                    next_deadline = now
                now = time.monotonic()
                if now < self._queued_until:
                    continue
                reader.set_open(self._evaluate(now)[0])
                if reader.silent:
                    continue
            frame = OutputAudioRawFrame(audio=reader.chunk(size // 2), sample_rate=rate, num_channels=1)
            try:
                await self.push_frame(frame, FrameDirection.DOWNSTREAM)
                self._sent_chunks += 1
            except Exception as e:  # noqa: BLE001
                logger.warning(f"background audio: push_frame failed: {e}")

    async def _stop(self) -> None:
        if self._task is not None:
            await self.cancel_task(self._task)
            self._task = None
            if self._reader is not None:
                logger.info(f"background audio stopped: plays={self._plays} chunks={self._sent_chunks}")
