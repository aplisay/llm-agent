"""Worker-side media relay for WebRTC-origin transfers.

The native per-gateway bridges (sipbridge ``dial_bridge``, voiceblender room
join, FreeSWITCH ``uuid_bridge``) relay RTP *inside* a single SIP gateway,
between two SIP legs in the same media plane. A WebRTC caller has no SIP leg:
their media terminates in the worker's ``SmallWebRTCTransport``. So when such a
caller transfers to a telephony endpoint, the bridge has to happen in the **one
place both media endpoints exist** — the worker.

This module provides that bridge as a pair of Pipecat ``FrameProcessor``s spliced
into each leg's pipeline (see ``voice_session.build_voice_session`` /
``build_relay_only_task``):

  - ``RelayEndpoint.tap``    sits just after ``transport.input()``. While engaged
    it forwards this leg's microphone audio to the peer leg's speaker and stops
    that audio reaching the rest of the local pipeline (so the local bot's
    STT/LLM go idle — the agent "steps aside").
  - ``RelayEndpoint.inject`` sits just before ``transport.output()``. While
    engaged it drops the local bot's rendered audio (so the agent is silent) and
    emits the peer leg's audio to this leg's speaker.

Crucially, **nothing is torn down** to install the relay: both pipelines keep
running, so the ``SmallWebRTCTransport`` peer connection (which disconnects on
EndFrame/CancelFrame — see ``SmallWebRTCInputTransport.stop``) stays up. Engaging
the relay is just flipping a flag and pointing two endpoints at each other.

Audio crosses as raw PCM ``OutputAudioRawFrame``s carrying their source sample
rate; the destination ``transport.output()`` resamples to its own rate (see
``base_output``’s ``handle_audio_frame``). That means the Opus-48k (browser) ↔
G.711-8k (telephony) mismatch is handled for free at the sink — unlike the
same-family-G.711-only native gateway bridge.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from loguru import logger
from pipecat.audio.resamplers.soxr_resampler import SOXRAudioResampler
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


def _peak(audio: bytes) -> int:
    """Peak absolute s16le sample in ``audio`` — a cheap signal-vs-silence probe
    for diagnostics (≈0 means the frame is silence). Returns -1 if unparseable."""
    if not audio:
        return 0
    try:
        return max((abs(s) for s in memoryview(audio).cast("h")), default=0)
    except (ValueError, TypeError):
        return -1


class _RelayTap(FrameProcessor):
    """Captures this leg's inbound mic audio for the peer leg.

    While the owning endpoint is engaged, inbound ``InputAudioRawFrame``s are
    forwarded to the peer's injector and **not** pushed downstream (so the
    local STT/LLM stop seeing audio). Everything else — system frames, control
    frames, audio when not engaged — passes through untouched.
    """

    def __init__(self, endpoint: "RelayEndpoint"):
        super().__init__()
        self._endpoint = endpoint
        self._fwd_count = 0

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        if (
            self._endpoint.engaged
            and direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, InputAudioRawFrame)
        ):
            peer = self._endpoint.peer
            if peer is not None:
                # Re-wrap as an OutputAudioRawFrame carrying the *source* sample
                # rate; the peer's transport.output() resamples to its own rate.
                await peer.inject.feed(
                    OutputAudioRawFrame(
                        audio=frame.audio,
                        sample_rate=frame.sample_rate,
                        num_channels=frame.num_channels,
                    )
                )
                self._fwd_count += 1
                if self._fwd_count == 1 or self._fwd_count % 100 == 0:
                    logger.info(
                        f"relay tap[{self._endpoint.name}->{peer.name}]: "
                        f"forwarded {self._fwd_count} frames "
                        f"rate={frame.sample_rate} peak={_peak(frame.audio)}"
                    )
            # Swallow: do not drive the local bot while relaying.
            return

        await self.push_frame(frame, direction)


class _RelayInjector(FrameProcessor):
    """Emits the peer leg's audio to this leg's speaker.

    A reader task drains an internal queue (fed by the peer's ``_RelayTap``) and
    pushes the audio downstream to ``transport.output()``. While engaged it also
    drops the local bot's rendered ``OutputAudioRawFrame``s arriving from
    upstream, so the agent is silent and only the relayed audio is heard.
    """

    def __init__(self, endpoint: "RelayEndpoint"):
        super().__init__()
        self._endpoint = endpoint
        self._queue: asyncio.Queue[OutputAudioRawFrame] = asyncio.Queue()
        self._reader: Optional[asyncio.Task] = None
        # The rate the local output transport's (stream) resampler locks onto —
        # learned from the bot's own OutputAudioRawFrames before relay engages.
        # pipecat's output transport resampler can't change input rate mid-
        # stream, so relayed audio MUST be fed at this exact rate. None until a
        # bot frame is seen (e.g. a bare relay leg with no bot of its own).
        self._dst_rate: Optional[int] = None
        # Stateless per-call resampler (handles arbitrary in/out rates; identity
        # when equal) — used to convert peer audio to ``_dst_rate``.
        self._resampler = SOXRAudioResampler()

    async def feed(self, frame: OutputAudioRawFrame) -> None:
        await self._queue.put(frame)

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)

        # Start the reader lazily once the pipeline is live. ``StartFrame`` is a
        # system frame that always reaches us before any media.
        if isinstance(frame, StartFrame) and self._reader is None:
            self._reader = self.create_task(self._drain())
        elif isinstance(frame, (EndFrame, CancelFrame)) and self._reader is not None:
            await self.cancel_task(self._reader)
            self._reader = None

        if (
            direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, OutputAudioRawFrame)
        ):
            if self._endpoint.engaged:
                # Drop the local bot's audio while relaying — the agent is silent.
                return
            # Remember the rate the local output transport sees from the bot, so
            # relayed audio can be fed at the same rate (its resampler locks to
            # this and rejects any change). Updated on every pre-relay frame.
            self._dst_rate = frame.sample_rate

        await self.push_frame(frame, direction)

    async def _drain(self) -> None:
        drained = 0
        while True:
            frame = await self._queue.get()
            target = self._dst_rate
            src_rate = frame.sample_rate
            if target and target != frame.sample_rate:
                audio = await self._resampler.resample(
                    frame.audio, frame.sample_rate, target
                )
                frame = OutputAudioRawFrame(
                    audio=audio, sample_rate=target, num_channels=frame.num_channels
                )
            try:
                await self.push_frame(frame, FrameDirection.DOWNSTREAM)
            except Exception as e:  # noqa: BLE001
                # A push failure (e.g. a locked output resampler) would otherwise
                # silently kill this drain loop and mute the relay one-way. Log it
                # and keep draining so one bad frame can't stop the audio.
                logger.warning(
                    f"relay inject[{self._endpoint.name}]: push_frame failed "
                    f"(src={src_rate} dst={target}): {e}; continuing drain"
                )
                continue
            drained += 1
            if drained == 1 or drained % 100 == 0:
                logger.info(
                    f"relay inject[{self._endpoint.name}]: drained {drained} frames "
                    f"src={src_rate} dst={target} peak={_peak(frame.audio)}"
                )


class RelayEndpoint:
    """One leg's participation in a worker-side media relay.

    Holds the two processors (:attr:`tap`, :attr:`inject`) that get spliced into
    the leg's pipeline, plus the engage state and peer pointer. Inert (pure
    passthrough, zero behavioural change) until :meth:`engage` is called — so
    every browser session can carry one with no effect on normal calls.
    """

    def __init__(self, name: str):
        self.name = name
        self.engaged = False
        self.peer: Optional["RelayEndpoint"] = None
        self.tap = _RelayTap(self)
        self.inject = _RelayInjector(self)

    def engage(self, peer: "RelayEndpoint") -> None:
        """Point this endpoint at ``peer`` and start relaying immediately."""
        self.peer = peer
        self.engaged = True
        logger.info(f"media relay endpoint engaged: {self.name} -> {peer.name}")

    def disengage(self) -> None:
        self.engaged = False
        self.peer = None
        logger.info(f"media relay endpoint disengaged: {self.name}")


def bridge(a: RelayEndpoint, b: RelayEndpoint) -> None:
    """Engage two endpoints against each other — caller and target now hear
    only each other; both local bots go silent and idle."""
    a.engage(b)
    b.engage(a)
    logger.info(f"media relay bridged: {a.name} <-> {b.name}")


def unbridge(a: Optional[RelayEndpoint], b: Optional[RelayEndpoint]) -> None:
    """Disengage both ends of a relay (P7).

    ``disengage()`` had no caller anywhere in the package, so when one
    bridged leg ended first the survivor's ``_RelayTap`` kept feeding the
    dead leg's unbounded injector queue — ~96 KB/s from a 48 kHz browser
    peer — until the survivor was itself hung up, which is best-effort.
    Safe to call with either side already gone or never engaged.
    """
    for endpoint in (a, b):
        if endpoint is not None and endpoint.engaged:
            endpoint.disengage()


def build_relay_only_task(transport, endpoint: RelayEndpoint):
    """Build a bot-less ``PipelineTask`` that relays a leg's media through its
    :class:`RelayEndpoint`.

    Used for the **blind** WebRTC→telephony case, where the freshly-originated
    outbound leg has no agent of its own — its only job is to carry the target's
    audio to the browser caller and vice-versa. The pipeline is simply::

        transport.input() → tap → inject → transport.output()

    ``tap`` forwards the target's mic audio to the browser endpoint's injector;
    ``inject`` emits the browser's audio to the target. (For the consultative
    case the consult leg runs a full TransferAgent pipeline built via
    ``build_voice_session`` with the same endpoint spliced in, so no relay-only
    task is needed there.)
    """
    from pipecat.pipeline.pipeline import Pipeline
    from pipecat.pipeline.task import PipelineParams, PipelineTask

    pipeline = Pipeline(
        [
            transport.input(),
            endpoint.tap,
            endpoint.inject,
            transport.output(),
        ]
    )
    # F1: a relay-only leg carries media between two humans — it has no
    # VAD and no bot, so it emits neither BotSpeakingFrame nor
    # UserSpeakingFrame and pipecat's idle watchdog (300 s, cancel on
    # timeout, both on by default) cancelled it five minutes into every
    # relayed conversation; ``_run_relay_leg`` then read that as the
    # target hanging up and dropped the browser caller.
    return PipelineTask(pipeline, params=PipelineParams(), idle_timeout_secs=None)
