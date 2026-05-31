"""Key derivation / generation — sibling of ``lib/recording/encryption-key.js``.

Two modes, both producing a 32-byte AES key:

- ``derive_key(client_key)`` — truncate or zero-pad the UTF-8 bytes of a
  client-provided string. Reproduces the JS ``deriveKey`` exactly so a key
  picked on one side decrypts on the other.
- ``generate_key()`` — random 32 bytes, returned alongside its base64 form
  for storage in the call metadata.
"""

from __future__ import annotations

import base64
import secrets

GCM_IV_LENGTH = 12
GCM_AUTH_TAG_LENGTH = 16
KEY_LENGTH = 32


def derive_key(client_key: str) -> bytes:
    """Truncate-or-zero-pad a client string to the AES-256 key size."""
    raw = client_key.encode("utf-8")
    if len(raw) >= KEY_LENGTH:
        return raw[:KEY_LENGTH]
    return raw + b"\x00" * (KEY_LENGTH - len(raw))


def generate_key() -> tuple[bytes, str]:
    """Return ``(raw_key, base64_key)``. The base64 form is what's stored
    server-side so the platform can decrypt on download.
    """
    key = secrets.token_bytes(KEY_LENGTH)
    return key, base64.b64encode(key).decode("ascii")
