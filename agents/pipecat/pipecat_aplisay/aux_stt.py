"""Auxiliary ("second opinion") speech recognition — ``options.stt.aux``.

Runs a second, independent STT engine over the caller's audio alongside the
agent's own recognition (the pipeline STT, or a realtime model's built-in
transcription) and logs each final transcript it produces as a ``user-aux``
transaction-log entry next to the primary ``user`` entry, so two recognitions
of the same speech can be compared. The auxiliary engine never feeds the model
— it is observation only.

Mechanism: an :class:`AuxSttTap` sits right after ``transport.input()`` (behind
the WebRTC relay tap, so an engaged relay silences it too). It passes every
frame through untouched and copies each ``InputAudioRawFrame`` into a side
STT-only pipeline (:class:`~pipecat_aplisay.bridge_transcript.SttStream` — the
same helper the bridged-segment transcription uses), so the auxiliary service
never sits in the main chain: none of its transcription, metrics or settings
frames can reach the context aggregator or the primary STT, and an STT control
frame aimed at the primary engine is never swallowed by the wrong service.

The engine is built by ``voice_session.build_stt_service`` with
``options.stt.aux`` standing in for ``options.stt`` (:func:`aux_stt_agent`), so
the same vendor strings mean the same thing in both places.

Metering: the audio streamed to the auxiliary engine is measured at the tap
(milliseconds, silence included — the basis streaming STT vendors bill on) and
final transcripts are counted in characters. Pipecat's STT services expose no
"audio the vendor accepted" figure, so streamed audio is metered only once the
engine has proved itself by returning a transcript in this call: until then the
milliseconds are held back, and an engine that never produces one (rejected
credentials, a dead connection) meters nothing rather than billing the caller
for a service that delivered nothing. Both meters are reported through
``on_usage`` and land as ``stt-aux`` usage rows — their own technology, so the
second engine's consumption is neither merged with nor gated like the primary
``stt`` meter (a realtime model bundles its own recognition into the model
charge; the auxiliary engine is a real extra cost on every voice mode).

Everything here is best-effort: an auxiliary STT failure must never disturb
the call. See docs/auxiliary-stt.md.
"""

from __future__ import annotations

import asyncio
from typing import Any, Awaitable, Callable, Optional

from loguru import logger
from pipecat.frames.frames import CancelFrame, EndFrame, InputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from .bridge_transcript import SttStream

#: Ledger technology for auxiliary-STT usage rows (distinct from the primary ``stt``).
AUX_STT_TECHNOLOGY = "stt-aux"
#: Transaction-log type for auxiliary transcripts (next to the primary ``user``).
AUX_STT_LOG_TYPE = "user-aux"
#: Default engine when ``options.stt.aux.vendor`` is unset — the pipeline default.
DEFAULT_AUX_STT_VENDOR = "deepgram"


def parse_aux_stt_option(options: Optional[dict]) -> Optional[dict]:
    """Normalise ``options.stt.aux`` to ``None`` (off) or
    ``{"vendor": Optional[str], "language": Optional[str]}``. Lenient — the
    server validated the shape at save time: absent / ``False`` /
    ``enabled: False`` / malformed → off; ``True`` or ``{}`` → defaults."""
    stt_opts = (options or {}).get("stt")
    if not isinstance(stt_opts, dict):
        return None
    raw = stt_opts.get("aux")
    if raw is None or raw is False:
        return None
    if raw is True:
        return {"vendor": None, "language": None}
    if not isinstance(raw, dict) or raw.get("enabled") is False:
        return None
    vendor = raw.get("vendor")
    language = raw.get("language")
    return {
        "vendor": vendor.strip() if isinstance(vendor, str) and vendor.strip() else None,
        "language": language.strip() if isinstance(language, str) and language.strip() else None,
    }


def aux_stt_agent(agent: dict, config: dict) -> dict:
    """The agent with ``options.stt.aux`` standing in for ``options.stt``, so
    ``build_stt_service`` constructs the auxiliary engine exactly as it would
    the primary one. Language falls back to the agent's own ``stt.language``,
    then ``tts.language`` (the platform's declare-once convention); the nested
    ``aux`` block itself is dropped."""
    options = dict(agent.get("options") or {})
    stt_opts = options.get("stt") or {}
    tts_opts = options.get("tts") or {}
    language = (
        config.get("language")
        or (stt_opts.get("language") if isinstance(stt_opts, dict) else None)
        or (tts_opts.get("language") if isinstance(tts_opts, dict) else None)
    )
    block: dict = {}
    if config.get("vendor"):
        block["vendor"] = config["vendor"]
    if language:
        block["language"] = language
    options["stt"] = block
    return {**agent, "options": options}


def aux_stt_vendor(agent: dict, config: dict) -> dict:
    """Canonical ``{vendor, model}`` for the auxiliary engine's usage rows:
    ``vendor`` is the bare engine name (what the rate lines match on);
    ``model`` is ``vendor/model`` when the vendor string was scoped
    (``deepgram/nova-3``), else ``None``."""
    stt_opts = (aux_stt_agent(agent, config).get("options") or {}).get("stt") or {}
    raw = str(stt_opts.get("vendor") or DEFAULT_AUX_STT_VENDOR)
    head = raw.split(":", 1)[0]
    vendor = head.split("/", 1)[0].strip().lower()
    model = head.split("/", 1)[1].strip() if "/" in head else None
    return {"vendor": vendor, "model": f"{vendor}/{model}" if model else None}


OnFinal = Callable[[str], Awaitable[None]]
OnUsage = Callable[[str, int], None]


