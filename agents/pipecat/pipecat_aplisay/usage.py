"""Usage metering — accumulate LLM token, TTS character/duration and STT
character/duration usage from the Pipecat pipeline and flush it to the platform
usage ledger (``POST /api/agent-db/usage``).

Mirrors ``transcript_observer.py`` (a :class:`BaseObserver`) and
``invocation_log.py`` (buffer + flush). Metrics only flow when the pipeline is
built with ``PipelineParams(enable_metrics=True, enable_usage_metrics=True)``
(see ``voice_session.py``).

``provider``/``detail`` are taken from the *configured* services
(``usage_vendors``), not the metric label, so rows carry the real vendor (e.g.
``cartesia``/``deepgram``) even on paths where the SDK metric only knows a bare
model id. The per-call ``voice``/``milliseconds`` row recorded server-side in
``Call.end()`` still covers wall-clock call minutes; this observer captures the
per-component meters (llm tokens, tts chars+ms, stt chars+ms) so each can be
priced per vendor on either basis.
"""

from __future__ import annotations

from typing import Any

from loguru import logger
from pipecat.frames.frames import (
    MetricsFrame,
    TranscriptionFrame,
    TTSAudioRawFrame,
    VADUserStartedSpeakingFrame,
    VADUserStoppedSpeakingFrame,
)
from pipecat.metrics.metrics import LLMUsageMetricsData, TTSUsageMetricsData
from pipecat.observers.base_observer import BaseObserver, FramePushed

from . import api_client
from .voice_mode import model_id_from_name


def usage_vendors(agent: dict, model_name: str) -> dict[str, dict[str, str | None]]:
    """Canonical ``{vendor, model}`` per priced technology, mirroring the service
    selection in ``voice_session.build_voice_session``'s pipeline build so metered
    rows carry the real vendor rather than a bare metric label. Keep the vendor
    defaults aligned with that build (stt=deepgram, tts=cartesia). Realtime mode
    has no separate STT/TTS stage, so only ``llm`` is meaningful there.
    """
    options = agent.get("options") or {}
    model_id = model_id_from_name(model_name)
    if "/" in model_id:
        llm_vendor, llm_model = model_id.split("/", 1)
    else:
        llm_vendor, llm_model = None, model_id
    stt_opts = options.get("stt") or {}
    tts_opts = options.get("tts") or {}
    stt_vendor = (stt_opts.get("vendor") or "deepgram").split("/")[0].lower()
    tts_vendor = (tts_opts.get("vendor") or "cartesia").split("/")[0].lower()
    return {
        "llm": {"vendor": llm_vendor, "model": llm_model},
        "stt": {"vendor": stt_vendor, "model": stt_opts.get("model")},
        "tts": {"vendor": tts_vendor, "model": tts_opts.get("model") or tts_opts.get("voice")},
    }


