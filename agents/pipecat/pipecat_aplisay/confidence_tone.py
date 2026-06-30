"""Confidence tone for call transfers — see docs/call-transfers.md.

While a transfer is in flight the caller would otherwise hear dead air: a
blind transfer spends seconds dialling the target before the REFER completes
or the bridged media comes up, and a consultative transfer parks the caller
while the TransferAgent talks to the target on a separate leg. The confidence
tone fills those gaps with a periodic comfort beep so the caller knows the
call is still alive.

Enabled per-agent via ``options.transferTone`` (``true`` or an object — see
:func:`tone_config_from_options`). When unset, nothing here is built and the
pipeline is byte-for-byte unchanged.

Mechanism: :class:`ConfidenceToneInjector` is a ``FrameProcessor`` spliced
into the **caller's** pipeline just before the relay injector /
``transport.output()``. A paced generator task synthesises 20 ms PCM chunks
of a sine-burst pattern and pushes them downstream as
``OutputAudioRawFrame``s. It is armed by ``CallSession`` when a transfer
starts and derives play/stop from the session's ``transfer_state`` (the one
source of truth every transfer path — gateway, WebRTC relay, consult
accept/reject, consult-leg death in worker.py — already updates):

  - ``blind``  → tone while state == "dialling" (stops the moment the REFER
    is accepted / the bridged media is up, both of which leave "dialling").
  - ``consult`` → tone while state in {"dialling", "talking"} (the whole
    consultation), but ONLY in the gaps when neither the caller nor the
    local bot is audibly speaking — the agent can still converse with the
    caller mid-consult and the tone must not stamp on that.

Speaking detection is frame-driven: ``UserStarted/StoppedSpeakingFrame``
(VAD, flowing downstream from the input transport) and
``BotStarted/StoppedSpeakingFrame`` (emitted by the output transport, seen
here travelling upstream). A configurable quiet "grace" window after the last
speech keeps the tone from blipping into normal turn-taking pauses.

Tone frames are pushed at the same sample rate the local bot's own audio uses
(learned from passing ``OutputAudioRawFrame``s, exactly like
``media_relay._RelayInjector``) because the output transport's resampler
locks onto the first input rate it sees and rejects changes.
"""

from __future__ import annotations

import asyncio
import math
import time
from dataclasses import dataclass
from typing import Any, Callable, Optional

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    CancelFrame,
    EndFrame,
    Frame,
    OutputAudioRawFrame,
    StartFrame,
    UserStartedSpeakingFrame,
    UserStoppedSpeakingFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

# 20 ms chunks — matches typical transport frame sizing.
_CHUNK_SECS = 0.02
# Fallback when no bot audio has been seen yet (telephony-standard 16 kHz,
# the rate every SIP gateway transport here runs at).
_DEFAULT_SAMPLE_RATE = 16000
# Backstop for handover mode: a full-stack agent handover normally completes
# (incoming agent's first BotStartedSpeakingFrame) within a few seconds. If
# the new agent never speaks — a stuck/failed continuation — cap the comfort
# tone so the caller isn't beeped at indefinitely.
_HANDOVER_MAX_SECS = 25.0


# The public ``options.transferTone`` interface is deliberately coarse — the
# tone *shape* (pitch, burst length, volume) is chosen from small discrete sets
# rather than free-form Hz/ms/amplitude. Only the silence timings
# (``gapMs``/``graceMs``) are continuous. This keeps the set of possible
# on-bursts tiny (one per frequency×length×volume combination) so the live sine
# generator below can later be swapped for a lookup of pre-generated PCM tone
# tables without any change to the agent-facing config. Keep these maps in sync
# with the LiveKit worker (agents/livekit/lib/confidence-tone.ts) and the
# validation in lib/database.js.
# NB: avoid telephony call-progress frequencies — 425 Hz (the old ``medium``)
# is the UK/EU network dial/busy/ring tone, a poor "still connected" signal —
# and the DTMF bands (697-941 / 1209-1633). 523/587/659 sit clear of both.
# Keep in sync with agents/livekit/lib/confidence-tone.ts.
_FREQUENCY_HZ = {"low": 523.0, "medium": 587.0, "high": 659.0}
_LENGTH_MS = {"short": 150, "medium": 250, "long": 400}
# ``medium`` of everything is the discreet UK-style comfort beep.
_VOLUME = {"low": 0.08, "medium": 0.15, "high": 0.30}  # linear amplitude, 0..1


@dataclass
class ToneConfig:
    """Resolved, internal tone parameters consumed by the generator.

    Not the public interface — :func:`tone_config_from_options` maps the
    coarse ``options.transferTone`` shorthand (``frequency``/``length``/
    ``volume`` enums + ``gapMs``/``graceMs``) onto these numeric values. The
    defaults give a discreet comfort beep: a 250 ms 587 Hz burst
    every ~3 s at low volume.
    """

    frequency: float = 587.0  # Hz (from the `frequency` enum)
    on_ms: int = 250  # burst length (from the `length` enum)
    off_ms: int = 2750  # silence between bursts (from `gapMs`)
    volume: float = _VOLUME["medium"]  # linear amplitude, 0..1 (from the `volume` enum)
    grace_ms: int = 1200  # quiet time required after speech before tone (`graceMs`)


