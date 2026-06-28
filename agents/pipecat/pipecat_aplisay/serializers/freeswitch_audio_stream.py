"""FrameSerializer for FreeSWITCH ``mod_audio_stream``.

Wire protocol (voxcom-us/mod_audio_stream):

- **Binary frames** carry raw PCM. The dialplan configures
  ``audio_stream start <ws-url> mono 16k`` so we receive signed 16-bit
  little-endian, 16kHz, mono. Each binary frame is a chunk of that.
- **Text frames** carry JSON control events:
    - ``{"event": "start", "callId": "...", "channelId": "<uuid>", ...}``
      sent once when the stream opens; includes the channel variables we
      stamped in the dialplan (``aplisay_trunk``, ``aplisay_call_id``, the
      caller / called IDs, etc.).
    - ``{"event": "stop", ...}``
    - ``{"event": "dtmf", "digit": "5"}``
    - Possibly other status / error events.

Outbound:

- We send raw PCM as binary frames at the same sample rate.
- We can send JSON control messages back to the channel (e.g. ``{"event":
  "kill_audio"}`` to drop the current audio buffer) — those are forwarded to
  FreeSWITCH as event handlers; not required by the worker today.

See section 6 of docs/livekit-agent-architecture.md for the wire-header contract
this serializer surfaces in the start event metadata.
"""

from __future__ import annotations

import base64
import json
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Optional

from loguru import logger
from pipecat.audio.dtmf.types import KeypadEntry
from pipecat.frames.frames import (
    AudioRawFrame,
    Frame,
    InputAudioRawFrame,
    InputDTMFFrame,
    StartFrame,
)
from pipecat.serializers.base_serializer import FrameSerializer


@dataclass
class FreeSwitchAudioStreamStart:
    """Decoded start event payload — what the WS handler needs to know."""

    channel_uuid: str
    called_id: Optional[str]
    caller_id: Optional[str]
    aplisay_trunk: Optional[str]
    aplisay_phone_registration: Optional[str]
    aplisay_call_id: Optional[str]
    aplisay_b2bua_ip: Optional[str]
    aplisay_b2bua_transport: Optional[str]
    raw: dict


class FreeSwitchAudioStreamSerializer(FrameSerializer):
    """Serializer for the voxcom-us/mod_audio_stream WebSocket protocol.

    Instantiate per WebSocket connection. The on_start callback is invoked
    once when FreeSWITCH delivers its ``start`` event — that's where the
    inbound dispatch in worker.py picks up channel metadata, looks up the
    agent, and constructs the call session.
    """

    def __init__(
        self,
        *,
        sample_rate: int = 16000,
        on_start: Optional[Callable[[FreeSwitchAudioStreamStart], Awaitable[None]]] = None,
    ) -> None:
        super().__init__()
        self._sample_rate = sample_rate
        self._on_start = on_start
        self._is_open = False

    @property
    def type(self) -> str:
        return "freeswitch-audio-stream"

    @property
    def is_open(self) -> bool:
        return self._is_open

    async def setup(self, frame: StartFrame) -> None:
        # Honour the StartFrame's sample rate when present.
        self._sample_rate = frame.audio_in_sample_rate or self._sample_rate
        logger.debug(f"FreeSwitchAudioStreamSerializer setup sample_rate={self._sample_rate}")

    async def serialize(self, frame: Frame) -> str | bytes | None:
        # Outbound audio (worker → channel). voxcom mod_audio_stream does NOT
        # play raw binary frames back into the channel — its playback path
        # (processMessage) only accepts a JSON text frame of the form
        # {"type":"streamAudio","data":{"audioDataType":"raw","sampleRate":N,
        #   "audioData":"<base64 PCM>"}}; anything else is ignored, so raw bytes
        # would leave the far end hearing silence. (Inbound is the opposite:
        # mod_audio_stream sends us raw binary, handled in deserialize.)
        if isinstance(frame, AudioRawFrame):
            return json.dumps(
                {
                    "type": "streamAudio",
                    "data": {
                        "audioDataType": "raw",
                        "sampleRate": frame.sample_rate or self._sample_rate,
                        "audioData": base64.b64encode(frame.audio).decode("ascii"),
                    },
                }
            )
        # Other frames (control messages, etc.) are not forwarded by default;
        # extensions can add them as JSON text frames here.
        return None

    async def deserialize(self, data: str | bytes) -> Frame | None:
        if isinstance(data, (bytes, bytearray)):
            return InputAudioRawFrame(
                audio=bytes(data),
                sample_rate=self._sample_rate,
                num_channels=1,
            )

        try:
            event = json.loads(data)
        except Exception:  # noqa: BLE001
            logger.warning(f"freeswitch audio_stream: non-JSON text frame: {data[:120]!r}")
            return None

        kind = event.get("event") or event.get("type")

        if kind == "start":
            self._is_open = True
            await self._handle_start_event(event)
            return None

        if kind == "stop":
            self._is_open = False
            logger.bind(event=event).info("audio_stream stop")
            return None

        if kind == "dtmf":
            digit = event.get("digit") or event.get("dtmf")
            if digit:
                try:
                    return InputDTMFFrame(button=KeypadEntry(digit))
                except ValueError:
                    logger.warning(f"unrecognised DTMF digit {digit!r}")
            return None

        # Unknown event types — log and ignore. Errors / status frames live
        # here; they don't translate to a Pipecat frame on their own.
        logger.bind(event=event).debug("audio_stream event")
        return None

    async def _handle_start_event(self, event: dict) -> None:
        """Decode the start event into the worker's expected shape.

        Channel variables come through under their FS names (``aplisay_trunk``
        etc.); when sent through the dialplan as ``set`` actions they land in
        the start payload's ``variables`` block (mod_audio_stream forwards
        configured variables — names exposed via mod_audio_stream's
        ``audio_stream_response_metadata`` or via the metadata flag in newer
        builds).
        """
        # voxcom mod_audio_stream packs channel variables under "variables"
        # or top-level depending on version; check both.
        vars_ = event.get("variables") or {}
        payload = FreeSwitchAudioStreamStart(
            channel_uuid=event.get("channelId") or event.get("uuid") or vars_.get("Unique-ID") or "",
            called_id=event.get("calledId") or vars_.get("aplisay_called") or event.get("to"),
            caller_id=event.get("callerId") or vars_.get("aplisay_caller") or event.get("from"),
            aplisay_trunk=vars_.get("aplisay_trunk") or event.get("aplisay_trunk"),
            aplisay_phone_registration=vars_.get("aplisay_phone_registration")
            or event.get("aplisay_phone_registration"),
            aplisay_call_id=vars_.get("aplisay_call_id") or event.get("aplisay_call_id"),
            aplisay_b2bua_ip=vars_.get("aplisay_b2bua_ip") or event.get("aplisay_b2bua_ip"),
            aplisay_b2bua_transport=vars_.get("aplisay_b2bua_transport")
            or event.get("aplisay_b2bua_transport"),
            raw=event,
        )
        if self._on_start:
            await self._on_start(payload)
