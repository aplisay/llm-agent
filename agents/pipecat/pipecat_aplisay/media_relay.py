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
from pipecat.frames.frames import (
    CancelFrame,
    EndFrame,
    Frame,
    InputAudioRawFrame,
    OutputAudioRawFrame,
    StartFrame,
)
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor


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
            self._endpoint.engaged
            and direction == FrameDirection.DOWNSTREAM
            and isinstance(frame, OutputAudioRawFrame)
        ):
            # Drop the local bot's audio while relaying — the agent is silent.
            return

        await self.push_frame(frame, direction)

    async def _drain(self) -> None:
        while True:
            frame = await self._queue.get()
            await self.push_frame(frame, FrameDirection.DOWNSTREAM)


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
        logger.bind(endpoint=self.name, peer=peer.name).info("media relay endpoint engaged")

    def disengage(self) -> None:
        self.engaged = False
        self.peer = None
        logger.bind(endpoint=self.name).info("media relay endpoint disengaged")


def bridge(a: RelayEndpoint, b: RelayEndpoint) -> None:
    """Engage two endpoints against each other — caller and target now hear
    only each other; both local bots go silent and idle."""
    a.engage(b)
    b.engage(a)
    logger.bind(a=a.name, b=b.name).info("media relay bridged")


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
    return PipelineTask(pipeline, params=PipelineParams())
