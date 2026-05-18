"""AES-256-GCM streaming helpers — sibling of the two ``gcm-*-stream.js`` files.

Wire format produced and consumed::

    IV (12 bytes) || ciphertext || auth tag (16 bytes)

Used internally by :func:`upload_encrypted_ogg` and by the round-trip tests
that prove the JS and Python sides agree.
"""

from __future__ import annotations

import os
from typing import Iterable, Iterator

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: F401  (re-export to keep imports lazy)

from .encryption_key import GCM_AUTH_TAG_LENGTH, GCM_IV_LENGTH


class GcmEncryptStream:
    """Streaming encryptor with the same wire format as the JS sibling.

    Usage::

        enc = GcmEncryptStream(key)
        for piece in enc.update_chunks(reader):
            sink.write(piece)
        sink.write(enc.finalize())

    The first yielded piece always starts with the 12-byte IV. ``finalize()``
    returns any remaining ciphertext plus the 16-byte auth tag.
    """

    def __init__(self, key: bytes, *, iv: bytes | None = None) -> None:
        if len(key) != 32:
            raise ValueError("key must be 32 bytes for AES-256-GCM")
        self._iv = iv if iv is not None else os.urandom(GCM_IV_LENGTH)
        if len(self._iv) != GCM_IV_LENGTH:
            raise ValueError(f"iv must be {GCM_IV_LENGTH} bytes")
        cipher = Cipher(algorithms.AES(key), modes.GCM(self._iv))
        self._encryptor = cipher.encryptor()
        self._iv_pushed = False
        self._finalized = False

    @property
    def iv(self) -> bytes:
        return self._iv

    def update(self, chunk: bytes) -> bytes:
        """Encrypt a single chunk. Prepends the IV on the very first call."""
        if self._finalized:
            raise RuntimeError("GcmEncryptStream already finalized")
        prefix = b""
        if not self._iv_pushed:
            self._iv_pushed = True
            prefix = self._iv
        if not chunk:
            return prefix
        return prefix + self._encryptor.update(chunk)

    def update_chunks(self, chunks: Iterable[bytes]) -> Iterator[bytes]:
        for chunk in chunks:
            piece = self.update(chunk)
            if piece:
                yield piece

    def finalize(self) -> bytes:
        """Return any remaining ciphertext concatenated with the 16-byte auth
        tag. After this call the stream must not be used again.
        """
        if self._finalized:
            raise RuntimeError("GcmEncryptStream already finalized")
        self._finalized = True
        # If no data ever went through, we still need to emit the IV so the
        # decryptor has something to consume.
        prefix = b"" if self._iv_pushed else self._iv
        self._iv_pushed = True
        tail = self._encryptor.finalize()
        return prefix + tail + self._encryptor.tag


class GcmDecryptStream:
    """Streaming decryptor for the wire format above.

    Mirrors the JS sibling's behaviour: hold a 16-byte trailing buffer so the
    final bytes (the auth tag) can be applied via ``set_tag`` rather than
    buffering the entire stream.
    """

    def __init__(self, key: bytes) -> None:
        if len(key) != 32:
            raise ValueError("key must be 32 bytes for AES-256-GCM")
        self._key = key
        self._iv_buffer = bytearray()
        self._trailing = bytearray()
        self._decryptor = None
        self._finalized = False

    def update(self, chunk: bytes) -> bytes:
        if self._finalized:
            raise RuntimeError("GcmDecryptStream already finalized")
        if self._decryptor is None:
            self._iv_buffer.extend(chunk)
            if len(self._iv_buffer) < GCM_IV_LENGTH:
                return b""
            iv = bytes(self._iv_buffer[:GCM_IV_LENGTH])
            remaining = bytes(self._iv_buffer[GCM_IV_LENGTH:])
            cipher = Cipher(algorithms.AES(self._key), modes.GCM(iv))
            self._decryptor = cipher.decryptor()
            self._trailing.extend(remaining)
            return self._decrypt_from_trailing()

        self._trailing.extend(chunk)
        return self._decrypt_from_trailing()

    def _decrypt_from_trailing(self) -> bytes:
        out = bytearray()
        while len(self._trailing) > GCM_AUTH_TAG_LENGTH:
            cut = len(self._trailing) - GCM_AUTH_TAG_LENGTH
            piece = bytes(self._trailing[:cut])
            del self._trailing[:cut]
            out.extend(self._decryptor.update(piece))
        return bytes(out)

    def finalize(self) -> bytes:
        if self._finalized:
            raise RuntimeError("GcmDecryptStream already finalized")
        self._finalized = True
        if self._decryptor is None:
            return b""
        if len(self._trailing) != GCM_AUTH_TAG_LENGTH:
            raise ValueError(
                f"Invalid ciphertext: auth tag must be {GCM_AUTH_TAG_LENGTH} bytes"
            )
        tag = bytes(self._trailing)
        self._trailing.clear()
        self._decryptor.finalize_with_tag(tag)  # type: ignore[no-untyped-call]
        return b""