class UsageMeteringObserver(BaseObserver):
    """Accumulate per-(technology, provider, detail, unit) usage and ``flush()``
    the running totals to the ledger. Sources:

    - LLM tokens + TTS characters from ``MetricsFrame`` (usage metrics);
    - TTS milliseconds from synthesised ``TTSAudioRawFrame`` durations;
    - STT characters from final ``TranscriptionFrame`` text;
    - STT milliseconds from VAD user-speech windows.

    ``provider``/``detail`` come from ``services`` (the configured vendor/model),
    falling back to the metric label only when a technology is unmapped.
    """

    def __init__(self, services: dict[str, dict[str, str | None]] | None = None) -> None:
        super().__init__()
        self._services = services or {}
        # key "technology|provider|detail|unit" -> meter dict with a running qty.
        self._meters: dict[str, dict[str, Any]] = {}
        # Observers fire on every push hop, so a frame is seen multiple times;
        # dedupe by frame id to count each frame once.
        self._seen_frame_ids: set[int] = set()
        # Open VAD user-speech window start timestamp (seconds), for stt/ms.
        self._vad_start_ts: float | None = None

    def _seen(self, frame_id: int | None) -> bool:
        """True if this frame id was already counted; records it otherwise."""
        if frame_id is None:
            return False
        if frame_id in self._seen_frame_ids:
            return True
        self._seen_frame_ids.add(frame_id)
        return False

    def _resolve(self, technology: str, model: str | None) -> tuple[str | None, str | None]:
        """Canonical (provider, detail) for a metered row: provider from the
        configured service, detail from the metric model (or the configured one).
        Falls back to the old label-split only when the technology is unmapped."""
        svc = self._services.get(technology) or {}
        provider = svc.get("vendor")
        detail = model or svc.get("model")
        if provider is None and model and "/" in model:
            provider = model.split("/", 1)[0]
        return provider, detail

    def _add(self, technology: str, unit: str, qty: Any, *, provider: str | None, detail: str | None) -> None:
        try:
            quantity = int(qty or 0)
        except (TypeError, ValueError):
            return
        if quantity <= 0:
            return
        key = f"{technology}|{provider}|{detail}|{unit}"
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
        frame_id = getattr(frame, "id", None)

        if isinstance(frame, MetricsFrame):
            if self._seen(frame_id):
                return
            for m in frame.data or []:
                try:
                    if isinstance(m, LLMUsageMetricsData):
                        provider, detail = self._resolve("llm", m.model)
                        tokens = m.value
                        self._add("llm", "input_tokens", getattr(tokens, "prompt_tokens", 0), provider=provider, detail=detail)
                        self._add("llm", "output_tokens", getattr(tokens, "completion_tokens", 0), provider=provider, detail=detail)
                        self._add("llm", "cache_read_tokens", getattr(tokens, "cache_read_input_tokens", 0), provider=provider, detail=detail)
                        self._add("llm", "cache_write_tokens", getattr(tokens, "cache_creation_input_tokens", 0), provider=provider, detail=detail)
                    elif isinstance(m, TTSUsageMetricsData):
                        provider, detail = self._resolve("tts", m.model)
                        self._add("tts", "characters", m.value, provider=provider, detail=detail)
                except Exception as e:  # noqa: BLE001
                    logger.debug(f"usage metrics accumulation failed: {e}")
            return

        # STT characters — the final transcript text length (Pipecat has no
        # STTUsageMetricsData). Gate on `finalized` so interims don't double-count.
        if isinstance(frame, TranscriptionFrame):
            if not getattr(frame, "finalized", True):
                return
            if self._seen(frame_id):
                return
            provider, detail = self._resolve("stt", None)
            self._add("stt", "characters", len(frame.text or ""), provider=provider, detail=detail)
            return

        # STT milliseconds — user-speech duration from VAD windows (approximates
        # the audio the STT transcribed; how streaming STT vendors bill). Real VAD
        # frame cadence is validated via the eval harness, not here.
        if isinstance(frame, VADUserStartedSpeakingFrame):
            if self._seen(frame_id):
                return
            self._vad_start_ts = getattr(frame, "timestamp", None)
            return
        if isinstance(frame, VADUserStoppedSpeakingFrame):
            if self._seen(frame_id):
                return
            start, self._vad_start_ts = self._vad_start_ts, None
            stop = getattr(frame, "timestamp", None)
            if start is not None and stop is not None and stop > start:
                provider, detail = self._resolve("stt", None)
                self._add("stt", "milliseconds", int((stop - start) * 1000), provider=provider, detail=detail)
            return

        # TTS milliseconds — synthesised audio duration (num_frames / sample_rate).
        # Each audio chunk is a distinct frame we sum; dedup-by-id stops the
        # per-hop multiplier (the set is bounded by the call's frame count).
        if isinstance(frame, TTSAudioRawFrame):
            if self._seen(frame_id):
                return
            sr = getattr(frame, "sample_rate", 0) or 0
            nf = getattr(frame, "num_frames", 0) or 0
            if sr and nf:
                provider, detail = self._resolve("tts", None)
                self._add("tts", "milliseconds", int(nf / sr * 1000), provider=provider, detail=detail)
            return

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
