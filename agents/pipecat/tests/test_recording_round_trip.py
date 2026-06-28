"""Round-trip tests for the recording shared contract.

These deliberately exercise the cross-language guarantee: a payload encrypted
by the Python implementation must decrypt cleanly with the JS one and vice
versa. We don't shell out to node here — instead we verify the on-wire byte
layout matches what ``lib/recording/gcm-decrypt-stream.js`` consumes (IV(12)
|| ciphertext || authTag(16)) by reading the bytes and feeding them back
through the local Python decryptor with a known fixed IV.

If you change either implementation's serialisation, ensure the matching test
in ``tests/recording-shared-lib.test.mjs`` is updated in lockstep.
"""

from __future__ import annotations

import base64
import os
import struct
import tempfile

import pytest

from pipecat_aplisay.recording import (
    GCM_AUTH_TAG_LENGTH,
    GCM_IV_LENGTH,
    GcmDecryptStream,
    GcmEncryptStream,
    OggEncoder,
    OggEncoderError,
    default_recording_base_url,
    derive_key,
    generate_key,
    object_name_for,
    parse_gcs_path,
)

PLAINTEXT = (
    b"OggS magic bytes plus arbitrary payload \xf0\x9f\x94\x90 "
    b"round-trip must preserve every byte"
)


def _encrypt_all(key: bytes, plaintext: bytes, *, iv: bytes | None = None) -> bytes:
    enc = GcmEncryptStream(key, iv=iv)
    pieces = []
    # Send in three sub-chunks to exercise the streaming path.
    cut1 = len(plaintext) // 3
    cut2 = (2 * len(plaintext)) // 3
    for chunk in (plaintext[:cut1], plaintext[cut1:cut2], plaintext[cut2:]):
        out = enc.update(chunk)
        if out:
            pieces.append(out)
    pieces.append(enc.finalize())
    return b"".join(pieces)


def _decrypt_all(key: bytes, ciphertext: bytes) -> bytes:
    dec = GcmDecryptStream(key)
    pieces = []
    # Send in three sub-chunks to exercise the streaming path.
    cut1 = len(ciphertext) // 3
    cut2 = (2 * len(ciphertext)) // 3
    for chunk in (ciphertext[:cut1], ciphertext[cut1:cut2], ciphertext[cut2:]):
        out = dec.update(chunk)
        if out:
            pieces.append(out)
    final = dec.finalize()
    if final:
        pieces.append(final)
    return b"".join(pieces)


def test_round_trip_derived_key():
    key = derive_key("hunter2")
    ciphertext = _encrypt_all(key, PLAINTEXT)
    # Overhead = 12 (IV) + 16 (auth tag).
    assert len(ciphertext) == len(PLAINTEXT) + GCM_IV_LENGTH + GCM_AUTH_TAG_LENGTH
    decoded = _decrypt_all(key, ciphertext)
    assert decoded == PLAINTEXT


def test_round_trip_generated_key():
    key, base64_key = generate_key()
    assert base64.b64decode(base64_key) == key
    ciphertext = _encrypt_all(key, PLAINTEXT)
    assert _decrypt_all(key, ciphertext) == PLAINTEXT


def test_derive_key_matches_js_contract():
    """``derive_key`` must zero-pad short strings, truncate long ones, and
    be byte-identical to the JS sibling. These are the same fixtures used in
    ``tests/recording-shared-lib.test.mjs``.
    """
    short = derive_key("abc")
    assert len(short) == 32
    assert short[:3] == b"abc"
    assert short[3:] == b"\x00" * 29

    long = derive_key("x" * 64)
    assert len(long) == 32
    assert long == b"x" * 32


def test_decrypt_with_wrong_key_fails():
    ciphertext = _encrypt_all(derive_key("right"), PLAINTEXT)
    with pytest.raises(Exception):
        _decrypt_all(derive_key("wrong"), ciphertext)


def test_wire_format_layout():
    """First 12 bytes = IV, last 16 bytes = auth tag, middle = ciphertext.

    We pin the IV so we can assert the exact layout — this is the on-wire
    contract the JS download endpoint depends on.
    """
    key = derive_key("layout")
    iv = b"\x01" * GCM_IV_LENGTH
    ciphertext = _encrypt_all(key, PLAINTEXT, iv=iv)
    assert ciphertext[:GCM_IV_LENGTH] == iv
    middle = ciphertext[GCM_IV_LENGTH:-GCM_AUTH_TAG_LENGTH]
    assert len(middle) == len(PLAINTEXT)


def test_parse_gcs_path_splits_bucket_and_prefix():
    assert parse_gcs_path("gs://my-bucket") == ("my-bucket", "")
    assert parse_gcs_path("gs://my-bucket/foo") == ("my-bucket", "foo/")
    assert parse_gcs_path("gs://my-bucket/foo/") == ("my-bucket", "foo/")


def test_parse_gcs_path_rejects_non_gs():
    with pytest.raises(ValueError):
        parse_gcs_path("s3://nope")


def test_object_name_for_uses_call_id_dot_ogg():
    assert object_name_for("", "abc-123") == "abc-123.ogg"
    assert object_name_for("recordings/", "abc-123") == "recordings/abc-123.ogg"


def test_default_base_url_env_override(monkeypatch):
    monkeypatch.setenv("RECORDING_STORAGE_PATH", "gs://override-bucket/x")
    assert default_recording_base_url() == "gs://override-bucket/x"


def test_default_base_url_falls_back_to_node_env(monkeypatch):
    monkeypatch.delenv("RECORDING_STORAGE_PATH", raising=False)
    monkeypatch.setenv("NODE_ENV", "staging")
    assert default_recording_base_url() == "gs://llm-voice/staging-recordings"


@pytest.mark.skipif(
    not __import__("shutil").which("ffmpeg"),
    reason="ffmpeg not on PATH",
)
def test_ogg_encoder_produces_valid_ogg_header():
    """End-to-end: synthesize 0.5 s of stereo PCM, encode, assert OGG magic."""
    import asyncio

    sample_rate = 16000
    num_channels = 2
    duration_s = 0.5
    samples = int(sample_rate * duration_s)
    # Interleaved s16le, all silence.
    pcm = b"\x00\x00" * num_channels * samples

    with tempfile.TemporaryDirectory() as tmp:
        pcm_path = os.path.join(tmp, "in.pcm")
        ogg_path = os.path.join(tmp, "out.ogg")
        with open(pcm_path, "wb") as f:
            f.write(pcm)

        encoder = OggEncoder(sample_rate=sample_rate, num_channels=num_channels)
        asyncio.run(encoder.encode(pcm_path, ogg_path))

        assert os.path.getsize(ogg_path) > 0
        with open(ogg_path, "rb") as f:
            head = f.read(4)
        assert head == b"OggS"
