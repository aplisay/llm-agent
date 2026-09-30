/**
 * The GPT-Live model as the worker runs it: the SDK's GPTLiveModel behind our own
 * DuplexRealtimeAdapter, which adds what the other realtime models give the runtime (provider-ended,
 * usage attribution) and the Pipecat worker's session behaviour (gpt_live_service.py).
 */
import { llm, shortuuid } from "@livekit/agents";
import * as openai from "@livekit/agents-plugin-openai";
import logger from "./logger.js";
import {
  DELEGATION_FAILED_COMMENTARY,
  DELEGATION_STRANDED_COMMENTARY,
  ERROR_INPUT_BUFFER_FULL,
  ERROR_OUTPUTS_REQUIRED,
  NO_ANSWER_COMMENTARY,
  PROVIDER_ENDED_REASONS,
  chunkText,
  deepMerge,
  droppedOutputStub,
  missingCallIds,
  renderTranscriptRequest,
  subagentAnswerText,
  type TranscriptLine,
} from "./gpt-live.js";
import { logToolCall, logToolResult } from "./tool-log.js";
import type { VendorDetail } from "./usage-vendors.js";

type LiveSession = openai.realtime.GPTLiveSession;
type ServerEvent = { type: string; [key: string]: any };
type ProviderEndedInfo = { reason?: string };

const DEAD_AIR_GRACE_MS = 4_000;
const DELEGATION_TIMEOUT_MS = 90_000;
const MAX_TRACKED_OUTPUTS = 64;

/** The plugin keeps these private; both are plain methods, so an instance override replaces them. */
interface LiveSessionInternals {
  sessionStartEvent(): { session?: Record<string, unknown> };
  queueEvent?(event: Record<string, unknown>, replayOnReconnect: boolean): void;
}

/** Send an event for this connection only: a stub or a resume means nothing after a reconnect. */
function sendOnce(live: LiveSession, event: Record<string, unknown>): void {
  const internals = live as unknown as LiveSessionInternals;
  if (typeof internals.queueEvent === "function") internals.queueEvent.call(live, event, false);
  else live.sendEvent(event);
}

/** `vendorSpecific.openai.live` wins over the portable mapping in every `session.start`. */
function mergeIntoSessionStart(live: LiveSession, overrides: Record<string, unknown>): void {
  if (!Object.keys(overrides).length) return;
  const internals = live as unknown as LiveSessionInternals;
  const build = internals.sessionStartEvent;
  internals.sessionStartEvent = function (this: LiveSession) {
    const event = build.call(this);
    return { ...event, session: deepMerge(event.session ?? {}, overrides) };
  };
}

/**
 * Pipecat's delegation recovery (PR #320): the backend refuses a tool result that overflows its
 * input budget, then waits for it forever. Answer the stranded calls with a stub and resume; if the
 * backend still says nothing, have the voice model tell the caller once.
 */
export function armDelegationRecovery(live: LiveSession, log = logger): void {
  const outputCalls = new Map<string, string>();
  const stubbed = new Set<string>();
  let guard: ReturnType<typeof setTimeout> | undefined;
  let stranded = false;

  const cancelGuard = () => {
    if (guard) clearTimeout(guard);
    guard = undefined;
  };
  const armGuard = (why: string) => {
    if (stranded) return;
    cancelGuard();
    guard = setTimeout(() => {
      stranded = true;
      log.error({ event: "delegation_recovery", reason: why, ok: false }, "delegation stranded; telling the voice model to speak");
      live.appendCommentary(DELEGATION_STRANDED_COMMENTARY);
    }, DEAD_AIR_GRACE_MS);
    guard.unref?.();
  };
  const sendStub = (callId: string, reason: string) => {
    stubbed.add(callId);
    log.warn({ event: "delegation_recovery", callId, reason }, "delegation recovery: substituting a placeholder result");
    sendOnce(live, {
      type: "response.item.create",
      event_id: shortuuid("stub_output_"),
      item: { type: "function_call_output", call_id: callId, output: droppedOutputStub(callId) },
    });
  };

  live.on("openai_client_event_queued", (event: Record<string, any>) => {
    if (event?.type !== "response.item.create" || event.item?.type !== "function_call_output") return;
    if (!event.event_id || !event.item.call_id) return;
    outputCalls.set(event.event_id, event.item.call_id);
    if (outputCalls.size > MAX_TRACKED_OUTPUTS) outputCalls.delete(outputCalls.keys().next().value!);
  });

  live.on("openai_server_event_received", (event: ServerEvent) => {
    if (event.type === "response.event") {
      cancelGuard();
      return;
    }
    if (event.type === "session.delegation.created") {
      stubbed.clear();
      return;
    }
    if (event.type !== "error") return;
    const error = (event.error ?? {}) as { code?: string; message?: string; client_event_id?: string };
    const code = (error.code ?? "").trim();
    if (code === ERROR_INPUT_BUFFER_FULL) {
      const callId = outputCalls.get(error.client_event_id ?? "");
      if (callId && !stubbed.has(callId)) sendStub(callId, "output refused as too large");
      armGuard(callId ? "output refused" : "input buffer full");
    } else if (code === ERROR_OUTPUTS_REQUIRED) {
      const callIds = missingCallIds(error.message);
      for (const callId of callIds.filter((id) => !stubbed.has(id))) {
        sendStub(callId, "backend reported it unanswered");
      }
      // The plugin's own response.create was the one refused; nothing is owed now.
      if (callIds.length) sendOnce(live, { type: "response.create", event_id: shortuuid("response_create_") });
      armGuard(callIds.length ? "response resumed" : "outputs required, none named");
    }
  });
}

