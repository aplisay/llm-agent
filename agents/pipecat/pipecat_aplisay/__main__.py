"""Run the worker as a uvicorn process.

Usage:
    uv run python -m pipecat_aplisay
"""

from __future__ import annotations

import os

import uvicorn


def _truthy(value: str | None) -> bool:
    return (value or "").lower() in ("1", "true", "yes", "on")


def main() -> None:
    port = int(os.environ.get("PORT", "8082"))
    # Default to "::" so we dual-bind IPv4 and IPv6. macOS resolves
    # `localhost` to ::1 first; binding only to 0.0.0.0 (IPv4-only) means
    # browser connections to http://localhost:<port> stall waiting on a
    # non-existent IPv6 listener instead of falling back to IPv4. The dual
    # bind avoids that without losing reachability on any external IPv4
    # interface. Override via HOST=<addr> if you need a narrower bind
    # (e.g. HOST=127.0.0.1 to restrict to loopback v4 only).
    host = os.environ.get("HOST", "::")

    # Auto-reload on file changes is invaluable in dev — without it, you have
    # to Ctrl-C and re-run after every edit, and otherwise-fixed bugs
    # "reappear" because the running process still has the old code. Off by
    # default so production restarts are deterministic; turn on for dev with
    # `RELOAD=1`. When on, uvicorn watches the pipecat_aplisay package and
    # restarts cleanly on save.
    reload = _truthy(os.environ.get("RELOAD"))
    reload_dirs = (
        [os.path.join(os.path.dirname(__file__))] if reload else None
    )

    uvicorn.run(
        "pipecat_aplisay.worker:app",
        host=host,
        port=port,
        log_level=os.environ.get("LOGLEVEL", "info").lower(),
        reload=reload,
        reload_dirs=reload_dirs,
    )


if __name__ == "__main__":
    main()
