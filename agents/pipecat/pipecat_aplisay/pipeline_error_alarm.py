"""Escalate pipeline ``ErrorFrame``s into something a human will actually see.

WHY THIS EXISTS (beta incident, 2026-08-21)
------------------------------------------
An agent handover left the caller in dead air for 55 seconds. The pipeline knew:
1283 ``ErrorFrame``s went past, one per dropped audio frame. But pipecat treats
a non-fatal ErrorFrame as a WARNING on the worker's own logger
(``pipeline/worker.py:_source_push_frame``), the call completed, and the Call
row was written "ended normally". Nothing distinguished it from a good call.

``PipelineTask`` already fires an ``on_pipeline_error`` event for every
ErrorFrame (``pipeline/worker.py:1109``); nobody was listening. This listens,
and turns the flood into: one ERROR the first time each distinct fault appears,
a periodic count while it persists, and one summary line when the pipeline
ends. Everything is emitted inside the run's ``logger.contextualize(callId=…)``
scope, so it lands in the call's InvocationLog and is visible in the call
inspector rather than only in pod logs.

It deliberately does NOT end the call. A pipeline error is not always fatal to
the conversation, and hanging up on a caller because of a transient decode
error would be a worse failure than the one it is reporting. The job here is to
make silence loud in the logs, not to make policy.
"""

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
    """Collapse a family of near-identical errors to one key.

    The incident produced 1283 messages differing only in nothing at all, but
    in general the tail of an exception (ids, offsets) varies while the head
    identifies the fault. First line, first 160 chars is plenty to tell two
    real faults apart without letting one fault log a thousand times.
    """
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
