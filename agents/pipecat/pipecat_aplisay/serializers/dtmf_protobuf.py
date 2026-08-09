"""Protobuf frame serializer that also decodes DTMF transport messages.

Both the sipbridge and voiceblender SIP gateways speak stock Pipecat protobuf
over the audio WebSocket, and both detect DTMF in their pion-based media layer
(RFC 4733 telephone-event, RTP payload type 101). Rather than inventing a
bespoke wire format, the Go side ships each completed keypress as an ordinary
Pipecat ``MessageFrame`` whose ``data`` is a small JSON object::

    {"type": "dtmf", "digit": "5", "duration_ms": 120, "call_id": "..."}

Stock :class:`ProtobufFrameSerializer` turns that into an
:class:`InputTransportMessageFrame` whose ``.message`` is the parsed dict. No
downstream processor consumes those transport messages, so the digit would be
silently dropped. This subclass intercepts the DTMF ones and emits an
:class:`InputDTMFFrame` instead, so the DTMF aggregator
(:func:`pipecat_aplisay.voice_session._dtmf_aggregator_for`) buffers it into the
conversation exactly like the FreeSWITCH ``{"event":"dtmf",...}`` path.

Used for the sipbridge and voiceblender gateways. The FreeSWITCH gateway uses
its own :class:`FreeSwitchAudioStreamSerializer`, and Daily decodes DTMF
natively in its transport, so neither needs this.
"""

from __future__ import annotations

from typing import Optional

from loguru import logger
from pipecat.audio.dtmf.types import KeypadEntry
from pipecat.frames.frames import Frame, InputDTMFFrame, InputTransportMessageFrame
from pipecat.serializers.protobuf import ProtobufFrameSerializer


class DtmfProtobufFrameSerializer(ProtobufFrameSerializer):
    """:class:`ProtobufFrameSerializer` that converts ``{"type":"dtmf",...}``
    transport messages into :class:`InputDTMFFrame` instances.

    Outbound serialization and all non-DTMF inbound frames are handled
    unchanged by the base class.
    """

    async def deserialize(self, data: str | bytes) -> Optional[Frame]:
        frame = await super().deserialize(data)

        # Only DTMF-typed transport messages are special-cased; everything
        # else (audio, transcription, other control messages) passes through.
        if not isinstance(frame, InputTransportMessageFrame):
            return frame
        message = frame.message
        if not isinstance(message, dict) or message.get("type") != "dtmf":
            return frame

        # Post-bridge transfer-target presses (``options.bridgedTransferToAgent``,
        # ``source: "transfer_target"``) belong to the monitor loop in
        # ``bridged_transfer.py``, not to a live pipeline — a stray one racing
        # the pipeline teardown must not be mistaken for caller input.
        if message.get("source") == "transfer_target":
            return None

        # ``digit`` is the field the sipbridge/voiceblender media layer emits;
        # ``dtmf`` is accepted as an alias for parity with the FreeSWITCH path.
        digit = message.get("digit") or message.get("dtmf")
        if not digit:
            logger.warning(f"DTMF transport message without a digit: {message!r}")
            return None
        try:
            return InputDTMFFrame(button=KeypadEntry(str(digit)))
        except ValueError:
            # KeypadEntry covers 0-9, * and #. RFC 4733 also defines A-D
            # (events 12-15) which the keypad enum omits; drop those.
            logger.warning(f"unrecognised DTMF digit {digit!r}")
            return None