def tone_config_from_options(options: Any) -> Optional[ToneConfig]:
    """Parse ``options.transferTone`` into a :class:`ToneConfig`.

    Accepts ``true`` (all defaults) or an object with any of:

    - ``frequency`` — one of ``"low"`` / ``"medium"`` / ``"high"``
    - ``length`` — one of ``"short"`` / ``"medium"`` / ``"long"``
    - ``volume`` — one of ``"low"`` / ``"medium"`` / ``"high"``
    - ``gapMs`` — silence between bursts, milliseconds
    - ``graceMs`` — quiet time after speech before the tone (re)starts, ms

    ``enabled: false`` (or any non-dict/non-``true`` value) disables the
    feature. Unrecognised enum values fall back to ``"medium"`` and
    out-of-range numbers are clamped — agent save-time validation in
    lib/database.js is the authoritative gate; the worker just refuses to
    produce something unplayable.
    """
    raw = (options or {}).get("transferTone") if isinstance(options, dict) else None
    if raw is True:
        return ToneConfig()
    if not isinstance(raw, dict) or raw.get("enabled") is False:
        return None

    def _enum(key: str, table: dict, default: str):
        value = raw.get(key)
        if isinstance(value, str) and value.lower() in table:
            return table[value.lower()]
        return table[default]

    def _num(key: str, default: float, lo: float, hi: float) -> float:
        value = raw.get(key)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return default
        return min(hi, max(lo, float(value)))

    return ToneConfig(
        frequency=_enum("frequency", _FREQUENCY_HZ, "medium"),
        on_ms=int(_enum("length", _LENGTH_MS, "medium")),
        off_ms=int(_num("gapMs", 2750, 0, 60000)),
        volume=_enum("volume", _VOLUME, "medium"),
        grace_ms=int(_num("graceMs", 1200, 0, 30000)),
    )


