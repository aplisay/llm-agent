"""Token / shared-secret authentication for the worker's HTTP surface.

- ``/dispatch`` is authenticated with the shared bearer token
  ``PIPECAT_DISPATCH_TOKEN`` set in both the llm-agent server and the worker.
- ``/webrtc/offer`` consumes signed join tokens minted by
  :func:`Pipecat.join` in ``lib/handlers/pipecat.js``. The signature uses HMAC
  SHA-256 with ``PIPECAT_JOIN_SECRET`` — the worker validates and decodes the
  payload here.
- Daily inbound webhook is authenticated by Daily's signature (TODO — add when
  setting up the production webhook).
"""

from __future__ import annotations

import base64
import hmac
import hashlib
import json
import os
import time
from dataclasses import dataclass
from typing import Optional

from fastapi import HTTPException, status


def require_dispatch_token(authorization: Optional[str]) -> None:
    expected = os.environ.get("PIPECAT_DISPATCH_TOKEN")
    if not expected:
        raise HTTPException(status_code=500, detail="PIPECAT_DISPATCH_TOKEN not set on worker")
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = authorization.split(" ", 1)[1].strip()
    if not hmac.compare_digest(token, expected):
        raise HTTPException(status_code=401, detail="invalid dispatch token")


@dataclass
class JoinPayload:
    instance_id: str
    session_id: str
    expires_at: int


def verify_join_token(token: str) -> JoinPayload:
    secret = os.environ.get("PIPECAT_JOIN_SECRET")
    if not secret:
        raise HTTPException(status_code=500, detail="PIPECAT_JOIN_SECRET not set on worker")
    try:
        payload_b64, signature_b64 = token.rsplit(".", 1)
        payload = base64.urlsafe_b64decode(_padded(payload_b64))
        expected = hmac.new(secret.encode(), payload, hashlib.sha256).digest()
        actual = base64.urlsafe_b64decode(_padded(signature_b64))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=401, detail=f"invalid token format: {e}")

    if not hmac.compare_digest(expected, actual):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid signature")

    decoded = json.loads(payload)
    if int(decoded.get("expiresAt", 0)) < int(time.time()):
        raise HTTPException(status_code=401, detail="token expired")
    return JoinPayload(
        instance_id=decoded["instanceId"],
        session_id=decoded["sessionId"],
        expires_at=int(decoded["expiresAt"]),
    )


def _padded(s: str) -> bytes:
    pad = (-len(s)) % 4
    return (s + "=" * pad).encode()
