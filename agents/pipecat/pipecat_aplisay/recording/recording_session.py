"""Per-call recording orchestrator.

Wires an ``AudioBufferProcessor`` event to a local PCM file, then on shutdown
encodes that PCM to Opus/OGG via ffmpeg, encrypts, and uploads to GCS. See
``lib/recording/CONTRACT.md`` for the wire-format / storage contract.

Usage from ``call_session``::

    rec = RecordingSession(call_id=call.id, client_encryption_key=opts.key)
    audio_buffer = rec.attach_to(audio_processor)   # registers on_audio_data
    await rec.start()                               # opens the PCM tempfile
    # ... run the pipeline ...
    result = await rec.stop_and_upload()
    if result:
        await api_client.set_call_recording_data(
            call.id, result.gcs_object, result.server_generated_key
        )

``stop_and_upload`` returns ``None`` when no audio was captured (e.g. the
caller disconnected before any frame was buffered) so the caller can skip
the metadata PUT — matching the LiveKit contract where the absence of
``recordingId`` is the "no recording exists" signal.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from dataclasses import dataclass
from typing import Optional

from loguru import logger

from .ogg_encoder import OggEncoder, OggEncoderError
from .upload import UploadResult, upload_encrypted_ogg


# How much PCM to accumulate before hopping to a thread to write it
# (P4). 64 KiB is ~2 s of 16 kHz stereo — one hop every couple of
# seconds per recording instead of fifty a second, at the cost of at
# most that much audio sitting in memory. The file is buffered anyway,
# so the write itself is cheap; the thread hop was the expense.
_WRITE_CHUNK_BYTES = 64 * 1024


@dataclass
class _PcmSink:
    """Holds the in-flight PCM file and metadata picked up from the
    AudioBufferProcessor event payload (sample rate, channels).
    """

    path: str
    file: "object"  # _io.BufferedWriter, but typed loosely to avoid the import
    sample_rate: Optional[int] = None
    num_channels: int = 2
    bytes_written: int = 0


class RecordingSession:
    """Owns the recording lifecycle for a single call."""

    def __init__(
        self,
        *,
        call_id: str,
        client_encryption_key: Optional[str] = None,
        work_dir: Optional[str] = None,
    ) -> None:
        self._call_id = call_id
        self._client_encryption_key = client_encryption_key
        self._work_dir = work_dir
        self._sink: Optional[_PcmSink] = None
        self._lock = asyncio.Lock()
        self._stopped = False
        # Write coalescing buffer (P4). The bridged-segment tap calls
        # ``append_pcm`` once per 20 ms frame, and every call used to be
        # its own ``asyncio.to_thread`` hop — 50 hops/s per bridged
        # recording, each writing ~1.3 KB, onto the default executor.
        # That executor is min(32, cpu+4) threads — six on a 2-vCPU node
        # — and is shared with GCS uploads, DNS lookups and httpx, so a
        # couple of bridged recordings plus one slow GCS call stalled
        # name resolution for every REST request in the process.
        # Accumulate instead and hop once per _WRITE_CHUNK_BYTES.
        self._pending = bytearray()

    def attach_to(self, audio_processor) -> None:  # pragma: no cover (wiring)
        """Register the ``on_audio_data`` event handler.

        Decoupled from ``__init__`` so callers can configure the
        AudioBufferProcessor first, then hand it to us. We register a single
        callback; pipecat's processor batches PCM into reasonably-sized
        buffers and we just append.
        """

        @audio_processor.event_handler("on_audio_data")
        async def _on_audio_data(buffer, audio, sample_rate, num_channels):  # noqa: ARG001
            await self._append(audio, sample_rate, num_channels)

    async def append_pcm(
        self, audio: bytes, sample_rate: int, num_channels: int
    ) -> None:
        """Append raw PCM directly — for taps that are not an
        AudioBufferProcessor (e.g. the sipbridge bridged-segment stereo tap,
        docs/transfer-back-plan.md WP1.5). Same path as the event handler."""
        await self._append(audio, sample_rate, num_channels)

    async def start(self) -> None:
        """Open the local PCM file. Idempotent."""
        async with self._lock:
            if self._sink is not None or self._stopped:
                return
            fd, path = tempfile.mkstemp(
                prefix=f"recording-{self._call_id}-",
                suffix=".s16le.pcm",
                dir=self._work_dir,
            )
            f = os.fdopen(fd, "wb")
            self._sink = _PcmSink(path=path, file=f)
            logger.bind(call_id=self._call_id, pcm_path=path).debug(
                "recording: opened PCM sink"
            )

    async def _append(
        self, audio: bytes, sample_rate: int, num_channels: int
    ) -> None:
        if self._stopped or not audio:
            return
        async with self._lock:
            if self._stopped:
                return
            if self._sink is None:
                # Late event after we've started but before .start() ran —
                # uncommon, but safe to open lazily.
                await self._open_sink_locked()
            assert self._sink is not None
            if self._sink.sample_rate is None:
                self._sink.sample_rate = int(sample_rate)
                self._sink.num_channels = int(num_channels)
            self._sink.bytes_written += len(audio)
            self._pending.extend(audio)
            if len(self._pending) < _WRITE_CHUNK_BYTES:
                # Not enough yet — the flush happens on a later append or
                # at stop. ``bytes_written`` already counts it, so the
                # "did we capture anything" check stays correct.
                return
            chunk = bytes(self._pending)
            self._pending.clear()
            sink = self._sink

        # Disk write outside the lock to keep the event loop snappy.
        await asyncio.to_thread(sink.file.write, chunk)

    async def _open_sink_locked(self) -> None:
        fd, path = tempfile.mkstemp(
            prefix=f"recording-{self._call_id}-",
            suffix=".s16le.pcm",
            dir=self._work_dir,
        )
        f = os.fdopen(fd, "wb")
        self._sink = _PcmSink(path=path, file=f)
        logger.bind(call_id=self._call_id, pcm_path=path).debug(
            "recording: opened PCM sink (lazy)"
        )

    async def stop_and_upload(self) -> Optional[UploadResult]:
        """Close the PCM file, encode to OGG, encrypt, and upload.

        Returns ``None`` if no audio was ever captured (no event fired, or
        the sink was never opened) — caller should skip the recording
        metadata PUT in that case.
        """
        async with self._lock:
            if self._stopped:
                return None
            self._stopped = True
            sink = self._sink
            self._sink = None
            tail = bytes(self._pending)
            self._pending.clear()

        if sink is not None and tail:
            # Whatever hadn't reached the coalescing threshold yet.
            try:
                await asyncio.to_thread(sink.file.write, tail)
            except Exception as e:  # noqa: BLE001
                logger.bind(call_id=self._call_id).warning(
                    f"recording: final PCM write failed: {e}"
                )

        if sink is None:
            logger.bind(call_id=self._call_id).info(
                "recording: stop called with no PCM sink; skipping upload"
            )
            return None

        try:
            sink.file.flush()
        except Exception as e:  # noqa: BLE001
            logger.bind(call_id=self._call_id).warning(
                f"recording: PCM flush failed: {e}"
            )
        try:
            sink.file.close()
        except Exception as e:  # noqa: BLE001
            logger.bind(call_id=self._call_id).warning(
                f"recording: PCM close failed: {e}"
            )

        if sink.bytes_written == 0 or sink.sample_rate is None:
            logger.bind(call_id=self._call_id).info(
                "recording: no audio captured; skipping upload"
            )
            self._safe_unlink(sink.path)
            return None

        ogg_path = sink.path + ".ogg"
        encoder = OggEncoder(
            sample_rate=sink.sample_rate, num_channels=sink.num_channels
        )
        try:
            await encoder.encode(sink.path, ogg_path)
        except OggEncoderError as e:
            logger.bind(call_id=self._call_id).error(
                f"recording: ffmpeg encode failed: {e}"
            )
            self._safe_unlink(sink.path)
            self._safe_unlink(ogg_path)
            raise
        finally:
            self._safe_unlink(sink.path)

        try:
            result = await upload_encrypted_ogg(
                local_path=ogg_path,
                call_id=self._call_id,
                client_encryption_key=self._client_encryption_key,
            )
        except Exception:
            self._safe_unlink(ogg_path)
            raise

        return result

    @staticmethod
    def _safe_unlink(path: str) -> None:
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        except OSError as e:
            logger.warning(f"recording: cleanup failed for {path}: {e}")
