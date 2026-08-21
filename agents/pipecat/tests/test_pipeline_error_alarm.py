"""ErrorFrames must be loud, once — not silent, and not 1283 times.

On the 2026-08-21 beta incident the pipeline emitted an ErrorFrame per dropped
audio frame for 55 seconds. Pipecat logs those as WARNINGs on its own logger and
the call still ends "normally", so nothing marked the call as bad. These tests
pin the two halves of the fix: the first occurrence of each distinct fault
escalates immediately, and a persistent flood collapses into a count rather than
drowning the log it is supposed to make readable.
"""

from __future__ import annotations

from types import SimpleNamespace

from pipecat_aplisay.pipeline_error_alarm import (
    _SUMMARY_INTERVAL_SECS,
    PipelineErrorAlarm,
    _error_text,
    _fingerprint,
)

# The real message from the incident.
_LATCH = (
    "Error processing frame: SOXRStreamAudioResampler cannot be reused with "
    "different sample rates: expected 24000->16000, got 48000->16000"
)


def _frame(text: str = _LATCH):
    return SimpleNamespace(error=text)


class TestErrorText:
    def test_reads_the_error_attribute(self) -> None:
        assert _error_text(_frame("boom")) == "boom"

    def test_falls_back_to_message(self) -> None:
        assert _error_text(SimpleNamespace(message="boom")) == "boom"

    def test_never_raises_on_an_odd_frame(self) -> None:
        assert _error_text(object())  # repr fallback, non-empty

    def test_fingerprint_collapses_a_multiline_error_to_its_head(self) -> None:
        assert _fingerprint("first line\nsecond line") == "first line"


class TestEscalation:
    def test_first_error_is_counted(self) -> None:
        alarm = PipelineErrorAlarm(call_id="c1")
        alarm.record(_frame())
        assert alarm.total == 1

    def test_a_flood_of_one_fault_is_counted_but_logged_once(self, capsys) -> None:
        alarm = PipelineErrorAlarm(call_id="c1")
        for _ in range(1283):  # the real incident volume
            alarm.record(_frame())
        assert alarm.total == 1283
        # One distinct fault, so one entry — the log volume is bounded by the
        # number of DISTINCT faults, not the number of frames dropped.
        assert len(alarm._faults) == 1

    def test_distinct_faults_are_tracked_separately(self) -> None:
        alarm = PipelineErrorAlarm(call_id="c1")
        alarm.record(_frame("resampler exploded"))
        alarm.record(_frame("codec exploded"))
        alarm.record(_frame("resampler exploded"))
        assert alarm.total == 3
        assert len(alarm._faults) == 2

    def test_a_persistent_fault_re_logs_once_the_interval_passes(self) -> None:
        alarm = PipelineErrorAlarm(call_id="c1")
        alarm.record(_frame())
        fault = alarm._faults[_fingerprint(_LATCH)]
        logged_at = fault["last_logged_at"]
        # Still inside the window: no re-log.
        alarm.record(_frame())
        assert alarm._faults[_fingerprint(_LATCH)]["last_logged_at"] == logged_at
        # Pretend the interval elapsed.
        fault["last_logged_at"] -= _SUMMARY_INTERVAL_SECS + 1
        alarm.record(_frame())
        assert alarm._faults[_fingerprint(_LATCH)]["last_logged_at"] > logged_at


class TestFinalSummary:
    def test_a_clean_generation_says_nothing(self) -> None:
        assert PipelineErrorAlarm(call_id="c1").final_summary() is None

    def test_summary_names_the_count_and_the_fault(self) -> None:
        alarm = PipelineErrorAlarm(call_id="c1")
        for _ in range(3):
            alarm.record(_frame())
        summary = alarm.final_summary()
        assert "3 pipeline error frame(s)" in summary
        assert "SOXRStreamAudioResampler" in summary

    def test_log_final_summary_is_safe_when_clean(self) -> None:
        PipelineErrorAlarm(call_id="c1").log_final_summary()  # must not raise


class TestAttach:
    def test_attaches_to_a_task_that_exposes_the_event(self) -> None:
        registered = {}

        class _Task:
            def event_handler(self, name):
                def deco(fn):
                    registered[name] = fn
                    return fn

                return deco

        PipelineErrorAlarm(call_id="c1").attach(_Task())
        assert "on_pipeline_error" in registered

    def test_a_task_without_the_event_does_not_break_the_call(self) -> None:
        class _Task:
            def event_handler(self, name):
                raise RuntimeError("no such event")

        # Monitoring is never worth failing a live call over.
        PipelineErrorAlarm(call_id="c1").attach(_Task())

    def test_the_registered_handler_records(self) -> None:
        import asyncio

        registered = {}

        class _Task:
            def event_handler(self, name):
                def deco(fn):
                    registered[name] = fn
                    return fn

                return deco

        alarm = PipelineErrorAlarm(call_id="c1", handover=True)
        alarm.attach(_Task())
        asyncio.run(registered["on_pipeline_error"](None, _frame()))
        assert alarm.total == 1
