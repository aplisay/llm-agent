"""Start-up window for one attempt of the fallback chain (docs/agent-failover.md).

A pipeline failure before the bot first speaks, within ``START_WINDOW_SECS``
of the attempt's pipeline starting, goes to ``options.fallback`` instead of
ending the call. Provider connections happen once the pipeline is running (Ultravox's
``/calls`` request is made from the service's ``start()``), so such a failure
arrives as an ``ErrorFrame``, not as an exception out of the build.
"""

from __future__ import annotations

import time
from typing import Any, Awaitable, Callable, Optional

from loguru import logger
from pipecat.frames.frames import BotStartedSpeakingFrame
from pipecat.observers.base_observer import BaseObserver, FramePushed

#: Matches the LiveKit worker's setup budget.
START_WINDOW_SECS = 15.0


class SessionStartFailed(Exception):
    """A generation's pipeline failed during its start-up window."""


class StartWindow:
    """Open from when an attempt's pipeline starts until the bot first speaks or the cap passes."""

    def __init__(
        self,
        cap_secs: float = START_WINDOW_SECS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._clock = clock
        self._deadline = clock() + cap_secs
        self._closed = False
        self.failure: Optional[str] = None

    @property
    def open(self) -> bool:
        return not self._closed and self.failure is None and self._clock() < self._deadline

    def fail(self, reason: str) -> bool:
        """Record a start failure. False, and nothing recorded, once not open."""
        if not self.open:
            return False
        self.failure = reason
        return True

    def close(self) -> None:
        """The bot has spoken, or the call is committed to a transfer or handover."""
        self._closed = True


def is_start_failure(frame: Any) -> bool:
    """An ErrorFrame the pipeline cannot carry on from: fatal, or from a processor
    that reports it can no longer work (pipecat's own policy for that defaults
    to carrying on, with the processor dead)."""
    if getattr(frame, "fatal", False):
        return True
    processor = getattr(frame, "processor", None)
    return processor is not None and not getattr(processor, "is_usable", True)


def error_text(frame: Any) -> str:
    for attr in ("error", "message"):
        value = getattr(frame, attr, None)
        if isinstance(value, str) and value:
            return value
    return repr(frame)


class StartWindowObserver(BaseObserver):
    """Closes the window on the bot's first speech."""

    def __init__(self, window: StartWindow) -> None:
        super().__init__()
        self._window = window

    async def on_push_frame(self, data: FramePushed) -> None:
        if isinstance(data.frame, BotStartedSpeakingFrame):
            self._window.close()


def watch_start_window(task: Any, window: StartWindow, cancel: Callable[[], Awaitable[None]]) -> None:
    """Fail the window on an ErrorFrame the pipeline cannot carry on from.

    A fatal frame cancels the pipeline itself; an unusable processor does not,
    so ``cancel`` ends the pipeline then.
    """
    task.add_observer(StartWindowObserver(window))

    @task.event_handler("on_pipeline_error")
    async def _on_start_error(_task, frame):  # noqa: ANN001
        if not is_start_failure(frame) or not window.fail(error_text(frame)):
            return
        logger.warning(
            f"pipeline failed before the bot spoke; handing the call to the fallback chain: {window.failure}"
        )
        if not getattr(frame, "fatal", False):
            await cancel()


class DisconnectGate:
    """Holds a websocket transport's socket open while its generation may yet
    fail to start, so a retry can run on the same live call.

    pipecat's websocket transport closes the socket when its pipeline is
    cancelled, and closing it hangs up the SIP leg. The gate defers that close
    while the window is open or has failed; ``release`` runs a deferred close
    once the generation has ended for any other reason.
    """

    def __init__(self, transport: Any, window: StartWindow) -> None:
        self._window = window
        # The client only closes once every setup() has been matched by a
        # disconnect() (input and output each call both), so each is replayed.
        self._deferred = 0
        client = getattr(transport, "_client", None)
        self._original = getattr(client, "disconnect", None)
        if self._original is not None:
            client.disconnect = self._disconnect

    async def _disconnect(self) -> None:
        if self._window.open or self._window.failure is not None:
            self._deferred += 1
            return
        await self._original()

    async def release(self) -> None:
        while self._deferred and self._window.failure is None:
            self._deferred -= 1
            await self._original()
