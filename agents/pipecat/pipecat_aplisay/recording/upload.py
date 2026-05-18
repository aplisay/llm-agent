"""Streaming encrypt + GCS upload — sibling of ``lib/recording/upload.js``."""

from __future__ import annotations

import asyncio
import os
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


def _upload_payload(bucket_name: str, gcs_object: str, payload: bytes) -> None:
    """Blocking GCS upload — runs inside ``asyncio.to_thread``.

    The google-cloud-storage SDK does not expose a first-class asyncio API;
    its sync client is the recommended path, kept off the event loop here
    via the worker-thread wrapper.
    """
    client = storage.Client()
    bucket = client.bucket(bucket_name)
    blob = bucket.blob(gcs_object)
    blob.upload_from_string(payload, content_type="application/octet-stream")
