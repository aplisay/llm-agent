"""Run the worker as a uvicorn process.

Usage:
    uv run python -m pipecat_aplisay
"""

from __future__ import annotations

import os

import uvicorn


def main() -> None:
    port = int(os.environ.get("PORT", "8082"))
    uvicorn.run(
        "pipecat_aplisay.worker:app",
        host="0.0.0.0",
        port=port,
        log_level=os.environ.get("LOGLEVEL", "info").lower(),
    )


if __name__ == "__main__":
    main()
