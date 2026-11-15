"""preStop hook for a worker that takes calls from call control.

    python -m pipecat_aplisay.drain

Tells the worker to refuse new calls from call control (``POST /drain``),
then waits until it has no live call, for at most ``LIFECYCLE_DRAIN_SECONDS``.
Always exits 0: a hook that fails only makes the kubelet kill the pod sooner.
"""

# Standard library only: the hook runs under the image's own python, not in
# the worker's environment.
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from typing import Callable


def _post_drain(base: str) -> None:
    request = urllib.request.Request(f"{base}/drain", data=b"", method="POST")
    with urllib.request.urlopen(request, timeout=3):
        pass


def _live_calls(base: str) -> int:
    with urllib.request.urlopen(f"{base}/healthz", timeout=3) as response:
        return int(json.load(response)["live_calls"])


def wait_for_calls(
    base: str,
    limit: float,
    *,
    post_drain: Callable[[str], None] = _post_drain,
    live_calls: Callable[[str], int] = _live_calls,
    sleep: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
    say: Callable[[str], None] = lambda line: print(line, flush=True),
) -> str:
    """Returns why the wait ended: ``empty``, ``no_reading`` or ``deadline``."""
    try:
        post_drain(base)
        say("preStop: the worker refuses new calls from call control")
    except Exception as e:  # noqa: BLE001
        say(f"preStop: could not tell the worker to drain ({e})")
    deadline = clock() + limit
    say("preStop: waiting for live calls to end")
    while clock() < deadline:
        try:
            count = live_calls(base)
        except Exception as e:  # noqa: BLE001
            # A worker that has gone has no calls to wait for.
            say(f"preStop: no health reading ({e}); proceeding")
            return "no_reading"
        if count == 0:
            say("preStop: no live calls")
            return "empty"
        sleep(5)
    say("preStop: drain deadline reached with calls still live")
    return "deadline"


def main() -> None:
    base = f"http://127.0.0.1:{os.environ.get('PORT', '8082')}"
    wait_for_calls(base, float(os.environ.get("LIFECYCLE_DRAIN_SECONDS", "1200")))
    sys.exit(0)


if __name__ == "__main__":
    main()