class AuxSttTap(FrameProcessor):
    """Pass-through processor that copies caller audio into a side STT-only
    pipeline and forwards its final transcripts + usage.

    Args:
        stt_factory: builds the auxiliary STT service (called once, lazily, on
            the first audio frame so a build failure only costs the second
            opinion, never the call).
        on_final: awaited with each non-empty final transcript.
        on_usage: called with ``("milliseconds", n)`` as audio is streamed to
            the engine and ``("characters", n)`` per final transcript.
        stream_factory: test seam — builds the side pipeline; defaults to
            :class:`SttStream`.
    """

    def __init__(
        self,
        *,
        stt_factory: Callable[[], Any],
        on_final: OnFinal,
        on_usage: Optional[OnUsage] = None,
        stream_factory: Optional[Callable[..., Any]] = None,
        name: Optional[str] = None,
    ) -> None:
        super().__init__(name=name or "AuxSttTap")
        self._stt_factory = stt_factory
        self._on_final = on_final
        self._on_usage: OnUsage = on_usage or (lambda _unit, _qty: None)
        self._stream_factory = stream_factory or SttStream
        self._stream: Optional[Any] = None
        self._sample_rate: Optional[int] = None
        self._num_channels: Optional[int] = None
        self._failed = False
        self._rate_warned = False
        self._milliseconds: float = 0.0
        self._reported_ms = 0
        self._characters = 0
        # Streamed milliseconds held back until the engine returns its first
        # transcript (see module docstring); dropped if it never does.
        self._pending_ms = 0
        self._proven = False
        self._stop_task: Optional[asyncio.Task] = None

    @property
    def usage(self) -> dict:
        """Audio milliseconds streamed to the engine and characters it returned."""
        return {"milliseconds": int(self._milliseconds), "characters": self._characters}

    async def process_frame(self, frame, direction: FrameDirection):  # noqa: ANN001
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame) and direction == FrameDirection.DOWNSTREAM:
            await self._tap_audio(frame)
        elif isinstance(frame, (EndFrame, CancelFrame)):
            self._schedule_stop()
        await self.push_frame(frame, direction)

    async def _tap_audio(self, frame: InputAudioRawFrame) -> None:
        if self._failed:
            return
        try:
            if self._stream is None:
                self._sample_rate = frame.sample_rate
                self._num_channels = frame.num_channels
                self._stream = self._stream_factory(
                    self._stt_factory(),
                    self._collect_final,
                    sample_rate=frame.sample_rate,
                    num_channels=frame.num_channels,
                )
                await self._stream.start()
                logger.info(
                    f"auxStt: auxiliary transcription armed "
                    f"({frame.sample_rate} Hz, {frame.num_channels} ch)"
                )
            if frame.sample_rate != self._sample_rate or frame.num_channels != self._num_channels:
                # The side pipeline was started at the first frame's format;
                # a mid-call change would need a rebuild — drop rather than
                # feed the engine audio it will mis-decode.
                if not self._rate_warned:
                    self._rate_warned = True
                    logger.warning(
                        "auxStt: input audio format changed mid-call; dropping mismatched frames"
                    )
                return
            await self._stream.feed(frame.audio)
            self._milliseconds += frame.num_frames / frame.sample_rate * 1000.0
            self._report_audio()
        except Exception as e:  # noqa: BLE001
            # Best-effort: the call carries on without the second opinion.
            self._failed = True
            logger.warning(f"auxStt: auxiliary transcription failed (continuing without it): {e}")
            self._schedule_stop()

    def _report_audio(self) -> None:
        """Account for streamed audio not yet accounted for (whole milliseconds, no
        drift): metered straight away once the engine has proved itself, held
        back until then."""
        delta = int(self._milliseconds) - self._reported_ms
        if delta <= 0:
            return
        self._reported_ms += delta
        if not self._proven:
            self._pending_ms += delta
            return
        self._emit_usage("milliseconds", delta)

    def _emit_usage(self, unit: str, quantity: int) -> None:
        try:
            self._on_usage(unit, quantity)
        except Exception as e:  # noqa: BLE001
            logger.debug(f"auxStt: usage report failed: {e}")

    async def _collect_final(self, text: str) -> None:
        text = (text or "").strip()
        if not text:
            return
        if not self._proven:
            # The engine works: meter what was streamed before this first transcript too.
            self._proven = True
            pending, self._pending_ms = self._pending_ms, 0
            if pending:
                self._emit_usage("milliseconds", pending)
        self._characters += len(text)
        self._emit_usage("characters", len(text))
        try:
            await self._on_final(text)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"auxStt: transcript handler failed: {e}")

    def _schedule_stop(self) -> None:
        """Tear the side pipeline down without holding up the main chain's own
        End/Cancel processing (its stop waits on the runner, bounded)."""
        stream, self._stream = self._stream, None
        if stream is None:
            return
        self._report_audio()
        self._stop_task = asyncio.create_task(self._stop_stream(stream))

    async def _stop_stream(self, stream: Any) -> None:
        try:
            await stream.stop()
        except Exception as e:  # noqa: BLE001
            logger.debug(f"auxStt: side pipeline stop raised: {e}")
        if not self._proven and self._pending_ms:
            logger.warning(
                f"auxStt: the engine returned no transcript for {self._pending_ms} ms of "
                "streamed audio (connection or credentials failure?); nothing metered"
            )
        logger.info(
            f"auxStt: auxiliary transcription stopped "
            f"({int(self._milliseconds)} ms streamed, {self._characters} chars)"
        )
