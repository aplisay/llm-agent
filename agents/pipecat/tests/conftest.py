"""Fixtures shared across the Pipecat worker tests."""

from __future__ import annotations

import asyncio

import pytest


@pytest.fixture
def default_event_loop():
    """Give the thread a default asyncio event loop for one test.

    Needed by any SYNCHRONOUS test that constructs a grpc.aio client, which
    here means ``GoogleSTTService``: ``grpc.aio.Channel.__init__`` calls
    ``cygrpc.get_working_loop()``, and with no loop running that falls through
    to the event loop policy's default loop.

    On Python 3.12 ``asyncio.run()`` clears that default on the way out
    (``set_event_loop(None)``), and the policy then refuses to create another
    because ``_set_called`` is latched. So the constructor raises "There is no
    current event loop in thread 'MainThread'" once ANY earlier test in the run
    has used ``asyncio.run()``: the test passes alone and fails in the suite.
    Python 3.14 dropped that latch and always makes a fresh loop, which is why
    the suite looks clean on a default ``uv sync``. 3.12 is what
    ``agents/pipecat/Dockerfile`` ships, so 3.12 is the one that counts.

    Nothing in the worker needs this: every ``build_stt_service`` call in
    production happens inside a running loop.
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        yield loop
    finally:
        # Leaves the thread with no default loop, the same state every
        # asyncio.run() in this suite leaves behind.
        asyncio.set_event_loop(None)
        loop.close()
