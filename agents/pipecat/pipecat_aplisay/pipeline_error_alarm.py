"""Report non-fatal pipeline errors in call-scoped logs, deduplicating repeats without ending the call. See PR #235."""

from __future__ import annotations

import time
from typing import Any, Optional

from loguru import logger

# Log a running count no more often than this while a fault persists.
_SUMMARY_INTERVAL_SECS = 10.0


def _error_text(frame: Any) -> str:
    """Best-effort human text for an ErrorFrame across pipecat versions."""
    for attr in ("error", "message"):
        value = getattr(frame, attr, None)
        if isinstance(value, str) and value:
            return value
    return repr(frame)


def _fingerprint(text: str) -> str:
    """Group errors by a bounded prefix so varying ids or offsets cannot flood the log. See PR #235."""
    return text.strip().splitlines()[0][:160] if text.strip() else text


class PipelineErrorAlarm:
    """Counts and escalates ErrorFrames for one pipeline generation."""

    def __init__(self, *, call_id: str, handover: bool = False) -> None:
        self._call_id = call_id
        # True when this pipeline is the continuation side of a full-stack
        # agent handover — the case where a silent leg is most likely and
        # least visible, because the caller has already been told they are
        # being put through.
        self._handover = handover
        self._total = 0
        # fingerprint -> {count, first_at, last_logged_at, text}
        self._faults: dict[str, dict[str, Any]] = {}

    @property
    def total(self) -> int:
        return self._total

    def attach(self, task: Any) -> None:
        """Register on a PipelineTask. Safe no-op if the event is unavailable."""
        try:

            @task.event_handler("on_pipeline_error")
            async def _on_pipeline_error(_task, frame):  # noqa: ANN001
                self.record(frame)

        except Exception as e:  # noqa: BLE001
            logger.warning(f"pipeline error alarm: could not attach: {e}")

    def record(self, frame: Any) -> None:
        """Note one ErrorFrame, logging at most once per fault per interval."""
        text = _error_text(frame)
        key = _fingerprint(text)
        now = time.monotonic()
        self._total += 1

        fault = self._faults.get(key)
        if fault is None:
            self._faults[key] = {
                "count": 1,
                "first_at": now,
                "last_logged_at": now,
                "text": text,
            }
            logger.bind(call_id=self._call_id, handover=self._handover).error(
                f"pipeline error{' during agent handover' if self._handover else ''}: {text}"
            )
            return

        fault["count"] += 1
        if now - fault["last_logged_at"] >= _SUMMARY_INTERVAL_SECS:
            fault["last_logged_at"] = now
            secs = now - fault["first_at"]
            logger.bind(call_id=self._call_id, handover=self._handover).error(
                f"pipeline error STILL FIRING after {secs:.0f}s "
                f"({fault['count']} occurrences): {key}"
            )

    def final_summary(self) -> Optional[str]:
        """One line describing the generation's faults, or None if it was clean."""
        if not self._total:
            return None
        parts = [
            f"{f['count']}x {key} (over {f['last_logged_at'] - f['first_at']:.0f}s)"
            for key, f in self._faults.items()
        ]
        return f"{self._total} pipeline error frame(s): " + "; ".join(parts)

    def log_final_summary(self) -> None:
        summary = self.final_summary()
        if summary is None:
            return
        logger.bind(call_id=self._call_id, handover=self._handover).error(
            f"pipeline ended with errors{' after an agent handover' if self._handover else ''}"
            f" — {summary}"
        )
