"""``formatted`` and the Deepgram pass-through options on one STT block
(``options.stt``, ``options.stt.aux`` or ``options.tts.output``): what the
engine is sent. See docs/stt-formatting.md. Keep the mapping in step with
agents/livekit/lib/stt-formatting.ts."""

from typing import Any

#: Callers read details out in pieces, and each pause ends a transcript that is
#: formatted alone. The caller-side auxiliary engine is off the call path, so it
#: can wait longer for a pause.
CALLER_DEEPGRAM_ENDPOINTING_MS = 1500

DEEPGRAM_BOOLEANS = ("smart_format", "punctuate", "numerals", "no_delay")
FORMATTING_FIELDS = ("formatted", *DEEPGRAM_BOOLEANS, "endpointing")


def pick_stt_formatting(block: Any) -> dict:
    """Lenient copy of the formatting fields from an STT block; wrong types are dropped."""
    if not isinstance(block, dict):
        return {}
    out: dict = {}
    for field in ("formatted", *DEEPGRAM_BOOLEANS):
        if isinstance(block.get(field), bool):
            out[field] = block[field]
    endpointing = block.get("endpointing")
    if endpointing is False or (
        isinstance(endpointing, int) and not isinstance(endpointing, bool) and endpointing > 0
    ):
        out["endpointing"] = endpointing
    return out


def has_deepgram_options(block: Any) -> bool:
    picked = pick_stt_formatting(block)
    return any(field in picked for field in (*DEEPGRAM_BOOLEANS, "endpointing"))


def deepgram_formatting(block: Any, long_pause: bool) -> dict:
    """Deepgram parameters for a block: the ``formatted`` bundle, then any
    Deepgram option set in the block on top. ``long_pause`` is true for the
    caller-side auxiliary engine only: the output engine gets audio only while
    the agent speaks, so it never hears a long pause."""
    picked = pick_stt_formatting(block)
    out: dict = {}
    if picked.get("formatted") is True:
        # No ``numerals``: with smart_format it turns "half past seven" into "0.5 past 7".
        out.update(smart_format=True, punctuate=True, no_delay=True)
        if long_pause:
            out["endpointing"] = CALLER_DEEPGRAM_ENDPOINTING_MS
    for field in (*DEEPGRAM_BOOLEANS, "endpointing"):
        if field in picked:
            out[field] = picked[field]
    return out


def deepgram_stt_service(query_params: dict, **kwargs: Any) -> Any:
    """A ``DeepgramSTTService`` that also sends ``query_params`` on the
    WebSocket URL. Plain service when there are none.

    The Deepgram SDK's ``listen.v1.connect()`` has no argument for some query
    parameters (``no_delay``), and refuses unknown keyword arguments, so they go
    in ``request_options["additional_query_parameters"]``, which it merges into
    the URL. tests/test_stt_formatting.py checks this still holds."""
    from pipecat.services.deepgram.stt import DeepgramSTTService

    if not query_params:
        return DeepgramSTTService(**kwargs)

    class _QueryParamDeepgramSTTService(DeepgramSTTService):
        def _build_connect_kwargs(self) -> dict:
            connect_kwargs = super()._build_connect_kwargs()
            request_options = dict(connect_kwargs.get("request_options") or {})
            extra = dict(request_options.get("additional_query_parameters") or {})
            extra.update(
                {k: str(v).lower() if isinstance(v, bool) else str(v) for k, v in query_params.items()}
            )
            request_options["additional_query_parameters"] = extra
            connect_kwargs["request_options"] = request_options
            return connect_kwargs

    return _QueryParamDeepgramSTTService(**kwargs)
