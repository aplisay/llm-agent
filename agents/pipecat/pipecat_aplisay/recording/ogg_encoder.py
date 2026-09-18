"""PCM → Opus/OGG via ffmpeg.

LiveKit's SDK writes Opus-in-OGG directly. Pipecat's ``AudioBufferProcessor``
hands us raw interleaved 16-bit PCM, so we run a one-shot ffmpeg job on
session shutdown to produce a file in the same container/codec. The shape
matches CONTRACT.md: stereo, user-left/bot-right, sample rate inherited from
whatever the pipeline produced.

Streaming the PCM through ffmpeg during the call is also possible, but for
calls bounded by ``maxDuration`` the one-shot approach keeps the control flow
simple: write PCM to a temp file as it arrives, encode once at the end. A
30-minute call at 16 kHz stereo 16-bit is ~57 MB — well within budget for
on-disk buffering, and we never hold all of it in memory.
"""

from __future__ import annotations

import asyncio
import os
import shutil
from dataclasses import dataclass


# Ceiling on one recording's encode. ffmpeg transcoding an hour of
# 16 kHz stereo PCM to Opus takes seconds; anything approaching this is
# a stuck process, and it runs on the call's teardown path.
ENCODE_TIMEOUT_SECS = 60.0


class OggEncoderError(RuntimeError):
    """Raised when ffmpeg is missing or the encode subprocess fails."""


@dataclass
class OggEncoder:
    """One-shot PCM → Opus/OGG encoder.

    Attributes:
        sample_rate: Hz of the source PCM (passed to ``ffmpeg -ar``).
        num_channels: 1 or 2. We always pass stereo from Pipecat, but the
            encoder doesn't care — it just forwards what it's told.
        ffmpeg_bin: Override of the ffmpeg binary location, useful in
            self-hosted environments. Defaults to ``ffmpeg`` resolved from
            ``PATH``.
        bitrate: Opus target bitrate. 48 kbps is plenty for voice; the
            LiveKit SDK uses 48 kbps too.
    """

    sample_rate: int
    num_channels: int = 2
    ffmpeg_bin: str | None = None
    bitrate: str = "48k"

    async def encode(self, pcm_path: str, ogg_path: str) -> None:
        """Encode ``pcm_path`` (raw s16le) to ``ogg_path`` (Opus-in-OGG)."""
        ffmpeg = self.ffmpeg_bin or shutil.which("ffmpeg")
        if not ffmpeg:
            raise OggEncoderError(
                "ffmpeg not found on PATH — install ffmpeg to enable recording, "
                "or set OggEncoder.ffmpeg_bin"
            )
        if not os.path.exists(pcm_path):
            raise OggEncoderError(f"PCM source not found: {pcm_path}")

        args = [
            ffmpeg,
            "-hide_banner",
            "-loglevel", "warning",
            "-y",
            "-f", "s16le",
            "-ar", str(self.sample_rate),
            "-ac", str(self.num_channels),
            "-i", pcm_path,
            "-c:a", "libopus",
            "-b:a", self.bitrate,
            "-f", "ogg",
            ogg_path,
        ]

        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            # Bounded (P5). This runs inside the segment teardown, ahead
            # of the invocation-log flush and the MCP close, so a wedged
            # ffmpeg — full disk, hung filesystem — blocked that call's
            # teardown, and its WebSocket handler, indefinitely.
            _, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=ENCODE_TIMEOUT_SECS
            )
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            # Reap it so the child doesn't linger as a zombie.
            try:
                await proc.wait()
            except Exception:  # noqa: BLE001
                pass
            raise OggEncoderError(
                f"ffmpeg encode timed out after {ENCODE_TIMEOUT_SECS:g}s"
            ) from None
        if proc.returncode != 0:
            raise OggEncoderError(
                f"ffmpeg encode failed (rc={proc.returncode}): "
                f"{stderr.decode('utf-8', errors='replace').strip()}"
            )
