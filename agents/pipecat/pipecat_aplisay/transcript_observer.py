"""Pipeline observer that emits transcripts via the call session's sendMessage path.

The platform's REST endpoint ``POST /api/agent-db/transaction-log`` creates a
fresh row on every call — it has no "update the provisional row in place"
semantics that ``Handler.transcript()`` in ``lib/handlers/handler.js`` has.
So if we send N delta chunks as ``isFinal: false``, the frontend renders N
disjoint deltas, not a single growing turn.

The contract the playground transcript expects:

- ``isFinal: false`` rows carry the **cumulative** text so far for this turn.
  Each successive emission overwrites the previous interim row visually
  (server still inserts a row, but the frontend collapses them).
- ``isFinal: true`` finalises the turn with the same cumulative text.

Source filtering:
  Pipecat observers fire on **every push between processors**, so the same
  frame is seen 2-3 times as it travels downstream. The canonical mitigation
  (see ``TranscriptionLogObserver`` in Pipecat) is to filter on ``data.source``
  so we only count the frame at its originator.

  Mapping:
    * :class:`TranscriptionFrame` / :class:`InterimTranscriptionFrame` →
      :class:`STTService` (pipeline) or :class:`LLMService` (realtime LLMs
      embed their own STT, e.g. ``OpenAIRealtimeLLMService``).
    * :class:`TTSTextFrame` → :class:`TTSService` (pipeline only).
    * :class:`LLMTextFrame` → :class:`LLMService` (realtime bot text deltas).

User side:
  STT services emit cumulative interims; realtime LLMs emit transcripts
  via input audio transcription (requires SessionProperties.audio.input).
  Pass through unchanged; dedupe catches echoes.

Bot side (mode-specific — see ``mode`` constructor arg):
  - **Pipeline mode**: :class:`TTSTextFrame` per-sentence chunks ONLY.
    We deliberately ignore :class:`LLMTextFrame` here because the LLM
    and the TTS both emit the same content (LLM streams the words it's
    generating; TTS emits the sentences it's about to speak). Catching
    both produces a "You're welcome! If You're welcome!"-style mash-up
    where the same sentence gets appended twice — once from each source.
    TTSTextFrame is preferred because it aligns with what the user
    actually hears.
  - **Realtime mode**: :class:`LLMTextFrame` ONLY. There's no separate
    TTS service in the pipeline — the realtime LLM does its own audio
    output, and `TTSTextFrame` never fires.

Finalisation triggers (any of these flushes the bot buffer as
``isFinal: true``):

  - :class:`BotStoppedSpeakingFrame` — emitted when the audio finishes
    playing on the client side. Reliable when the bot speaks to completion.
  - :class:`UserStartedSpeakingFrame` — turn-stealing. If the user
    interrupts mid-bot-utterance the bot-stop frame may never fire; this
    catches that case.
  - :class:`BotStartedSpeakingFrame` resets the buffer for a new turn
    (and flushes the previous one as a safety net).

The :class:`PipelineTask.add_observer` mechanism is the canonical hook;
observers are non-intrusive and don't change frame routing.
"""

from __future__ import annotations

from typing import Awaitable, Callable, Literal, Optional

VoiceMode = Literal["realtime", "pipeline"]

from loguru import logger
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    InterimTranscriptionFrame,
    TranscriptionFrame,
    UserStartedSpeakingFrame,
)
from pipecat.observers.base_observer import BaseObserver, FramePushed
from pipecat.services.llm_service import LLMService
from pipecat.services.stt_service import STTService

# Optional imports — versions of Pipecat have moved frame / service classes
# around. Resolve them lazily so a missing one doesn't take the whole
# observer down.
try:
    from pipecat.frames.frames import TTSTextFrame
except Exception:  # noqa: BLE001
    TTSTextFrame = None  # type: ignore[assignment]
try:
    from pipecat.frames.frames import LLMTextFrame
except Exception:  # noqa: BLE001
    LLMTextFrame = None  # type: ignore[assignment]
try:
    from pipecat.services.tts_service import TTSService
except Exception:  # noqa: BLE001
    TTSService = None  # type: ignore[assignment]

_EMPTY = ""

SendMessageFn = Callable[..., Awaitable[None]]


