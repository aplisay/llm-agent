"""The Pipecat side of GPT-Live: a subclass of upstream's
``OpenAILiveLLMService`` with the platform's injection shim, client
delegation through the subagent endpoint, ``vendorSpecific`` merge and
provider-close handling, plus the DTMF aggregator that feeds the shim.

Why a subclass rather than event handlers:

- Nothing injected as a context message reaches the live model after
  ``session.start``. The greeting, inactivity prompt and DTMF digits need the
  Live API's append and typed-input events, sent with ``send_client_event``.
- Upstream's client delegation runs a ``BackendLLMWorker`` under a
  ``WorkerRunner``; this worker runs plain ``PipelineTask``s and its backend
  is the platform's subagent endpoint. With ``delegation=None`` upstream
  declines every delegation out loud, so the handler is replaced here.
- ``vendorSpecific.openai.live`` has to land inside ``session.start``, which
  upstream builds privately; the payload is merged on the way out.
- ``session.closed`` with ``expired``, ``content`` or ``connection_lost``
  must end the call cleanly; upstream only unblocks its own graceful close.
- a responses delegation the backend refuses has to be revived, or the caller
  is left on a live but silent line. Upstream reports the refusal and stops
  there, which is correct for a library and fatal for a phone call; see the
  delegation recovery section below.

The pure composition (delegate resolution, prompts, tool merge) is in
:mod:`pipecat_aplisay.gpt_live`.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from typing import Any, Awaitable, Callable, Optional

from loguru import logger
from pipecat.frames.frames import InputAudioRawFrame
from pipecat.processors.aggregators.dtmf_aggregator import DTMFAggregator
from pipecat.metrics.metrics import LLMTokenUsage
from pipecat.services.openai.live import events
from pipecat.services.openai.live.llm import (
    MAX_CONTEXT_APPEND_TOKENS,
    OpenAILiveLLMService,
    ResponsesDelegation,
    _chunk_text,
)
from pipecat.services.openai.responses.llm import (
    OpenAIResponsesLLMSettings,
    OpenAIResponsesReasoningConfig,
)

from . import gpt_live
from .gpt_live import GptLiveSession, deep_merge

#: ``session.closed`` reasons that mean the provider ended the session on its
#: side, so the call must end too. ``close_requested`` is our own graceful
#: close; ``remote_hangup`` is the transport going away, which the pipeline
#: already handles.
PROVIDER_ENDED_REASONS = frozenset({"expired", "content", "connection_lost"})

#: What the voice model says when a client delegation fails.
DELEGATION_FAILED_COMMENTARY = "Apologise briefly: you could not complete that request just now."

#: Longest the greeting guard keeps the caller inaudible when the model never
#: closes its opening turn (it should within a few seconds).
GREETING_GUARD_MAX_SECS = 20.0

#: What the voice model says when the delegation could not be revived. Distinct
#: from DELEGATION_FAILED_COMMENTARY: that one covers one failed request, this
#: admits the lookup itself is unavailable, so the model stops promising to go
#: and check.
DELEGATION_STRANDED_COMMENTARY = (
    "Tell the caller you could not look that up just now, apologise briefly, and offer to help "
    "with what you already know or to take a message. Do not say you will check again."
)

#: Bound silent delegation recovery even while the voice session itself remains healthy. See PR #320.
DEAD_AIR_GRACE_SECS = 4.0

#: Function-call-output events remembered for error correlation. The backend
#: echoes the client event id on a rejection, which is how a refused item is
#: traced back to its call; only the in-flight handful can ever be referenced.
_OUTPUT_EVENT_MEMORY = 64

ClientDelegate = Callable[[list[dict], bool], Awaitable[str]]


def _function_output_call_id(event: events.ClientEvent) -> Optional[str]:
    """The call a ``response.item.create`` answers, or None for other events.

    The item is typed when upstream builds it and a plain dict when it comes
    from elsewhere, so both shapes are read.
    """
    if not isinstance(event, events.ResponseItemCreateEvent):
        return None
    item = event.item
    if isinstance(item, events.FunctionCallOutputItem):
        return item.call_id
    if isinstance(item, dict) and item.get("type") == "function_call_output":
        call_id = item.get("call_id")
        return call_id if isinstance(call_id, str) else None
    return None


class AplisayOpenAILiveLLMService(OpenAILiveLLMService):
    """``OpenAILiveLLMService`` plus the platform's session controls."""

    def __init__(
        self,
        *,
        live_overrides: Optional[dict] = None,
        on_session_ended: Optional[Callable[[str], Awaitable[None]]] = None,
        client_delegate: Optional[ClientDelegate] = None,
        client_delegate_timeout_secs: float = 90.0,
        deaf_during_greeting: bool = False,
        **kwargs: Any,
    ) -> None:
        super().__init__(**kwargs)
        self._live_overrides = dict(live_overrides or {})
        self._on_session_ended = on_session_ended
        self._client_delegate = client_delegate
        self._client_delegate_timeout_secs = client_delegate_timeout_secs
        # The greeting contract: caller audio is dropped until the opening
        # line completes. The pipeline's mute strategy cannot do that here (a
        # muted session sends no audio and the Live API's timeline stands
        # still), so the guard sends silence in place of the caller's audio
        # until the first assistant turn closes, or GREETING_GUARD_MAX_SECS.
        self._deaf_during_greeting = deaf_during_greeting
        self._greeting_guard_until: float | None = None
        # Typed input that arrived while no delegation was running (client
        # mode): prepended to the next delegation's transcript.
        self._pending_typed_inputs: list[str] = []
        # Delegation recovery state (responses mode). `_output_event_calls`
        # maps a sent client event id to the call it answered, so a rejection
        # naming that event id identifies the call whose result was dropped.
        self._output_event_calls: OrderedDict[str, str] = OrderedDict()
        self._stubbed_calls: set[str] = set()
        self._dead_air_guard: Optional[asyncio.Task] = None
        self._delegation_stranded = False
        #: The ``{vendor, model}`` backend tokens are metered against (the
        #: service labels its own metrics ``gpt-live-1``). Set by the factory.
        self.aplisay_backend: Optional[dict[str, Optional[str]]] = None

    # ---- outbound events -------------------------------------------------

    @property
    def responses_mode(self) -> bool:
        return isinstance(self._delegation, ResponsesDelegation)

    async def send_client_event(self, event: events.ClientEvent) -> None:
        """Upstream's send, with ``vendorSpecific.openai.live`` merged into
        ``session.start`` so an explicit value there wins.

        Also notes which call each function-call output answered. Upstream
        builds and sends those events itself, and the only handle on a
        rejection is the client event id the backend echoes back, so the
        mapping has to be captured here on the way out.
        """
        call_id = _function_output_call_id(event)
        if call_id is not None:
            self._output_event_calls[event.event_id] = call_id
            while len(self._output_event_calls) > _OUTPUT_EVENT_MEMORY:
                self._output_event_calls.popitem(last=False)
        if isinstance(event, events.SessionStartEvent) and self._live_overrides:
            payload = event.to_payload()
            payload["session"] = deep_merge(payload.get("session") or {}, self._live_overrides)
            logger.debug(f"{self}: session.start with vendorSpecific overrides {sorted(self._live_overrides)}")
            await self._ws_send(payload)
            return
        await super().send_client_event(event)

    async def _append(self, event_class: type, text: str, *, delegation_id: Optional[str] = None) -> None:
        for chunk in _chunk_text(text, MAX_CONTEXT_APPEND_TOKENS):
            await self.send_client_event(event_class(delegation_id=delegation_id, content=chunk))

    async def append_commentary(self, text: str, *, delegation_id: Optional[str] = None) -> None:
        """Speakable context: the model says it in its own words."""
        await self._append(events.SessionCommentaryAppendEvent, text, delegation_id=delegation_id)

    async def append_thinking(self, text: str, *, delegation_id: Optional[str] = None) -> None:
        """Silent context the model may draw on later."""
        await self._append(events.SessionThinkingAppendEvent, text, delegation_id=delegation_id)

    async def append_instructions(self, text: str) -> None:
        """Standing rules added to the startup instructions."""
        await self._append(events.SessionInstructionsAppendEvent, text)

    async def typed_input(self, text: str) -> None:
        """Typed input for the backend. Responses mode: a user message item
        plus ``response.create``. Client mode: queued for the next delegation."""
        if not self.responses_mode:
            self._pending_typed_inputs.append(text)
            return
        await self.send_client_event(
            events.ResponseItemCreateEvent(
                item={
                    "type": "message",
                    "role": "user",
                    "content": [{"type": "input_text", "text": text}],
                }
            )
        )
        await self.send_client_event(events.ResponseCreateEvent())

    async def inject_dtmf(self, digits: str) -> None:
        """Keypad digits: typed input for the backend, context for the voice model."""
        if not self._session_started:
            logger.debug(f"{self}: dropping DTMF {digits!r}; the session has not started")
            return
        await self.typed_input(gpt_live.dtmf_typed_input(digits))
        await self.append_thinking(gpt_live.dtmf_thinking(digits))

    async def inject_inactivity_prompt(self, message: str) -> None:
        """The inactivity kick: spoken context carrying the configured message."""
        if not self._session_started:
            return
        await self.append_commentary(gpt_live.inactivity_commentary(message))

    # ---- greeting guard ----------------------------------------------------

    @property
    def greeting_guard_active(self) -> bool:
        until = self._greeting_guard_until
        if until is None:
            return False
        if asyncio.get_running_loop().time() >= until:
            self._greeting_guard_until = None
            logger.debug(f"{self}: greeting guard expired")
            return False
        return True

    async def _send_user_audio(self, frame) -> None:  # type: ignore[override]
        if self.greeting_guard_active:
            frame = InputAudioRawFrame(
                audio=b"\x00" * len(frame.audio),
                sample_rate=frame.sample_rate,
                num_channels=frame.num_channels,
            )
        await super()._send_user_audio(frame)

    async def _end_turn(self, role: str) -> None:  # type: ignore[override]
        await super()._end_turn(role)
        if role == "assistant" and self._greeting_guard_until is not None:
            self._greeting_guard_until = None
            logger.debug(f"{self}: greeting complete; caller audio passes through")

    # ---- inbound events --------------------------------------------------

    async def _handle_evt_session_started(self, evt: events.SessionStartedEvent) -> None:
        if self._deaf_during_greeting and self._opening_instruction:
            self._greeting_guard_until = asyncio.get_running_loop().time() + GREETING_GUARD_MAX_SECS
        await super()._handle_evt_session_started(evt)
        mode = "responses" if self.responses_mode else "client"
        logger.bind(event="delegation_mode", mode=mode, session=getattr(evt.session, "id", None)).info(
            f"GPT-Live session started ({mode} delegation)"
        )

    async def _handle_evt_delegation_created(self, evt: events.SessionDelegationCreatedEvent) -> None:
        delegation = evt.delegation
        logger.bind(
            event="delegation",
            delegation_id=delegation.id,
            target=delegation.target,
            response_id=delegation.response_id,
        ).info(f"delegation {delegation.id} created (target={delegation.target})")
        # A fresh delegation is a fresh chance: drop the previous one's
        # recovery state so a later fault is stubbed and announced on its own
        # merits. `_delegation_stranded` is deliberately NOT cleared — the
        # input budget is per session, so once it is exhausted every
        # delegation after it fails the same way and the caller should not be
        # apologised to once per attempt.
        self._stubbed_calls.clear()
        self._cancel_dead_air_guard()
        await super()._handle_evt_delegation_created(evt)

    # Reconcile refused tool outputs with small placeholders before resuming; the backend may still consider them
    # unanswered. Independently prompt the voice model if recovery stays silent; see PR #320.

    async def _handle_evt_error(self, evt: events.ErrorEvent) -> None:
        await super()._handle_evt_error(evt)
        if not self.responses_mode:
            return
        code = (evt.error.code or "").strip()
        if code == gpt_live.ERROR_INPUT_BUFFER_FULL:
            await self._on_output_rejected(evt)
        elif code == gpt_live.ERROR_OUTPUTS_REQUIRED:
            await self._on_outputs_required(evt)

    async def _on_output_rejected(self, evt: events.ErrorEvent) -> None:
        """One item did not fit the delegation's input budget.

        When the rejected item was a function-call output, the call it
        answered is now unanswerable by any real result, so substitute the
        stub immediately rather than waiting for the backend to complain.
        """
        call_id = self._output_event_calls.get(evt.error.client_event_id or "")
        if call_id is None:
            # Something other than a tool result was refused (or the backend
            # did not correlate it). Nothing to substitute, but the delegation
            # is in trouble, so make sure the caller hears about it.
            self._arm_dead_air_guard("input buffer full")
            return
        if call_id in self._stubbed_calls:
            # The stub itself was refused: the budget is exhausted beyond what
            # a few dozen bytes can fix. Stop trying and let the guard speak.
            logger.bind(event="delegation_recovery", call_id=call_id, ok=False).warning(
                "delegation recovery: even the placeholder output was refused"
            )
            self._arm_dead_air_guard("placeholder refused")
            return
        await self._send_stub_output(call_id, reason="output refused as too large")
        self._arm_dead_air_guard("output refused")

    async def _on_outputs_required(self, evt: events.ErrorEvent) -> None:
        """The backend will not continue while calls are unanswered.

        The message names them; that prose list is the only machine-readable
        part of the error. Stub whatever is still outstanding and continue.
        """
        call_ids = gpt_live.missing_call_ids(evt.error.message)
        if not call_ids:
            self._arm_dead_air_guard("outputs required, none named")
            return
        outstanding = [c for c in call_ids if c not in self._stubbed_calls]
        for call_id in outstanding:
            await self._send_stub_output(call_id, reason="backend reported it unanswered")
        logger.bind(
            event="delegation_recovery",
            calls=call_ids,
            stubbed=outstanding,
            ok=True,
        ).info(
            f"delegation recovery: answered {len(outstanding)} of {len(call_ids)} stranded "
            "call(s) with a placeholder and resumed the response"
        )
        # Upstream already sent its own `response.create`, which is what the
        # backend refused. Now that nothing is owed, ask again.
        await self.send_client_event(events.ResponseCreateEvent())
        self._arm_dead_air_guard("response resumed")

    async def _send_stub_output(self, call_id: str, *, reason: str) -> None:
        self._stubbed_calls.add(call_id)
        logger.bind(event="delegation_recovery", call_id=call_id, reason=reason).warning(
            f"delegation recovery: substituting a placeholder result for {call_id} ({reason})"
        )
        await self.send_client_event(
            events.ResponseItemCreateEvent(
                item=events.FunctionCallOutputItem(
                    call_id=call_id, output=gpt_live.dropped_output_stub(call_id),
                )
            )
        )

    async def _handle_evt_response(self, evt: events.ResponseEventEnvelope) -> None:
        # Any delegated response event means the delegation is producing
        # again, so the caller is about to hear something and the guard is no
        # longer needed. This is the single dispatch point upstream routes
        # every `response.*` lifecycle event through.
        self._cancel_dead_air_guard()
        await super()._handle_evt_response(evt)

    def _arm_dead_air_guard(self, why: str) -> None:
        """Keep recovery available before the task manager starts; retain the fallback task for cancellation on shutdown. See
        PR #320."""
        if self._delegation_stranded:
            return  # already apologised; a second apology is worse than none
        self._cancel_dead_air_guard()
        coro = self._dead_air_watch(why)
        try:
            self._dead_air_guard = self.create_task(coro, "delegation:dead-air")
        except Exception:  # noqa: BLE001
            self._dead_air_guard = asyncio.get_running_loop().create_task(coro)

    def _cancel_dead_air_guard(self) -> None:
        guard, self._dead_air_guard = self._dead_air_guard, None
        if guard is not None and not guard.done():
            guard.cancel()

    async def _dead_air_watch(self, why: str) -> None:
        try:
            await asyncio.sleep(DEAD_AIR_GRACE_SECS)
        except asyncio.CancelledError:
            return
        self._delegation_stranded = True
        logger.bind(event="delegation_recovery", reason=why, ok=False).error(
            f"delegation stranded ({why}): nothing from the backend in "
            f"{DEAD_AIR_GRACE_SECS:.0f}s — telling the voice model to speak"
        )
        try:
            await self.append_commentary(DELEGATION_STRANDED_COMMENTARY)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"delegation recovery: could not prompt the voice model: {e}")

    async def _handle_evt_session_closed(self, evt: events.SessionClosedEvent) -> None:
        reason = evt.reason or ""
        usage = getattr(evt.usage, "seconds", None) if evt.usage else None
        logger.bind(event="session_closed", reason=reason, seconds=usage).info(
            f"GPT-Live session closed ({reason or 'no reason'})"
        )
        await super()._handle_evt_session_closed(evt)
        if reason in PROVIDER_ENDED_REASONS and not self._disconnecting and self._on_session_ended:
            try:
                await self._on_session_ended(reason)
            except Exception as e:  # noqa: BLE001
                logger.warning(f"{self}: on_session_ended raised: {e}")

    async def _report_usage(self, usage: events.Usage) -> None:
        """Log the session's cumulative seconds at INFO (the API reports them
        every 15 s and on close). Not metered in this phase: the call's own
        ``voice`` row carries the minutes."""
        seconds = getattr(usage, "seconds", None)
        if seconds is not None:
            logger.bind(event="live_usage", seconds=seconds).info(
                f"GPT-Live session usage: {seconds:.0f}s (cumulative)"
            )

    async def _report_backend_usage(self, response: dict[str, Any]) -> None:
        """Upstream's backend token report, plus the cache write tokens the
        Responses usage object carries (``input_tokens_details.cache_write_tokens``,
        seen in the P0 spike) so the ledger's cache-write meter is fed too."""
        usage = response.get("usage")
        if not isinstance(usage, dict):
            return
        details = usage.get("input_tokens_details") or {}
        output_details = usage.get("output_tokens_details") or {}
        tokens = LLMTokenUsage(
            prompt_tokens=usage.get("input_tokens") or 0,
            completion_tokens=usage.get("output_tokens") or 0,
            total_tokens=usage.get("total_tokens") or 0,
            cache_read_input_tokens=details.get("cached_tokens") or 0,
            cache_creation_input_tokens=details.get("cache_write_tokens") or 0,
            reasoning_tokens=output_details.get("reasoning_tokens") or 0,
        )
        if tokens.total_tokens > 0:
            await self.start_llm_usage_metrics(tokens)

    # ---- client delegation through the platform ---------------------------

    def _remember_fragment(self, role: str, delta: str) -> None:  # type: ignore[override]
        """Upstream keeps the transcript ledger only with a ``ClientDelegation``
        backend; keep it whenever the platform delegate is the backend."""
        if self._client_delegate is None:
            super()._remember_fragment(role, delta)  # type: ignore[arg-type]
            return
        fragments = self._transcript_fragments
        if fragments and fragments[-1]["role"] == role:
            fragments[-1]["content"] += delta
        elif delta.strip():
            fragments.append({"role": role, "content": delta.lstrip()})

    async def _handle_client_delegation(self, delegation: events.DelegationMetadata) -> None:
        if self._client_delegate is None:
            await super()._handle_client_delegation(delegation)
            return
        task = self.create_task(
            self._run_platform_delegation(delegation), f"delegation:{delegation.id}"
        )
        self._delegation_tasks[delegation.id] = task
        task.add_done_callback(lambda _: self._delegation_tasks.pop(delegation.id, None))

    async def _run_platform_delegation(self, delegation: events.DelegationMetadata) -> None:
        assert self._client_delegate is not None
        transcript = self._take_transcript()
        typed, self._pending_typed_inputs = self._pending_typed_inputs, []
        messages: list[dict] = [{"role": "user", "content": text} for text in typed]
        messages.extend({"role": m["role"], "content": m["content"]} for m in transcript)
        first = not self._delegated_before
        self._delegated_before = True
        started = asyncio.get_running_loop().time()
        try:
            text = await asyncio.wait_for(
                self._client_delegate(messages, first), timeout=self._client_delegate_timeout_secs
            )
        except Exception as e:  # noqa: BLE001
            logger.bind(event="delegation_result", delegation_id=delegation.id, ok=False, error=str(e)).warning(
                f"delegation {delegation.id} failed: {e}"
            )
            await self.append_commentary(DELEGATION_FAILED_COMMENTARY, delegation_id=delegation.id)
            return
        duration_ms = int((asyncio.get_running_loop().time() - started) * 1000)
        text = (text or "").strip()
        if not text:
            logger.bind(event="delegation_result", delegation_id=delegation.id, ok=True, duration_ms=duration_ms).warning(
                f"delegation {delegation.id} produced no text"
            )
            text = "The request finished without an answer; tell the caller you could not get an answer."
        else:
            logger.bind(event="delegation_result", delegation_id=delegation.id, ok=True, duration_ms=duration_ms).info(
                f"delegation {delegation.id} answered ({len(text)} chars)"
            )
        await self.append_commentary(text, delegation_id=delegation.id)


