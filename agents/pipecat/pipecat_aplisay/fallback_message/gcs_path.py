"""GCS path helpers for the fallback-message cache.

Sibling of ``lib/fallback-message/gcs-path.js``; the resolution order is a
cross-runtime contract (see ``lib/fallback-message/CONTRACT.md``).
"""

from __future__ import annotations

import os

__all__ = ["parse_gcs_path", "default_fallback_message_base_url", "object_name_for_key"]


def parse_gcs_path(base_url: str) -> tuple[str, str]:
    """Split a ``gs://bucket[/prefix]`` URL into ``(bucket, prefix)``.

    ``prefix`` is either empty or ends with a single ``/`` so callers can
    string-concat the object name without further normalisation.

    Deliberately a local copy of ``recording/gcs_path.py``'s function rather
    than an import of it: importing that module executes ``recording/__init__``,
    which pulls in the encryption stack. This path exists to work when other
    things are already failing, so it does not take a dependency on machinery
    it has no use for. The ``gs://`` convention itself is shared and documented
    in ``lib/fallback-message/CONTRACT.md``.
    """
    if not base_url.startswith("gs://"):
        raise ValueError("Fallback message storage path must be a gs:// URL")

    without_scheme = base_url[len("gs://") :]
    first_slash = without_scheme.find("/")
    if first_slash == -1:
        return without_scheme, ""

    bucket = without_scheme[:first_slash]
    prefix = without_scheme[first_slash + 1 :]
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    return bucket, prefix


def default_fallback_message_base_url() -> str:
    """Default GCS base URL for cached announcements.

    Derived from ``RECORDING_STORAGE_PATH``'s bucket when set, so a deployment
    that has already pointed recordings at its own bucket does not silently
    keep writing announcements to the default one.
    """
    explicit = os.environ.get("FALLBACK_MESSAGE_STORAGE_PATH")
    if explicit:
        return explicit
    env = os.environ.get("NODE_ENV", "development")
    recording_path = os.environ.get("RECORDING_STORAGE_PATH")
    if recording_path:
        # Reuse the configured bucket, but never the recordings prefix itself.
        bucket = recording_path[len("gs://") :].split("/")[0]
        return f"gs://{bucket}/{env}-fallback-messages"
    return f"gs://llm-voice/{env}-fallback-messages"


def object_name_for_key(prefix: str, key: str) -> str:
    """Build the GCS object name for a cache key. Always ``.wav``."""
    return f"{prefix}{key}.wav"
