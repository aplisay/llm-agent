"""WebRTC join metadata: ``options.metadata`` on the join API reaches the call.

The API seals it into the join token (``lib/handlers/pipecat.js``); the worker
opens it at ``/webrtc/offer`` and merges it into the call record like the other
runtimes: activation metadata, then the caller's, then the platform's
``aplisay`` block, which callers cannot override. A token the real API minted
is opened here in tests/join-metadata-cross-language.test.mjs.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import time

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from fastapi import HTTPException

from pipecat_aplisay import api_client, worker
from pipecat_aplisay.auth import verify_join_token
from pipecat_aplisay.join_metadata import _derive_key, open_join_metadata

SECRET = "test-pipecat-join-secret-0123456789"
INSTANCE_ID = "dc5e7c37-e644-45d3-80ec-12292dc1ea70"
JOIN_METADATA = {"simplyai": {"agent_key": "ak-123"}, "crm": {"tier": "gold"}}


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def seal_join_metadata(metadata, secret) -> str:
    """Seal as ``sealJoinMetadata`` in lib/join-metadata.js does."""
    iv = os.urandom(12)
    sealed = AESGCM(_derive_key(secret)).encrypt(iv, json.dumps(metadata).encode(), None)
    # cryptography returns ciphertext | tag; the wire format puts the tag first.
    return f"v1.{_b64(iv + sealed[-16:] + sealed[:-16])}"


def _join_token(sealed=None, secret=SECRET) -> str:
    """A join token as Pipecat.join() mints it."""
    payload = {
        "instanceId": INSTANCE_ID,
        "sessionId": f"join-{INSTANCE_ID}-1",
        "expiresAt": int(time.time()) + 300,
    }
    if sealed is not None:
        payload["sealedCallMetadata"] = sealed
    raw = json.dumps(payload).encode()
    return f"{_b64(raw)}.{_b64(hmac.new(secret.encode(), raw, hashlib.sha256).digest())}"


# ---- opening ----


def test_sealed_metadata_opens_with_the_same_secret():
    assert open_join_metadata(seal_join_metadata(JOIN_METADATA, SECRET), SECRET) == JOIN_METADATA


def test_another_secret_does_not_open_it():
    with pytest.raises(Exception):
        open_join_metadata(seal_join_metadata(JOIN_METADATA, SECRET), "another-secret-entirely")


def test_an_altered_value_does_not_open():
    sealed = seal_join_metadata(JOIN_METADATA, SECRET)
    body = bytearray(base64.urlsafe_b64decode(sealed[3:] + "=" * (-len(sealed[3:]) % 4)))
    body[-1] ^= 1
    with pytest.raises(Exception):
        open_join_metadata(f"v1.{_b64(bytes(body))}", SECRET)


@pytest.mark.parametrize("sealed", ["", "v1", "v1.", "v2.AAAA", "v1.AAAA", "v1.a.b", "plain"])
def test_unknown_formats_do_not_open(sealed):
    with pytest.raises(ValueError):
        open_join_metadata(sealed, SECRET)


def test_no_secret_does_not_open():
    with pytest.raises(ValueError):
        open_join_metadata(seal_join_metadata(JOIN_METADATA, SECRET), None)


# ---- join token ----


def test_join_token_carries_the_sealed_value(monkeypatch):
    monkeypatch.setenv("PIPECAT_JOIN_SECRET", SECRET)
    sealed = seal_join_metadata(JOIN_METADATA, SECRET)
    assert verify_join_token(_join_token(sealed)).sealed_call_metadata == sealed
    assert verify_join_token(_join_token()).sealed_call_metadata is None


# ---- /webrtc/offer ----


class _Request:
    def __init__(self, token):
        self.query_params = {"token": token}
        self.headers = {}

    async def json(self):
        return {"sdp": "v=0", "type": "offer"}


class _Connection:
    def __init__(self, **_kwargs):
        pass

    async def initialize(self, *_args):
        pass

    def get_answer(self):
        return {"sdp": "v=0", "type": "answer", "pc_id": "pc-1"}


def _offer(monkeypatch, token, instance_metadata=None):
    """Run /webrtc/offer up to the Call record and return the record's metadata."""
    monkeypatch.setenv("PIPECAT_JOIN_SECRET", SECRET)
    created = {}

    async def get_instance_by_id(instance_id):
        assert instance_id == INSTANCE_ID
        return {
            "id": INSTANCE_ID,
            "metadata": instance_metadata,
            "Agent": {
                "id": "agent-1",
                "userId": "user-1",
                "organisationId": "org-1",
                "modelName": "pipecat:test-model",
            },
        }

    async def create_call(body):
        created.update(body)
        # Stop the offer here; the rest of the session is not under test.
        raise api_client.ApiRequestError(418, {}, "stop after create_call")

    monkeypatch.setattr(api_client, "get_instance_by_id", get_instance_by_id)
    monkeypatch.setattr(api_client, "create_call", create_call)
    monkeypatch.setattr(worker, "SmallWebRTCConnection", _Connection)
    monkeypatch.setattr(worker, "SmallWebRTCTransport", lambda **_kwargs: object())

    with pytest.raises(HTTPException) as raised:
        asyncio.run(worker.webrtc_offer(_Request(token)))
    assert raised.value.status_code == 418
    return created["metadata"]


def test_offer_merges_join_metadata_into_the_call(monkeypatch):
    sealed = seal_join_metadata(
        {**JOIN_METADATA, "aplisay": {"callerId": "spoofed"}}, SECRET
    )
    metadata = _offer(monkeypatch, _join_token(sealed), {"crm": {"tier": "silver"}, "site": "london"})
    assert metadata == {
        "site": "london",
        "crm": {"tier": "gold"},
        "simplyai": {"agent_key": "ak-123"},
        "aplisay": {"callerId": "WebRTC", "calledId": "WebRTC", "model": "pipecat:test-model"},
    }


def test_offer_without_join_metadata_is_unchanged(monkeypatch):
    metadata = _offer(monkeypatch, _join_token(), {"site": "london"})
    assert metadata == {
        "site": "london",
        "aplisay": {"callerId": "WebRTC", "calledId": "WebRTC", "model": "pipecat:test-model"},
    }


def test_offer_goes_on_without_metadata_that_will_not_open(monkeypatch):
    sealed = seal_join_metadata(JOIN_METADATA, "another-secret-entirely")
    metadata = _offer(monkeypatch, _join_token(sealed), {"site": "london"})
    assert metadata == {
        "site": "london",
        "aplisay": {"callerId": "WebRTC", "calledId": "WebRTC", "model": "pipecat:test-model"},
    }


def test_offer_ignores_sealed_metadata_that_is_not_an_object(monkeypatch):
    metadata = _offer(monkeypatch, _join_token(seal_join_metadata(["x"], SECRET)))
    assert metadata == {
        "aplisay": {"callerId": "WebRTC", "calledId": "WebRTC", "model": "pipecat:test-model"},
    }
