/**
 * A pipeline LLM that fails every turn (a revoked key gives a 401 on each one) leaves the caller
 * talking to silence. agents-js 1.9 closes the session only at the 4th unrecoverable llm_error in
 * a row (maxUnrecoverableErrors 3; the count resets when the agent speaks), and says nothing first.
 * This acts sooner: it says a short line through the session's TTS, then ends the call.
 */
import { voice } from "@livekit/agents";
import type { Agent } from "./api-client.js";
import { fallbackMessageFor } from "./fallback-message.js";
import logger from "./logger.js";

export const LLM_ERROR_MESSAGE =
  "Sorry, I'm having a technical problem and can't continue this call. Please try again later.";
/** Below the SDK's limit, so the session is still open to speak through. */
export const LLM_ERROR_LIMIT = 2;
export const LLM_ERROR_SPEECH_CAP_MS = 10_000;

type LlmErrorSession = Pick<voice.AgentSession, "on" | "say">;

export interface LlmErrorHangupParams {
  /** The session the caller hears. */
  currentSession(): unknown;
  /** False while a start failure still belongs to the fallback chain (startup-window.ts). */
  startupSettled(): boolean;
  isCleaningUp(): boolean;
  handoverInProgress(): boolean;
  isBridged(): boolean;
  consultInProgress(): boolean;
  /** What to say, read when it is needed: an in-place handover changes the agent. */
  message(): string;
  endCall(): Promise<void>;
  speechCapMs?: number;
}

export interface LlmErrorHangup {
  arm(session: LlmErrorSession, opts: { callId: string }): void;
}

/** The agent's own `options.fallback.message` text, in its language, else the fixed line. */
export function llmErrorMessageFor(agent: Agent): string {
  return fallbackMessageFor(agent)?.text ?? LLM_ERROR_MESSAGE;
}

/** A 4xx the provider will give again on every turn: a bad key, no access, an unknown model. */
export function isPermanentLlmError(error: unknown): boolean {
  const { statusCode, retryable } = (error ?? {}) as { statusCode?: unknown; retryable?: unknown };
  return typeof statusCode === "number" && statusCode >= 400 && statusCode < 500 && retryable === false;
}

async function speakThenEnd(session: LlmErrorSession, params: LlmErrorHangupParams) {
  let timer: NodeJS.Timeout | undefined;
  try {
    const handle = session.say(params.message(), { allowInterruptions: false, addToChatCtx: false });
    await Promise.race([
      handle.waitForPlayout(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, params.speechCapMs ?? LLM_ERROR_SPEECH_CAP_MS);
      }),
    ]);
  } catch (e) {
    logger.warn({ e }, "could not speak the LLM error message; ending the call anyway");
  } finally {
    clearTimeout(timer);
  }
  await params.endCall();
}

export function createLlmErrorHangup(params: LlmErrorHangupParams): LlmErrorHangup {
  return {
    arm(session, { callId }) {
      let failures = 0;
      let fired = false;
      session.on(voice.AgentSessionEventTypes.AgentStateChanged, (ev) => {
        if (ev.newState === "speaking") failures = 0;
      });
      session.on(voice.AgentSessionEventTypes.Error, (ev) => {
        const inner = ev.error as { type?: string; recoverable?: boolean; error?: unknown } | null;
        if (fired || inner?.type !== "llm_error" || inner.recoverable) return;
        if (session !== params.currentSession() || !params.startupSettled()) return;
        if (params.isCleaningUp() || params.handoverInProgress()) return;
        if (params.isBridged() || params.consultInProgress()) return;
        failures += 1;
        if (failures < LLM_ERROR_LIMIT && !isPermanentLlmError(inner.error)) return;
        fired = true;
        const statusCode = (inner.error as { statusCode?: unknown } | undefined)?.statusCode;
        logger.error({ callId, failures, statusCode }, "LLM is failing; telling the caller and ending the call");
        void speakThenEnd(session, params).catch((e) =>
          logger.error({ e }, "error ending call after LLM errors"),
        );
      });
    },
  };
}
