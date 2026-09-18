"""Fixtures shared across the Pipecat worker tests."""

from __future__ import annotations

import asyncio

import pytest


@pytest.fixture
def default_event_loop():
    """Synchronous grpc.aio construction needs a default loop after asyncio.run() clears it on Python 3.12.
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