class TranscriptForwardingObserver(BaseObserver):
    """Forward user transcripts and bot cumulative-text turns.

    Args:
        send_message: The :py:meth:`CallSession._send_message` bound method.
            Called with positional ``message`` dict (``{type: data}``) and
            keyword ``is_final``.
        mode: ``"pipeline"`` to consume :class:`TTSTextFrame` only;
            ``"realtime"`` to consume :class:`LLMTextFrame` only.
            See the module docstring for why this matters — listening to
            both produces duplicated bot text.
    """

    def __init__(
        self, send_message: SendMessageFn, *, mode: VoiceMode = "pipeline"
    ) -> None:
        super().__init__()
        self._send_message = send_message
        self._mode: VoiceMode = mode
        # Drop duplicate emissions of the same (final, text) pair to avoid
        # writing identical rows when frames re-emit through multiple
        # processors.
        self._last: dict[str, tuple[bool, str]] = {}
        # Bot-side accumulator. The per-chunk text frame source depends on
        # ``mode`` — see the module docstring.
        self._bot_buffer: str = ""

    async def on_push_frame(self, data: FramePushed) -> None:
        src = data.source
        frame = data.frame

        # ----- User transcripts -----
        # Source-filter to the frame's originator class so we only count
        # each frame ONCE — Pipecat observers fire on every push between
        # processors, and an unfiltered handler would re-emit (and
        # re-accumulate) the same chunk 2-3 times as the frame travels
        # downstream.
        #
        # User transcripts originate from either an STT service (pipeline
        # mode) or a realtime LLM service that does its own transcription
        # (OpenAIRealtimeLLMService, GeminiLiveLLMService — both subclass
        # LLMService). Accept from either.
        if isinstance(frame, TranscriptionFrame):
            if isinstance(src, (STTService, LLMService)):
                await self._emit("user", frame.text or _EMPTY, is_final=True)
            return
        if isinstance(frame, InterimTranscriptionFrame):
            if isinstance(src, (STTService, LLMService)):
                await self._emit("user", frame.text or _EMPTY, is_final=False)
            return

        # ----- Bot turn boundaries -----
        # These are SystemFrames and only one processor in the pipeline
        # ever originates them, so explicit source filtering isn't needed
        # — but the handlers are idempotent enough that re-firing doesn't
        # cause duplicate emissions.
        if isinstance(frame, BotStartedSpeakingFrame):
            # Defensive flush: if the previous turn never got its
            # BotStoppedSpeaking / UserStartedSpeaking signal, finalise it
            # now before the new turn starts.
            await self._finalise_bot_turn()
            return

        if isinstance(frame, BotStoppedSpeakingFrame):
            await self._finalise_bot_turn()
            return

        if isinstance(frame, UserStartedSpeakingFrame):
            # Turn-stealing: the user interrupted. If the bot was still
            # mid-utterance and BotStoppedSpeaking would otherwise never
            # fire (or would fire after the next assistant turn already
            # started), flush the bot buffer here so the previous turn's
            # transcript lands as final.
            await self._finalise_bot_turn()
            return

        # ----- Bot per-chunk text -----
        # Mode-gated: pipeline consumes TTSTextFrame, realtime consumes
        # LLMTextFrame. Accepting both in pipeline mode produces "You're
        # welcome! If You're welcome!"-style mash-ups because LLM and TTS
        # carry the same content. Source filtering (originator class) is
        # still applied within each mode to avoid double-counting from
        # downstream re-pushes.
        if (
            self._mode == "pipeline"
            and TTSTextFrame is not None
            and isinstance(frame, TTSTextFrame)
        ):
            if TTSService is not None and isinstance(src, TTSService):
                await self._append_bot_chunk(frame.text or _EMPTY, join_with=" ")
            return

        if (
            self._mode == "realtime"
            and LLMTextFrame is not None
            and isinstance(frame, LLMTextFrame)
        ):
            # Realtime LLMs stream bot text as LLMTextFrame deltas. Unlike
            # TTSTextFrame's sentence-sized chunks, these are typically
            # word- or token-sized; concatenate without inserting a
            # separator to preserve the original whitespace.
            if isinstance(src, LLMService):
                await self._append_bot_chunk(frame.text or _EMPTY, join_with="")
            return

    async def _append_bot_chunk(self, chunk: str, *, join_with: str) -> None:
        if not chunk:
            return
        if self._bot_buffer and join_with:
            self._bot_buffer = f"{self._bot_buffer}{join_with}{chunk}"
        else:
            self._bot_buffer = (self._bot_buffer + chunk).strip() if not join_with else (
                f"{self._bot_buffer}{join_with}{chunk}".strip()
            )
        # For TTSTextFrame (join_with=" ") trim leading/trailing whitespace
        # so consecutive sentences read naturally; for LLMTextFrame
        # (join_with="") preserve internal whitespace.
        if join_with == " ":
            self._bot_buffer = self._bot_buffer.strip()
        await self._emit("agent", self._bot_buffer, is_final=False)

    async def _finalise_bot_turn(self) -> None:
        """Emit the accumulated bot text as ``isFinal: true`` if there is
        anything pending, then reset.
        """
        if self._bot_buffer:
            await self._emit("agent", self._bot_buffer, is_final=True)
        self._bot_buffer = ""
        # The next BotStartedSpeakingFrame will start a fresh turn — but
        # clear the dedupe cache eagerly so an identical interim text in
        # the next turn isn't suppressed.
        self._last.pop("agent", None)

    async def _emit(self, type_: str, text: str, *, is_final: bool) -> None:
        if not text:
            return
        last = self._last.get(type_)
        signature = (is_final, text)
        if last == signature:
            return
        self._last[type_] = signature
        try:
            await self._send_message({type_: text}, is_final=is_final)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"transcript emit failed: {e}")
        # Resetting the dedupe cache on final lets the next turn start
        # a fresh isFinal=False sequence at the same text.
        if is_final:
            self._last.pop(type_, None)
