"""Decrypt a ``SECRETENV_BUNDLE`` into the process environment at startup.

Wire-compatible with `github.com/rjp44/secretenv <https://github.com/rjp44/secretenv>`_
(the Node package the esl-poller sidecar already uses), so a single
``SECRETENV_KEY`` + ``SECRETENV_BUNDLE`` pair — e.g. one Kubernetes Secret —
carries every API key and token the worker needs:

* key      = ``HMAC-SHA256(key="secretenv", msg=SECRETENV_KEY)`` (32 bytes)
* bundle   = ``"<iv_hex>:<base64(ciphertext)>"`` — AES-256-CBC, PKCS7 padding
* plaintext = a JSON object ``{"VAR": "value", ...}``

Call :func:`load` once, as early as possible (before any config is read), so the
secrets are decrypted straight into ``os.environ`` and never touch disk. Create a
bundle with ``npx secretenv -e`` (see the package README).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os

logger = logging.getLogger(__name__)


def _derive_key(secret_key: str) -> bytes:
    return hmac.new(b"secretenv", secret_key.encode("utf-8"), hashlib.sha256).digest()


def _decrypt(bundle: str, secret_key: str) -> dict:
    iv_hex, sep, ct_b64 = bundle.partition(":")
    if not sep:
        raise ValueError("SECRETENV_BUNDLE is not in '<iv>:<ciphertext>' form")
    iv = bytes.fromhex(iv_hex)
    ciphertext = base64.b64decode(ct_b64)

    # Imported lazily so merely importing this module never requires
    # cryptography unless a bundle is actually being decrypted.
    from cryptography.hazmat.primitives import padding
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    cipher = Cipher(algorithms.AES(_derive_key(secret_key)), modes.CBC(iv))
    decryptor = cipher.decryptor()
    padded = decryptor.update(ciphertext) + decryptor.finalize()
    unpadder = padding.PKCS7(algorithms.AES.block_size).unpadder()
    plaintext = unpadder.update(padded) + unpadder.finalize()
    return json.loads(plaintext.decode("utf-8"))


def load() -> None:
    """Decrypt ``SECRETENV_BUNDLE`` into ``os.environ`` (override), if present.

    Optionally fetches the key/bundle from Google Secret Manager first when
    ``GOOGLE_SECRETENV_PATH`` is set (parity with the esl-poller sidecar).
    Best-effort: a missing key/bundle is a silent no-op; a malformed bundle or a
    Secret Manager error is logged and skipped rather than crashing the worker.
    """
    _maybe_load_from_google()

    key = os.environ.get("SECRETENV_KEY")
    bundle = os.environ.get("SECRETENV_BUNDLE")
    if not key or not bundle:
        return
    try:
        parsed = _decrypt(bundle, key)
    except Exception as exc:  # noqa: BLE001 — never let secret loading crash boot
        logger.error("secretenv: failed to decrypt SECRETENV_BUNDLE: %s", exc)
        return
    for name, value in parsed.items():
        os.environ[name] = "" if value is None else str(value)
    logger.info("secretenv: loaded %d variables from SECRETENV_BUNDLE", len(parsed))


def _maybe_load_from_google() -> None:
    path = os.environ.get("GOOGLE_SECRETENV_PATH")
    if not path:
        return
    if os.environ.get("SECRETENV_KEY") and os.environ.get("SECRETENV_BUNDLE"):
        return  # provided directly (e.g. a Kubernetes Secret) — nothing to fetch

    try:
        from google.cloud import secretmanager
    except ImportError:
        logger.warning(
            "secretenv: GOOGLE_SECRETENV_PATH is set but google-cloud-secret-manager "
            "is not installed; skipping Secret Manager fetch"
        )
        return

    try:
        client = secretmanager.SecretManagerServiceClient()
        for suffix, var in (("_KEY", "SECRETENV_KEY"), ("_BUNDLE", "SECRETENV_BUNDLE")):
            resp = client.access_secret_version(name=f"{path}{suffix}/versions/latest")
            os.environ[var] = resp.payload.data.decode("utf-8")
        logger.info("secretenv: fetched SECRETENV_KEY/BUNDLE from Secret Manager")
    except Exception as exc:  # noqa: BLE001
        logger.error("secretenv: Secret Manager fetch (%s) failed: %s", path, exc)
