"""Gemini Live rows on the Pipecat worker: the row's model id, the retired id it
replaces and the option mapping. The service subclass is in gemini_service.py;
the tests are in tests/test_gemini_live.py."""

from __future__ import annotations

from typing import Optional

from .pipeline_model_ids import is_pipeline_model_id

#: The Gemini Live row in lib/models/pipecat.js (the segment after ``pipecat:``).
#: Both workers name this model: it is the Live model Pipecat 1.10.0 and
#: @livekit/agents-plugin-google 1.0.46 run by default.
GEMINI_LIVE_MODEL_ID = "google/gemini-2.5-flash-native-audio-preview-12-2025"

#: Retired ids an agent may still be saved on, mapped to the id it runs as.
#: Google shut ``gemini-2.0-flash-exp`` down on 2025-12-09; the worker never
#: passed the id to the service, so it had been running Pipecat's default Live
#: model under that name. Mirrors PIPECAT_MODEL_ALIASES in lib/models/pipecat.js.
MODEL_ALIASES: dict[str, str] = {"google/gemini-2.0-flash-exp": GEMINI_LIVE_MODEL_ID}

#: Pipecat's own default, kept as the platform default for the row.
GEMINI_LIVE_DEFAULT_VOICE = "Charon"


def is_gemini_live_model_id(model_id: Optional[str]) -> bool:
    """A ``google/`` realtime row (segment after ``pipecat:``)."""
    model_id = model_id or ""
    return model_id.split("/", 1)[0].lower() == "google" and not is_pipeline_model_id(model_id)


def gemini_live_voice(agent: dict) -> str:
    """``options.tts.voice``, else Pipecat's default voice."""
    options = (agent or {}).get("options") or {}
    voice = (options.get("tts") or {}).get("voice")
    if isinstance(voice, str) and voice.strip():
        return voice.strip()
    return GEMINI_LIVE_DEFAULT_VOICE
