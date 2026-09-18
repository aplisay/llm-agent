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

from collections import deque
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
from pipecat.services.stt_service import STTService

from . import api_client

# How many recently-seen frame ids the dedupe window remembers (P8).
# A frame is re-observed on each push hop within the same pipeline pass,
# so a few thousand is orders of magnitude more than needed; the cap only
# exists to stop the set growing with call length.
_SEEN_FRAME_WINDOW = 4096
from .voice_mode import model_id_from_name


def usage_vendors(
    agent: dict, model_name: str, backend: dict[str, str | None] | None = None
) -> dict[str, dict[str, str | None]]:
    """Canonical ``{vendor, model}`` per priced technology, mirroring the service
    selection in ``voice_session.build_voice_session``'s pipeline build so metered
    rows carry the real vendor rather than a bare metric label. Keep the vendor
    defaults aligned with that build (stt=deepgram, tts=cartesia). Realtime mode
    has no separate STT/TTS stage, so only ``llm`` is meaningful there.

    The ``llm`` model is authoritative over the metric label (``_resolve``): it
    is the roster id (``xai/grok-4.3``), which is what the rate lines match
    (lib/rate-components.js) and what LiveKit rows carry. The metric label is
    the service's own model name, bare, and on Gemini Live it is Pipecat's
    default model rather than the row's. ``backend`` (GPT-Live) names the
    delegate model the LLM tokens belong to, so the rows land on the delegate
    model's own rate line (docs/gpt-live.md).
    """
    options = agent.get("options") or {}
    model_id = model_id_from_name(model_name)
    if backend and backend.get("model"):
        llm_vendor, llm_model = backend.get("vendor"), backend.get("model")
    else:
        llm_vendor, llm_model = (model_id.split("/", 1)[0] if "/" in model_id else None), model_id
    stt_opts = options.get("stt") or {}
    tts_opts = options.get("tts") or {}
    stt_vendor = (stt_opts.get("vendor") or "deepgram").split("/")[0].lower()
    tts_vendor = (tts_opts.get("vendor") or "cartesia").split("/")[0].lower()
    tts: dict[str, Any] = {"vendor": tts_vendor, "model": tts_opts.get("model") or tts_opts.get("voice")}
    bundled = bundled_speech_vendor(agent, model_id)
    if bundled is not None:
        # Attribute native realtime speech to its model vendor's zero-priced TTS rows to avoid double billing.
        # Keep aligned with BUNDLED_TTS_PROVIDERS; see PR #338 and docs/realtime-external-tts.md.
        tts["vendor"] = bundled
    elif bundled is None and _bundled_speech_is_unmeterable(agent, model_id):
        # Gemini Live: its vendor, google, is also a discrete TTS engine, so a
        # tts|google row would be priced by the Google TTS line. Meter nothing
        # for its speech, as the LiveKit worker does for every realtime row.
        tts["skip"] = True
    return {
        "llm": {"vendor": llm_vendor, "model": llm_model, "authoritative": True},
        "stt": {"vendor": stt_vendor, "model": stt_opts.get("model")},
        "tts": tts,
    }


def _speaks_with_own_voice(agent: dict, model_id: str) -> bool:
    """A realtime row of a provider this worker runs, with no external TTS."""
    from .pipeline_model_ids import is_pipeline_model_id
    from .realtime_tts import REALTIME_NATIVE_TTS_VENDORS, external_tts_vendor, realtime_provider

    if is_pipeline_model_id(model_id):
        return False
    if realtime_provider(model_id) not in REALTIME_NATIVE_TTS_VENDORS:
        return False
    return external_tts_vendor(agent, model_id) is None


def bundled_speech_vendor(agent: dict, model_id: str) -> str | None:
    """The provider the model's own speech is metered under, or None when the
    session has an external TTS, is a pipeline row, or the provider's speech
    cannot be attributed without colliding with a TTS engine of the same name
    (Gemini Live). Must agree with BUNDLED_TTS_PROVIDERS in lib/rate-components.js."""
    from .realtime_tts import REALTIME_NATIVE_TTS_VENDORS, realtime_provider

    if not _speaks_with_own_voice(agent, model_id):
        return None
    vendor = REALTIME_NATIVE_TTS_VENDORS[realtime_provider(model_id)]
    return None if vendor in UNMETERED_BUNDLED_SPEECH_VENDORS else vendor


#: Do not meter native speech as TTS when the vendor also sells discrete TTS: its paid rate would match.
#: See docs/realtime-external-tts.md.
UNMETERED_BUNDLED_SPEECH_VENDORS: frozenset[str] = frozenset({"google"})


def _bundled_speech_is_unmeterable(agent: dict, model_id: str) -> bool:
    from .realtime_tts import REALTIME_NATIVE_TTS_VENDORS, realtime_provider

    return (
        _speaks_with_own_voice(agent, model_id)
        and REALTIME_NATIVE_TTS_VENDORS[realtime_provider(model_id)] in UNMETERED_BUNDLED_SPEECH_VENDORS
    )


