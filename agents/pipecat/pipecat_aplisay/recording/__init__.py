"""Pipecat sibling of ``lib/recording/`` — same on-wire contract.

See ``lib/recording/CONTRACT.md`` (root of repo) for the single source of
truth. A recording produced here decrypts cleanly through the JS download
endpoint and vice versa.
"""

from .encryption_key import (
    GCM_AUTH_TAG_LENGTH,
    GCM_IV_LENGTH,
    KEY_LENGTH,
    derive_key,
    generate_key,
)
from .gcm_stream import GcmDecryptStream, GcmEncryptStream
from .gcs_path import default_recording_base_url, object_name_for, parse_gcs_path
from .ogg_encoder import OggEncoder, OggEncoderError
from .recording_session import RecordingSession
from .upload import upload_encrypted_ogg

__all__ = [
    "GCM_AUTH_TAG_LENGTH",
    "GCM_IV_LENGTH",
    "KEY_LENGTH",
    "GcmDecryptStream",
    "GcmEncryptStream",
    "OggEncoder",
    "OggEncoderError",
    "RecordingSession",
    "default_recording_base_url",
    "derive_key",
    "generate_key",
    "object_name_for",
    "parse_gcs_path",
    "upload_encrypted_ogg",
]