class GptLiveDtmfAggregator(DTMFAggregator):
    """The platform's DTMF aggregator for GPT-Live: an aggregated digit
    string goes to ``on_digits`` (the injection shim and the transcript log)
    instead of becoming a ``TranscriptionFrame`` the live session would never
    see."""

    def __init__(self, *, on_digits: Callable[[str], Awaitable[None]], **kwargs: Any) -> None:
        super().__init__(**kwargs)
        self._on_digits = on_digits

    async def _flush_aggregation(self) -> None:
        if not self._aggregation:
            return
        sequence, self._aggregation = self._aggregation, ""
        try:
            await self._on_digits(sequence)
        except Exception as e:  # noqa: BLE001
            logger.warning(f"DTMF injection failed: {e}")


def build_gpt_live_service(
    *,
    api_key: str,
    voice: Optional[str],
    session: GptLiveSession,
    transcript_tts: bool = False,
) -> AplisayOpenAILiveLLMService:
    """Construct the service for one session from its resolved composition."""
    delegate = session.delegate
    delegation: Optional[ResponsesDelegation] = None
    client_delegate: Optional[ClientDelegate] = None
    if delegate.mode == gpt_live.MODE_RESPONSES:
        settings_kwargs: dict[str, Any] = {
            "model": delegate.backend_model,
            "system_instruction": session.backend_instructions,
        }
        effort = session.settings.get("effort")
        if effort:
            settings_kwargs["reasoning"] = OpenAIResponsesReasoningConfig(effort=effort)
        max_tokens = session.settings.get("max_tokens")
        if max_tokens:
            settings_kwargs["max_completion_tokens"] = max_tokens
        delegation = ResponsesDelegation(settings=OpenAIResponsesLLMSettings(**settings_kwargs))
    else:
        client_delegate = session.client_delegate

    service_class = AplisayOpenAILiveLLMService
    if transcript_tts:
        from .gpt_live_transcript_tts import GptLiveTranscriptTtsService

        service_class = GptLiveTranscriptTtsService
    llm = service_class(
        api_key=api_key,
        settings=AplisayOpenAILiveLLMService.Settings(
            system_instruction=session.voice_instructions,
            voice=(
                gpt_live.GPT_LIVE_DEFAULT_VOICE
                if transcript_tts else voice or gpt_live.GPT_LIVE_DEFAULT_VOICE
            ),
        ),
        delegation=delegation,
        live_overrides=session.overrides,
        on_session_ended=session.on_session_ended,
        client_delegate=client_delegate,
        deaf_during_greeting=session.deaf_during_greeting,
    )
    llm.aplisay_backend = delegate.usage_backend
    return llm
