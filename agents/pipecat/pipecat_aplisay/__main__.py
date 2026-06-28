"""Run the worker as a uvicorn process.

Usage:
    uv run python -m pipecat_aplisay
"""

from __future__ import annotations

import os

import uvicorn

from pipecat_aplisay import secretenv


def _truthy(value: str | None) -> bool:
    return (value or "").lower() in ("1", "true", "yes", "on")


def main() -> None:
    # Decrypt SECRETENV_BUNDLE into os.environ before anything reads config, so a
    # single SECRETENV_KEY + SECRETENV_BUNDLE pair can carry every secret. No-op
    # when those aren't set. Runs in the parent process; with RELOAD the uvicorn
    # child inherits the already-decrypted environment.
    secretenv.load()

    port = int(os.environ.get("PORT", "8082"))
    # Default to "0.0.0.0" (IPv4 wildcard). Earlier versions used "::"
    # in the hope of dual-binding IPv4+IPv6 — that works on Linux (where
    # the kernel default is IPV6_V6ONLY=0) but **not** on macOS, FreeBSD
    # or Windows (default IPV6_V6ONLY=1). The result on Mac was an
    # IPv6-only listener: ``curl http://[::1]:8082`` worked but
    # ``http://127.0.0.1:8082`` was refused, and Docker containers
    # reaching us via host.docker.internal (an A record) failed. Modern
    # browsers happy-eyeballs to IPv4 fast enough that the original
    # ``localhost``-resolves-to-::1 concern is negligible.
    #
    # Override via HOST=<addr> if you need a narrower or IPv6-specific
    # bind (e.g. HOST=127.0.0.1 for loopback-only, HOST=:: if you're
    # on Linux and want IPv6).
    host = os.environ.get("HOST", "0.0.0.0")

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
