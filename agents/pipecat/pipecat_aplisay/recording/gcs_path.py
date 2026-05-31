"""GCS path helpers — sibling of ``lib/recording/gcs-path.js``."""

from __future__ import annotations

import os


def parse_gcs_path(base_url: str) -> tuple[str, str]:
    """Split a ``gs://bucket[/prefix]`` URL into ``(bucket, prefix)``.

    ``prefix`` is either empty or ends with a single ``/`` so callers can
    string-concat the object name without further normalisation.
    """
    if not base_url.startswith("gs://"):
        raise ValueError("Recording storage path must be a gs:// URL")

    without_scheme = base_url[len("gs://") :]
    first_slash = without_scheme.find("/")
    if first_slash == -1:
        return without_scheme, ""

    bucket = without_scheme[:first_slash]
    prefix = without_scheme[first_slash + 1 :]
    if prefix and not prefix.endswith("/"):
        prefix += "/"
    return bucket, prefix


def default_recording_base_url() -> str:
    """Default GCS base URL when ``RECORDING_STORAGE_PATH`` is unset.

    Mirrors the JS default exactly so deployments without explicit
    configuration land on the same bucket regardless of which agent wrote
    the file.
    """
    storage_path = os.environ.get("RECORDING_STORAGE_PATH")
    if storage_path:
        return storage_path
    node_env = os.environ.get("NODE_ENV", "development")
    return f"gs://llm-voice/{node_env}-recordings"


def object_name_for(prefix: str, call_id: str) -> str:
    """Build the GCS object name for a recording. Always ``.ogg``."""
    return f"{prefix}{call_id}.ogg"
