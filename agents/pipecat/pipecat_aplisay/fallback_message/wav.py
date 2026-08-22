"""Minimal mono PCM WAV reader/writer for the fallback-message cache.

Sibling of ``lib/fallback-message/wav.js``. Only the subset needed here is
implemented: PCM (format 1), mono, 16-bit little-endian. See
``lib/fallback-message/CONTRACT.md`` for why the sample rate travels in the
container rather than being pinned.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

_HEADER_BYTES = 44
_PCM_FORMAT = 1
_BITS_PER_SAMPLE = 16
_CHANNELS = 1


@dataclass(frozen=True)
class DecodedWav:
    pcm: bytes
    sample_rate: int


def encode_wav(pcm: bytes, sample_rate: int) -> bytes:
    """Wrap mono 16-bit little-endian PCM in a WAV container."""
    if not isinstance(pcm, (bytes, bytearray, memoryview)):
        raise TypeError("encode_wav: pcm must be bytes-like")
    if not isinstance(sample_rate, int) or sample_rate <= 0:
        raise ValueError(f"encode_wav: invalid sample_rate {sample_rate}")
    pcm = bytes(pcm)
    byte_rate = sample_rate * _CHANNELS * (_BITS_PER_SAMPLE // 8)
    block_align = _CHANNELS * (_BITS_PER_SAMPLE // 8)
    return (
        b"RIFF"
        + struct.pack("<I", _HEADER_BYTES - 8 + len(pcm))
        + b"WAVE"
        + b"fmt "
        + struct.pack(
            "<IHHIIHH",
            16,
            _PCM_FORMAT,
            _CHANNELS,
            sample_rate,
            byte_rate,
            block_align,
            _BITS_PER_SAMPLE,
        )
        + b"data"
        + struct.pack("<I", len(pcm))
        + pcm
    )


def decode_wav(buffer: bytes) -> DecodedWav:
    """Read a mono 16-bit PCM WAV produced by :func:`encode_wav`.

    Chunks are walked rather than assumed at fixed offsets: some TTS vendors
    return WAV with a ``LIST``/``fact`` chunk ahead of ``data``, and a cached
    object written from such a payload would otherwise decode as noise.
    """
    if not buffer or len(buffer) < 12:
        raise ValueError("decode_wav: buffer too short to be a WAV")
    if buffer[0:4] != b"RIFF" or buffer[8:12] != b"WAVE":
        raise ValueError("decode_wav: not a RIFF/WAVE payload")

    sample_rate = 0
    offset = 12
    while offset + 8 <= len(buffer):
        chunk_id = buffer[offset : offset + 4]
        (chunk_size,) = struct.unpack_from("<I", buffer, offset + 4)
        body = offset + 8
        if chunk_id == b"fmt ":
            fmt, channels = struct.unpack_from("<HH", buffer, body)
            (bits,) = struct.unpack_from("<H", buffer, body + 14)
            if fmt != _PCM_FORMAT or channels != _CHANNELS or bits != _BITS_PER_SAMPLE:
                raise ValueError(
                    f"decode_wav: expected mono 16-bit PCM, got "
                    f"format={fmt} channels={channels} bits={bits}"
                )
            (sample_rate,) = struct.unpack_from("<I", buffer, body + 4)
        elif chunk_id == b"data":
            if not sample_rate:
                raise ValueError("decode_wav: data chunk before fmt chunk")
            # Trust the buffer over the declared size: a truncated upload would
            # otherwise hand callers fewer bytes than the header promises.
            end = min(body + chunk_size, len(buffer))
            return DecodedWav(pcm=buffer[body:end], sample_rate=sample_rate)
        # Chunks are word-aligned: an odd size carries a trailing pad byte.
        offset = body + chunk_size + (chunk_size % 2)

    raise ValueError("decode_wav: no data chunk found")
