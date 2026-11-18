"""Fixtures shared across the Pipecat worker tests."""

from __future__ import annotations

import asyncio
import json

import pytest


@pytest.fixture
def default_event_loop():
    """Synchronous grpc.aio construction needs a default loop after asyncio.run() clears it (Python 3.12 on).
    Keep this test-only: production constructs services in a running loop; see PR #326."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        yield loop
    finally:
        # Leaves the thread with no default loop, the same state every
        # asyncio.run() in this suite leaves behind.
        asyncio.set_event_loop(None)
        loop.close()


@pytest.fixture
def google_credentials(monkeypatch):
    """A real (throwaway) RSA key — google-auth parses the PEM at construction,
    so a placeholder string cannot get GoogleSTTService built."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric import rsa

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    ).decode()
    monkeypatch.setenv(
        "GOOGLE_APPLICATION_CREDENTIALS_JSON",
        json.dumps(
            {
                "type": "service_account",
                "project_id": "test",
                "private_key_id": "kid",
                "private_key": pem,
                "client_email": "test@test.iam.gserviceaccount.com",
                "client_id": "1",
                "token_uri": "https://oauth2.googleapis.com/token",
            }
        ),
    )
