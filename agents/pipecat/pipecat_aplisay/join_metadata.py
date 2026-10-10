"""Open the call metadata a WebRTC join seals into its join token.

The API seals it with ``lib/join-metadata.js``: AES-256-GCM with a key derived
from ``PIPECAT_JOIN_SECRET`` by HKDF-SHA256 and a purpose label. The browser can
decode its join token, and join metadata can hold customer secrets. The format
is ``v1.<base64url(iv | tag | ciphertext)>``.
"""

from __future__ import annotations

import base64
import json
from typing import Any, Optional

from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

VERSION = "v1"
IV_LENGTH = 12
TAG_LENGTH = 16
KEY_LENGTH = 32
# Must match JOIN_METADATA_KEY_INFO.pipecat in lib/join-metadata.js.
KEY_INFO = b"aplisay/pipecat-join-metadata/v1"


def _derive_key(secret: Optional[str]) -> bytes:
    if not secret:
        raise ValueError("no secret to open join metadata with")
    # salt=None is HashLen zero bytes, which HMAC treats the same as the empty salt the JS side passes.
    return HKDF(
        algorithm=hashes.SHA256(), length=KEY_LENGTH, salt=None, info=KEY_INFO
    ).derive(secret.encode("utf-8"))


def open_join_metadata(sealed: str, secret: Optional[str]) -> Any:
    """Open a value made by ``sealJoinMetadata``. Raises if the value is
    malformed or was sealed with a different secret."""
    parts = str(sealed).split(".")
    if len(parts) != 2 or parts[0] != VERSION or not parts[1]:
        raise ValueError("sealed join metadata is not in a known format")
    body = parts[1]
    raw = base64.urlsafe_b64decode(body + "=" * (-len(body) % 4))
    if len(raw) < IV_LENGTH + TAG_LENGTH:
        raise ValueError("sealed join metadata is too short")
    iv, tag, ciphertext = (
        raw[:IV_LENGTH],
        raw[IV_LENGTH : IV_LENGTH + TAG_LENGTH],
        raw[IV_LENGTH + TAG_LENGTH :],
    )
    plaintext = AESGCM(_derive_key(secret)).decrypt(iv, ciphertext + tag, None)
    return json.loads(plaintext.decode("utf-8"))

