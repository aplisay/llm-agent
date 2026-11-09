"""Recording storage selection and the S3 signer (pipecat_aplisay/recording/storage.py)."""

from __future__ import annotations

import datetime
import os

from pipecat_aplisay.recording.storage import put_object, recording_storage_config, sign_s3_request


def test_unset_without_google_credentials_is_off(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert recording_storage_config({})["enabled"] is False


def test_unset_with_google_credentials_keeps_the_old_default():
    config = recording_storage_config({"GOOGLE_APPLICATION_CREDENTIALS": "x", "NODE_ENV": "production"})
    assert config == {"enabled": True, "backend": "gcs", "base_url": "gs://llm-voice/production-recordings", "legacy_default": True}


def test_schemes():
    assert recording_storage_config({"RECORDING_STORAGE_PATH": "gs://b/p"})["backend"] == "gcs"
    assert recording_storage_config({"RECORDING_STORAGE_PATH": "file:///data"})["backend"] == "file"
    assert recording_storage_config({"RECORDING_STORAGE_PATH": "s3://b/p"})["enabled"] is False
    s3 = recording_storage_config({"RECORDING_STORAGE_PATH": "s3://b/p", "S3_ACCESS_KEY_ID": "a", "S3_SECRET_ACCESS_KEY": "s"})
    assert s3["backend"] == "s3" and s3["enabled"] is True
    assert recording_storage_config({"RECORDING_STORAGE_PATH": "ftp://x"})["enabled"] is False


def test_file_store_writes_inside_its_directory(tmp_path):
    config = recording_storage_config({"RECORDING_STORAGE_PATH": f"file://{tmp_path}"})
    put_object(config, "call.ogg", b"data")
    assert (tmp_path / "call.ogg").read_bytes() == b"data"
    assert os.stat(tmp_path / "call.ogg").st_mode & 0o777 == 0o600


def test_s3_signature_matches_the_aws_example():
    # GET Object example from the AWS Signature Version 4 documentation.
    headers = sign_s3_request(
        "GET", "examplebucket.s3.amazonaws.com", "/test.txt", b"", "us-east-1",
        "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        headers={"Range": "bytes=0-9"}, now=datetime.datetime(2013, 5, 24, tzinfo=datetime.timezone.utc),
    )
    assert headers["authorization"].endswith("Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")
