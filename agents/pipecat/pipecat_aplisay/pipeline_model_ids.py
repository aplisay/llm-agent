"""Pipeline model registry — section 4.2 of docs/livekit-agent-architecture.md.

The contract calls for a single source of truth in the handler tree. The JS side
(``lib/models/pipecat.js``) is the canonical list; this Python copy is mirrored by
hand because the worker is in a different language. Keep the two in sync until
they're unified via a shared schema (e.g. via a generated JSON manifest).
"""

PIPELINE_MODEL_IDS: frozenset[str] = frozenset(
    {
        "openai/gpt-4o-mini",
        "openai/gpt-4o",
        "openai/gpt-5-mini",
        "google/gemini-2.5-flash",
        "google/gemini-2.0-flash",
        "anthropic/claude-sonnet-4-5",
    }
)


def is_pipeline_model_id(model_id: str) -> bool:
    return model_id in PIPELINE_MODEL_IDS
