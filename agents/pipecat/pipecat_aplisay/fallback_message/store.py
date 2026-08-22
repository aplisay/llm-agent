"""GCS read/write for the fallback-message cache.

Sibling of ``lib/fallback-message/store.js``.

Every function here is **never-throw**. This code runs only when agent setup
has already failed and the caller's remaining options are the announcement or
``fallback.number``; a bucket outage must degrade to "synthesise it again this
call", never to an exception that costs the caller the announcement too.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from google.cloud import storage  # type: ignore[import-untyped]
from loguru import logger

from .gcs_path import (
    default_fallback_message_base_url,
    object_name_for_key,
    parse_gcs_path,
)

#: Default deadline for either direction. Short: the caller is on the line.
DEFAULT_TIMEOUT_SECS = 5.0

_shared_client: Optional[storage.Client] = None


def _client() -> storage.Client:
    """Lazily constructed so importing this module never touches credentials."""
    global _shared_client
    if _shared_client is None:
        _shared_client = storage.Client()
    return _shared_client


async def fetch_cached_message(
    key: str,
    *,
    base_url: Optional[str] = None,
    timeout_secs: float = DEFAULT_TIMEOUT_SECS,
) -> Optional[bytes]:
    """Read a cached announcement. Returns ``None`` on a miss or any failure."""
    bucket_name, prefix = parse_gcs_path(base_url or default_fallback_message_base_url())
    gcs_object = object_name_for_key(prefix, key)

    def _download() -> bytes:
        # The GCS SDK is blocking; keep it off the event loop.
        return _client().bucket(bucket_name).blob(gcs_object).download_as_bytes()

    try:
        contents = await asyncio.wait_for(asyncio.to_thread(_download), timeout=timeout_secs)
    except Exception as e:  # noqa: BLE001
        from google.cloud.exceptions import NotFound  # type: ignore[import-untyped]

        # A 404 is the ordinary first-use miss and is not worth a warning;
        # anything else is, but is still only a miss as far as the caller goes.
        if isinstance(e, NotFound):
            logger.bind(key=key, bucket=bucket_name, gcs_object=gcs_object).debug(
                "fallback message cache miss"
            )
        else:
            logger.bind(key=key, bucket=bucket_name, gcs_object=gcs_object).warning(
                f"fallback message cache read failed; will synthesise: {e}"
            )
        return None

    logger.bind(key=key, bucket=bucket_name, gcs_object=gcs_object, size=len(contents)).debug(
        "fallback message cache hit"
    )
    return contents


async def store_cached_message(
    key: str,
    wav: bytes,
    *,
    base_url: Optional[str] = None,
    timeout_secs: float = DEFAULT_TIMEOUT_SECS,
) -> bool:
    """Write a freshly synthesised announcement into the cache.

    Uploaded with ``if_generation_match=0`` (create-only). When an outage fails
    many calls at once every worker misses and synthesises concurrently; the
    first to finish publishes and the rest get a precondition failure, reported
    here as success because the cache does now hold the object. The losers play
    the copy they synthesised for their own call.

    Returns True when the cache holds the object afterwards.
    """
    bucket_name, prefix = parse_gcs_path(base_url or default_fallback_message_base_url())
    gcs_object = object_name_for_key(prefix, key)

    def _upload() -> None:
        blob = _client().bucket(bucket_name).blob(gcs_object)
        blob.upload_from_string(wav, content_type="audio/wav", if_generation_match=0)

    try:
        await asyncio.wait_for(asyncio.to_thread(_upload), timeout=timeout_secs)
    except Exception as e:  # noqa: BLE001
        from google.api_core.exceptions import PreconditionFailed  # type: ignore[import-untyped]

        if isinstance(e, PreconditionFailed):
            logger.bind(key=key, bucket=bucket_name, gcs_object=gcs_object).debug(
                "fallback message already cached by a concurrent writer"
            )
            return True
        logger.bind(key=key, bucket=bucket_name, gcs_object=gcs_object).warning(
            f"failed to cache fallback message; will re-synthesise next time: {e}"
        )
        return False

    logger.bind(key=key, bucket=bucket_name, gcs_object=gcs_object, size=len(wav)).info(
        "cached synthesised fallback message"
    )
    return True
