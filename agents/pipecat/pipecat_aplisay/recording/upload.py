"""Streaming encrypt + GCS upload — sibling of ``lib/recording/upload.js``."""

from __future__ import annotations

import asyncio
import os
import threading
from dataclasses import dataclass
from typing import Optional

from google.cloud import storage  # type: ignore[import-untyped]
from loguru import logger

from .encryption_key import derive_key, generate_key
from .gcm_stream import GcmEncryptStream
from .gcs_path import default_recording_base_url, object_name_for, parse_gcs_path


@dataclass
class UploadResult:
    gcs_bucket: str
    gcs_object: str
    server_generated_key: Optional[str] = None


DEFAULT_UPLOAD_TIMEOUT_SECS = 30
_READ_CHUNK_BYTES = 64 * 1024


async def upload_encrypted_ogg(
    *,
    local_path: str,
    call_id: str,
    client_encryption_key: Optional[str] = None,
    base_url: Optional[str] = None,
    upload_timeout_secs: float = DEFAULT_UPLOAD_TIMEOUT_SECS,
    delete_local_on_success: bool = True,
) -> UploadResult:
    """Encrypt ``local_path`` (an OGG file) and upload it to GCS.

    Mirrors :func:`uploadEncryptedOgg` on the JS side exactly — same on-wire
    encryption format, same GCS naming, same key derivation.
    """
    if not os.path.exists(local_path):
        raise FileNotFoundError(f"Recording source file not found: {local_path}")

    size = os.path.getsize(local_path)
    logger.bind(call_id=call_id, local_path=local_path, local_size=size).info(
        "upload_encrypted_ogg: source file size before upload"
    )

    bucket_name, prefix = parse_gcs_path(base_url or default_recording_base_url())
    gcs_object = object_name_for(prefix, call_id)

    if client_encryption_key:
        key = derive_key(client_encryption_key)
        server_generated_key: Optional[str] = None
        logger.bind(call_id=call_id).debug(
            "upload_encrypted_ogg: using client-provided key"
        )
    else:
        key, base64_key = generate_key()
        server_generated_key = base64_key
        logger.bind(call_id=call_id).debug(
            "upload_encrypted_ogg: using server-generated key"
        )

    async def _do_upload() -> None:
        encryptor = GcmEncryptStream(key)

        def _build_payload() -> bytes:
            # The cryptography library's GCM streaming is in-process and CPU
            # bound. Build the encrypted payload in a worker thread so we
            # don't block the event loop while the OGG is encrypted and the
            # GCS SDK does its blocking upload.
            pieces: list[bytes] = []
            with open(local_path, "rb") as f:
                while True:
                    chunk = f.read(_READ_CHUNK_BYTES)
                    if not chunk:
                        break
                    piece = encryptor.update(chunk)
                    if piece:
                        pieces.append(piece)
            pieces.append(encryptor.finalize())
            return b"".join(pieces)

        payload = await asyncio.to_thread(_build_payload)
        await asyncio.to_thread(
            _upload_payload,
            bucket_name,
            gcs_object,
            payload,
        )

    try:
        await asyncio.wait_for(_do_upload(), timeout=upload_timeout_secs)
    except asyncio.TimeoutError:
        # Note what this timeout does and doesn't do: it frees the
        # awaiting coroutine, but ``asyncio.to_thread`` cannot cancel a
        # running thread, so the blocking SDK call inside keeps an
        # executor slot until its own deadline. Hence the explicit
        # ``timeout=`` on the SDK calls in ``_upload_payload`` — that is
        # the bound that actually releases the thread.
        logger.bind(call_id=call_id).warning(
            "upload_encrypted_ogg: upload timed out"
        )
        raise

    logger.bind(
        call_id=call_id,
        bucket=bucket_name,
        gcs_object=gcs_object,
        has_server_key=bool(server_generated_key),
    ).info("upload_encrypted_ogg: uploaded encrypted recording to GCS")

    if delete_local_on_success:
        try:
            await asyncio.to_thread(os.unlink, local_path)
        except OSError as e:
            logger.bind(call_id=call_id, local_path=local_path).warning(
                f"upload_encrypted_ogg: upload succeeded but local cleanup failed: {e}"
            )

    return UploadResult(
        gcs_bucket=bucket_name,
        gcs_object=gcs_object,
        server_generated_key=server_generated_key,
    )


# Deadline handed to the GCS SDK itself. ``asyncio.wait_for`` around
# ``to_thread`` frees the awaiter but cannot stop the thread, so without
# this the blocking call held an executor slot until the SDK's own 60 s
# default — on the same six-thread executor that serves DNS.
_SDK_TIMEOUT_SECS = 45.0

_shared_client: Optional[storage.Client] = None
_client_lock = threading.Lock()


def _client() -> storage.Client:
    """The process-wide GCS client, built on first use (P5).

    ``storage.Client()`` re-reads the service-account credentials, mints
    a fresh urllib3 pool and does an OAuth token exchange — and the
    session it creates is never closed. Doing that per recording is pure
    waste on a worker that uploads one per call; ``fallback_message/
    store.py`` already holds a shared lazy client for the same reason.
    Built under a lock because it is reached from the upload worker
    thread, not the event loop.
    """
    global _shared_client
    if _shared_client is None:
        with _client_lock:
            if _shared_client is None:
                _shared_client = storage.Client()
    return _shared_client


def _upload_payload(bucket_name: str, gcs_object: str, payload: bytes) -> None:
    """Blocking GCS upload — runs inside ``asyncio.to_thread``.

    The google-cloud-storage SDK does not expose a first-class asyncio API;
    its sync client is the recommended path, kept off the event loop here
    via the worker-thread wrapper.
    """
    client = _client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(gcs_object)
    blob.upload_from_string(
        payload,
        content_type="application/octet-stream",
        timeout=_SDK_TIMEOUT_SECS,
    )