export interface ClientDelegationParams {
  /** The delegate agent's name, or its id: what the invocation log calls the tool. */
  delegateName: string;
  /** The caller and agent turns so far, oldest first. */
  history: () => TranscriptLine[];
  invoke: (task: string) => Promise<unknown>;
  log?: typeof logger;
}

/**
 * Client delegation: each `delegation_created` becomes a synthetic subagent call to the delegate,
 * and its answer is spoken as commentary on that delegation. Pipecat's `_run_platform_delegation`.
 */
export function attachClientDelegation(live: LiveSession, params: ClientDelegationParams): void {
  const { delegateName, history, invoke, log = logger } = params;
  let delivered = 0;
  let first = true;

  live.on("delegation_created", ({ id, pendingTranscript }: { id: string; pendingTranscript: string }) => {
    const all = history();
    const since = all.slice(delivered);
    delivered = all.length;
    const pending = (pendingTranscript ?? "").trim();
    if (pending && since.at(-1)?.text.trim() !== pending) since.push({ role: "user", text: pending });
    const task = renderTranscriptRequest(since, first);
    first = false;

    void (async () => {
      const startedAt = Date.now();
      logToolCall(log, { tool: delegateName, kind: "delegate", args: { task } });
      let text: string;
      try {
        const result = await Promise.race([
          invoke(task),
          new Promise<never>((_, reject) => {
            const t = setTimeout(() => reject(new Error("delegation timed out")), DELEGATION_TIMEOUT_MS);
            t.unref?.();
          }),
        ]);
        logToolResult(log, { tool: delegateName, kind: "delegate", ok: true, result, durationMs: Date.now() - startedAt });
        text = subagentAnswerText(result).trim() || NO_ANSWER_COMMENTARY;
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        logToolResult(log, { tool: delegateName, kind: "delegate", ok: false, error: message, durationMs: Date.now() - startedAt });
        text = DELEGATION_FAILED_COMMENTARY;
      }
      for (const chunk of chunkText(text)) live.appendCommentary(chunk, { delegationId: id });
    })();
  });
}

export interface GptLiveRealtimeModelOptions {
  overrides: Record<string, unknown>;
  /** The backend model: the `llm` usage rows carry it, not `gpt-live-1`. */
  usageBackend: VendorDetail;
  /** Responses mode only; client mode has no backend calls to recover. */
  recovery: boolean;
}

/** AgentSession takes this where it would wrap the bare GPTLiveModel in the SDK's adapter. */
export class GptLiveRealtimeModel extends llm.DuplexRealtimeAdapter {
  readonly usageBackend: VendorDetail;
  readonly #overrides: Record<string, unknown>;
  readonly #recovery: boolean;
  #providerEndedCallback?: (info: ProviderEndedInfo) => void;
  // The caller's session. A consult session is made later from the same model and must not end the call.
  #primarySession?: llm.RealtimeSession;

  constructor(model: openai.realtime.GPTLiveModel, options: GptLiveRealtimeModelOptions) {
    super(model);
    this.usageBackend = options.usageBackend;
    this.#overrides = options.overrides;
    this.#recovery = options.recovery;
  }

  /** See provider-ended.ts. Only the caller's session reports. */
  setProviderEndedCallback(cb: (info: ProviderEndedInfo) => void): void {
    this.#providerEndedCallback = cb;
  }

  session(): llm.RealtimeSession {
    const session = super.session();
    this.#primarySession ??= session;
    const live = (session as unknown as { duplexSession: LiveSession }).duplexSession;
    mergeIntoSessionStart(live, this.#overrides);
    if (this.#recovery) armDelegationRecovery(live);
    const ended = (info: ProviderEndedInfo) => {
      if (session === this.#primarySession) this.#providerEndedCallback?.(info);
    };
    // The plugin reconnects after any close; these reasons mean the call is over instead.
    live.on("openai_server_event_received", (event: ServerEvent) => {
      if (event.type === "session.closed" && PROVIDER_ENDED_REASONS.has(event.reason)) {
        ended({ reason: `provider ${event.reason}` });
      }
    });
    // An error inside AgentSession.start() produces no Close event; see openai-realtime.ts.
    live.on("error", (ev: llm.RealtimeModelError) => {
      if (!ev.recoverable) ended({ reason: ev.error?.message });
    });
    return session;
  }

  /** The runtime logs this as the `source` of each AgentSession error event: keep its options out. */
  toJSON(): { label: string; model: string; provider: string } {
    return { label: this.label(), model: this.model, provider: this.provider };
  }
}

/** The GPT-Live usage backend of a session's model, for a caller that only holds the session. */
export function gptLiveUsageBackend(model: unknown): VendorDetail | undefined {
  return model instanceof GptLiveRealtimeModel ? model.usageBackend : undefined;
}

/** The running GPT-Live session behind an agent, or undefined for any other model. */
export function liveSessionOf(agent: { duplexSession?: unknown }): LiveSession | undefined {
  try {
    const live = agent.duplexSession;
    return live instanceof openai.realtime.GPTLiveSession ? live : undefined;
  } catch {
    return undefined;
  }
}
