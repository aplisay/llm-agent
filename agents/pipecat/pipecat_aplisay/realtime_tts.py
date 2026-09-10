"""External TTS on a realtime model: the text-output rule.

Section 4.3 of docs/livekit-agent-architecture.md: on a realtime
(speech-to-speech) model, ``options.tts.vendor`` set to a vendor other than
the model's own provider means the model runs in text-output mode and a
discrete TTS stage speaks its text. STT and LLM stay inside the provider; only
the TTS stage is decomposed. ``options.tts.voice`` and ``options.tts.language``
then belong to that TTS.

The same table lives server-side in lib/model-voices.js (validation and the
voices API) and as the ``externalTts`` row flag in lib/models/pipecat.js. Keep
the three in step.
"""

from __future__ import annotations

from typing import Optional

#: The vendor name that means "the model's own voice" for each realtime
#: provider segment of a model id (``ultravox/ultravox-v0.7`` -> ``ultravox``).
#: ``google`` is both a realtime provider (Gemini Live) and a TTS vendor, so on
#: a Gemini model it counts as native and on every other model as external.
REALTIME_NATIVE_TTS_VENDORS: dict[str, str] = {
    "ultravox": "ultravox",
    "openai": "openai",
    "google": "google",
}

#: Realtime providers this worker can run in text-output mode. Phase 1 is
#: Ultravox only; OpenAI Realtime and Gemini Live follow (see the plan in the
#: strategy repo). Must match the rows flagged ``externalTts`` in
#: lib/models/pipecat.js.
TEXT_OUTPUT_PROVIDERS: frozenset[str] = frozenset({"ultravox"})


def realtime_provider(model_id: str) -> str:
    """Provider segment of a bare model id (``openai/gpt-realtime`` -> ``openai``)."""
    return (model_id or "").split("/", 1)[0].strip().lower()


def tts_vendor(agent: dict) -> Optional[str]:
    """``options.tts.vendor`` normalised for comparison: lowercased, and with any
    ``/model`` scoping stripped (``elevenlabs/eleven_flash_v2_5`` ->
    ``elevenlabs``). ``None`` when unset or blank."""
    options = (agent or {}).get("options") or {}
    raw = (options.get("tts") or {}).get("vendor")
    if not isinstance(raw, str):
        return None
    vendor = raw.strip().split("/", 1)[0].strip().lower()
    return vendor or None


def external_tts_vendor(agent: dict, model_id: str) -> Optional[str]:
    """The external TTS vendor the agent asks for, or ``None`` when the agent
    should use the model's own voice.

    ``None`` when ``options.tts.vendor`` is unset, or names the provider's own
    vendor (:data:`REALTIME_NATIVE_TTS_VENDORS`). Otherwise the normalised
    vendor name. This is the rule only; whether the provider can honour it is
    :func:`text_output_enabled`.
    """
    vendor = tts_vendor(agent)
    if vendor is None:
        return None
    provider = realtime_provider(model_id)
    native = REALTIME_NATIVE_TTS_VENDORS.get(provider, provider)
    if vendor == native:
        return None
    return vendor


def text_output_enabled(agent: dict, model_id: str) -> bool:
    """True when this session must run the realtime model in text-output mode
    with an external TTS: the agent asks for one AND the provider supports it
    on this worker."""
    if realtime_provider(model_id) not in TEXT_OUTPUT_PROVIDERS:
        return False
    return external_tts_vendor(agent, model_id) is not None