class ConfidenceToneInjector(FrameProcessor):
    """Plays the confidence tone to this leg's speaker while a transfer is
    in flight.

    Passive passthrough until :meth:`arm` is called; fully inert (never even
    constructed) when ``options.transferTone`` is unset. Sits upstream of the
    media-relay injector, so if a WebRTC relay engages mid-burst the relay
    drops our frames along with the bot's — the caller never hears tone over
    bridged audio even before the state machine catches up.
    """

    def __init__(
        self,
        config: ToneConfig,
        *,
        get_transfer_state: Callable[[], Any],
    ):
        super().__init__()
        self._config = config
        # Returns the owning CallSession's TransferState (``.state`` str).
        self._get_transfer_state = get_transfer_state
        self._mode: Optional[str] = None  # None | "blind" | "consult"
        # True while covering a full-stack agent-to-agent handover gap. In this
        # mode play is gated only by speech grace, NOT by the transfer state
        # machine (there is no transfer; CallSession drives start via
        # ``arm_handover`` and the incoming agent's first speech stops it).
        self._handover = False
        self._handover_started_at = 0.0
        self._user_speaking = False
        self._bot_speaking = False
        # Last time either party was (still) speaking — the grace window
        # gates tone start on quiet since this stamp.
        self._last_voice = 0.0
        # Sample rate the local output transport is locked to, learned from
        # the bot's own audio frames (see module docstring). None until seen.
        self._dst_rate: Optional[int] = None
        self._generator: Optional[asyncio.Task] = None
        # Sample position within the on/off burst cycle, kept across chunks
        # for phase continuity; reset whenever playback (re)starts.
        self._cycle_pos = 0

    # ---- Control surface (called by CallSession) ----

    def arm(self, mode: str) -> None:
        """Start tone service for a transfer. ``mode`` is ``"blind"`` or
        ``"consult"``; see module docstring for the play conditions. Call
        AFTER the session's transfer_state has moved to "dialling"."""
        self._mode = mode
        self._cycle_pos = 0
        # Treat arming as "voice just stopped": the agent has usually just
        # announced the transfer, and its BotStoppedSpeaking may not have
        # arrived yet. The grace window keeps the tone off its heels.
        self._last_voice = time.monotonic()
        logger.bind(mode=mode).info("confidence tone armed")

    def disarm(self) -> None:
        if self._mode is not None:
            logger.bind(mode=self._mode).info("confidence tone disarmed")
        self._mode = None
        self._handover = False

    def arm_handover(self) -> None:
        """Start the comfort tone to cover the dead-air gap of a full-stack
        agent-to-agent handover (the outgoing agent's pipeline is torn down and
        the incoming agent's model stack spins up — several seconds of
        silence). Play is gated only by speech grace here; the tone stops on the
        incoming agent's first ``BotStartedSpeakingFrame`` (see
        :meth:`process_frame`) or the max-duration backstop. Call on the freshly
        built injector of the continuation pipeline."""
        self._handover = True
        # ``_mode`` is the "armed" sentinel the generator guards check; the
        # actual play condition is the handover branch in ``_should_play``.
        self._mode = "blind"
        self._cycle_pos = 0
        self._handover_started_at = time.monotonic()
        # Grace: the outgoing agent usually just spoke (e.g. "putting you
        # through") before the pipeline swap.
        self._last_voice = time.monotonic()
        logger.info("confidence tone started for agent handover")

    # ---- Frame plumbing ----

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if isinstance(frame, StartFrame):
            if self._dst_rate is None:
                # Provisional until the first bot frame teaches us better.
                rate = getattr(frame, "audio_out_sample_rate", None)
                if isinstance(rate, int) and rate > 0:
                    self._dst_rate = rate
            if self._generator is None:
                self._generator = self.create_task(self._run())
        elif isinstance(frame, (EndFrame, CancelFrame)):
            self.disarm()
            if self._generator is not None:
                await self.cancel_task(self._generator)
                self._generator = None

        if isinstance(frame, UserStartedSpeakingFrame):
            self._user_speaking = True
            self._last_voice = time.monotonic()
        elif isinstance(frame, UserStoppedSpeakingFrame):
            self._user_speaking = False
            self._last_voice = time.monotonic()
        elif isinstance(frame, BotStartedSpeakingFrame):
            self._bot_speaking = True
            self._last_voice = time.monotonic()
            if self._handover:
                # The incoming agent has produced audio — the handover gap is
                # over. Stop the comfort tone (the new agent is now speaking).
                logger.info("confidence tone stopped (agent handover complete)")
                self.disarm()
        elif isinstance(frame, BotStoppedSpeakingFrame):
            self._bot_speaking = False
            self._last_voice = time.monotonic()
        elif (
            direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, OutputAudioRawFrame)
        ):
            # The local bot's rendered audio (our own frames are pushed by
            # the generator task and never re-enter process_frame). Learn
            # the rate the output transport locks onto, and treat in-flight
            # bot audio as "voice" in case Bot*SpeakingFrames are late.
            self._dst_rate = frame.sample_rate
            self._last_voice = time.monotonic()

        await self.push_frame(frame, direction)

    # ---- Tone state ----

    def _should_play(self) -> bool:
        if self._mode is None:
            return False
        if self._handover:
            # Handover backstop: the incoming agent never signalled speaking.
            if (time.monotonic() - self._handover_started_at) > _HANDOVER_MAX_SECS:
                self.disarm()
                return False
            # Otherwise fall straight through to the speech-grace gate below:
            # play continuously until the incoming agent first speaks.
        else:
            try:
                state = getattr(self._get_transfer_state(), "state", None)
            except Exception:  # noqa: BLE001
                return False
            if self._mode == "blind":
                # Tone strictly while placing the transfer; leaving "dialling"
                # (talking = media up / refer done, failed, none) ends service.
                if state != "dialling":
                    self.disarm()
                    return False
            else:  # consult
                if state in ("none", "failed", "rejected"):
                    self.disarm()
                    return False
                if state not in ("dialling", "talking"):
                    return False
        if self._user_speaking or self._bot_speaking:
            self._cycle_pos = 0
            return False
        if (time.monotonic() - self._last_voice) * 1000.0 < self._config.grace_ms:
            self._cycle_pos = 0
            return False
        return True

    def _make_chunk(self, rate: int, samples: int) -> bytes:
        """Next ``samples`` of the burst cycle as s16le mono PCM."""
        cfg = self._config
        on_samples = int(rate * cfg.on_ms / 1000.0)
        cycle_samples = max(1, on_samples + int(rate * cfg.off_ms / 1000.0))
        amp = cfg.volume * 32767.0
        omega = 2.0 * math.pi * cfg.frequency / rate
        out = bytearray(samples * 2)
        pos = self._cycle_pos
        for i in range(samples):
            p = (pos + i) % cycle_samples
            if p < on_samples:
                # Short linear fade at the burst edges to avoid clicks.
                edge = min(p, on_samples - 1 - p)
                ramp = min(1.0, edge / (rate * 0.005))
                value = int(amp * ramp * math.sin(omega * p))
                out[2 * i] = value & 0xFF
                out[2 * i + 1] = (value >> 8) & 0xFF
        self._cycle_pos = (pos + samples) % cycle_samples
        return bytes(out)

    async def _run(self) -> None:
        """Paced generator: every 20 ms of wall clock, push 20 ms of tone
        when the play conditions hold. Deadline-based so drift doesn't
        accumulate into audio backlog at the transport."""
        next_deadline = time.monotonic()
        while True:
            next_deadline += _CHUNK_SECS
            delay = next_deadline - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            else:
                # We fell behind (e.g. event-loop stall); resynchronise
                # rather than bursting catch-up audio.
                next_deadline = time.monotonic()
            if not self._should_play():
                continue
            rate = self._dst_rate or _DEFAULT_SAMPLE_RATE
            samples = int(rate * _CHUNK_SECS)
            audio = self._make_chunk(rate, samples)
            try:
                await self.push_frame(
                    OutputAudioRawFrame(
                        audio=audio, sample_rate=rate, num_channels=1
                    ),
                    FrameDirection.DOWNSTREAM,
                )
            except Exception as e:  # noqa: BLE001
                logger.warning(f"confidence tone: push_frame failed: {e}")
