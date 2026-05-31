"""Voice-mode resolution — section 4.1 of docs/livekit-agent-architecture.md.

Rules in order:

1. ``agent.options.voiceMode`` if set (must be ``pipeline`` or ``realtime``).
2. ``modelName`` lookup in the pipeline registry → ``pipeline``.
3. Otherwise → ``realtime``.

The handler's ``static name`` (``pipecat``) prefixes ``modelName`` (e.g.
``pipecat:openai/gpt-4o-mini``); strip it before consulting the pipeline registry.
"""

from __future__ import annotations

from typing import Literal, Optional

from .pipeline_model_ids import is_pipeline_model_id

VoiceMode = Literal["realtime", "pipeline"]


def model_id_from_name(model_name: str) -> str:
    prefix = "pipecat:"
    return model_name[len(prefix):] if model_name.startswith(prefix) else model_name


def resolve_voice_mode(model_name: str, options: Optional[dict] = None) -> VoiceMode:
    options = options or {}
    explicit = options.get("voiceMode")
    if explicit == "pipeline":
        return "pipeline"
    if explicit == "realtime":
        return "realtime"
    if is_pipeline_model_id(model_id_from_name(model_name)):
        return "pipeline"
    return "realtime"
