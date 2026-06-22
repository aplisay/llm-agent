"""Usage metering — accumulate LLM token and TTS character usage emitted by the
Pipecat metrics pipeline and flush it to the platform usage ledger
(``POST /api/agent-db/usage``).

Mirrors ``transcript_observer.py`` (a :class:`BaseObserver`) and
``invocation_log.py`` (buffer + flush). Metrics only flow when the pipeline is
built with ``PipelineParams(enable_metrics=True, enable_usage_metrics=True)``
(see ``voice_session.py``).

STT audio seconds are not separately reported by Pipecat's usage metrics; the
per-call ``voice``/``milliseconds`` row recorded server-side in ``Call.end()``
covers call minutes, so this observer captures LLM tokens and TTS characters.
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from pipecat.frames.frames import MetricsFrame
from pipecat.metrics.metrics import LLMUsageMetricsData, TTSUsageMetricsData
from pipecat.observers.base_observer import BaseObserver, FramePushed

from . import api_client


class UsageMeteringObserver(BaseObserver):
    """Accumulate per-(technology, provider, model, unit) usage from
    ``MetricsFrame`` events; ``flush()`` POSTs the running totals to the ledger.
    """

    def __init__(self) -> None:
        super().__init__()
        # key "technology|detail|unit" -> meter dict with a running quantity.
        self._meters: dict[str, dict[str, Any]] = {}
        # Observers fire on every push hop, so the same MetricsFrame is seen
        # multiple times; dedupe by frame id to count each frame once.
        self._seen_frame_ids: set[int] = set()

    def _add(self, technology: str, model: str | None, unit: str, qty: Any) -> None:
        try:
            quantity = int(qty or 0)
        except (TypeError, ValueError):
            return
        if quantity <= 0:
            return
        detail = model or None
        provider = model.split("/", 1)[0] if model and "/" in model else None
        key = f"{technology}|{detail}|{unit}"
        meter = self._meters.get(key)
        if meter is None:
            meter = {
                "technology": technology,
                "provider": provider,
                "detail": detail,
                "unit": unit,
                "quantity": 0,
            }
            self._meters[key] = meter
        meter["quantity"] += quantity

    async def on_push_frame(self, data: FramePushed) -> None:
        frame = data.frame
        if not isinstance(frame, MetricsFrame):
            return
        frame_id = getattr(frame, "id", None)
        if frame_id is not None:
            if frame_id in self._seen_frame_ids:
                return
            self._seen_frame_ids.add(frame_id)
        for m in frame.data or []:
            try:
                if isinstance(m, LLMUsageMetricsData):
                    tokens = m.value
                    self._add("llm", m.model, "input_tokens", getattr(tokens, "prompt_tokens", 0))
                    self._add("llm", m.model, "output_tokens", getattr(tokens, "completion_tokens", 0))
                    self._add("llm", m.model, "cache_read_tokens", getattr(tokens, "cache_read_input_tokens", 0))
                    self._add("llm", m.model, "cache_write_tokens", getattr(tokens, "cache_creation_input_tokens", 0))
                elif isinstance(m, TTSUsageMetricsData):
                    self._add("tts", m.model, "characters", m.value)
            except Exception as e:  # noqa: BLE001
                logger.debug(f"usage metrics accumulation failed: {e}")

    async def flush(self, call: Any, *, finalised: bool = False) -> None:
        """POST the accumulated usage to the ledger, attributed to ``call``.

        Best-effort and idempotent: posts cumulative totals with ``mode='set'``
        so a re-flush overwrites rather than double-counts. Never raises.
        """
        if call is None or not self._meters:
            return
        records = []
        for meter in self._meters.values():
            if not meter["quantity"]:
                continue
            records.append(
                {
                    "sessionId": getattr(call, "id", None),
                    "callId": getattr(call, "id", None),
                    "organisationId": getattr(call, "organisationId", None),
                    "userId": getattr(call, "userId", None),
                    "agentId": getattr(call, "agentId", None),
                    "technology": meter["technology"],
                    "provider": meter["provider"],
                    "detail": meter["detail"],
                    "unit": meter["unit"],
                    "quantity": meter["quantity"],
                    "mode": "set",
                    "finalised": finalised,
                }
            )
        if not records:
            return
        try:
            await api_client.save_usage(records)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"usage flush failed: {e}")