#: LLM vendors whose Pipecat service reports ``prompt_tokens`` net of the prompt cache. Every other service the worker
#: builds reports it gross, with the cache counts inside it (see ``LLMTokenUsage``). See PR #346.
PROMPT_TOKENS_NET_OF_CACHE_VENDORS: frozenset[str] = frozenset({"anthropic"})


def uncached_input_tokens(tokens: Any, vendor: str | None) -> int:
    """The prompt tokens neither read from nor written to the prompt cache: the
    ledger prices ``input_tokens`` apart from the two cache units."""
    prompt = getattr(tokens, "prompt_tokens", 0) or 0
    if vendor in PROMPT_TOKENS_NET_OF_CACHE_VENDORS:
        return prompt
    cached = getattr(tokens, "cache_read_input_tokens", 0) or 0
    written = getattr(tokens, "cache_creation_input_tokens", 0) or 0
    return max(0, prompt - cached - written)


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
        # Deduplicate repeated push-hop sightings by frame id; a bounded recent window avoids retaining every frame for the
        # call. See PR #285.
        self._seen_frame_ids: set[int] = set()
        self._seen_frame_order: deque[int] = deque()
        # Open VAD user-speech window start timestamp (seconds), for stt/ms.
        self._vad_start_ts: float | None = None

    def _seen(self, frame_id: int | None) -> bool:
        """True if this frame id was already counted; records it otherwise."""
        if frame_id is None:
            return False
        if frame_id in self._seen_frame_ids:
            return True
        self._seen_frame_ids.add(frame_id)
        self._seen_frame_order.append(frame_id)
        if len(self._seen_frame_order) > _SEEN_FRAME_WINDOW:
            self._seen_frame_ids.discard(self._seen_frame_order.popleft())
        return False

    @property
    def _tts_skipped(self) -> bool:
        """The session's speech is not metered as tts (see usage_vendors)."""
        return bool((self._services.get("tts") or {}).get("skip"))

    def _resolve(self, technology: str, model: str | None) -> tuple[str | None, str | None]:
        """Canonical (provider, detail) for a metered row: provider from the
        configured service, detail from the metric model (or the configured one).
        Falls back to the old label-split only when the technology is unmapped."""
        svc = self._services.get(technology) or {}
        provider = svc.get("vendor")
        # An authoritative service (the llm, see usage_vendors) names the model
        # billed regardless of what the metric says.
        detail = svc.get("model") if svc.get("authoritative") else (model or svc.get("model"))
        if provider is None and model and "/" in model:
            provider = model.split("/", 1)[0]
        return provider, detail

    def add_meter(
        self, technology: str, unit: str, qty: Any, *, provider: str | None = None, detail: str | None = None
    ) -> None:
        """Accumulate usage produced outside the observed pipeline — e.g. the
        auxiliary STT tap (``aux_stt.py``), whose engine runs in a side
        pipeline this observer never sees — so every meter for the call still
        flushes through the one ledger writer."""
        self._add(technology, unit, qty, provider=provider, detail=detail)

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
                        self._add("llm", "input_tokens", uncached_input_tokens(tokens, provider), provider=provider, detail=detail)
                        self._add("llm", "output_tokens", getattr(tokens, "completion_tokens", 0), provider=provider, detail=detail)
                        self._add("llm", "cache_read_tokens", getattr(tokens, "cache_read_input_tokens", 0), provider=provider, detail=detail)
                        self._add("llm", "cache_write_tokens", getattr(tokens, "cache_creation_input_tokens", 0), provider=provider, detail=detail)
                    elif isinstance(m, TTSUsageMetricsData) and not self._tts_skipped:
                        provider, detail = self._resolve("tts", m.model)
                        self._add("tts", "characters", m.value, provider=provider, detail=detail)
                except Exception as e:  # noqa: BLE001
                    logger.debug(f"usage metrics accumulation failed: {e}")
            return

        # STT characters — the final transcript text length (Pipecat has no
        # STTUsageMetricsData). A TranscriptionFrame is by definition final
        # (interims are InterimTranscriptionFrame), so every one counts — its
        # `finalized` flag only records a commit/finalize handshake, which the
        # Deepgram service never sets in normal streaming (gating on it counted
        # nothing). Count only frames an STT *service* originated: a realtime
        # model's own transcripts (source = the LLM service) are bundled into
        # its charge, and the auxiliary engine meters itself (``stt-aux``).
        if isinstance(frame, TranscriptionFrame):
            if not isinstance(data.source, STTService):
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
            if self._seen(frame_id) or self._tts_skipped:
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
            record = {
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
            # The ledger schema types provider and detail as strings; an
            # unknown one (a side STT engine with no scoped model) is omitted
            # rather than sent as null, which fails validation and takes every
            # other record in the batch down with it.
            records.append({k: v for k, v in record.items() if not (k in ("provider", "detail") and v is None)})
        if not records:
            return
        try:
            await api_client.save_usage(records)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"usage flush failed: {e}")
