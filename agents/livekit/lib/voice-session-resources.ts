import type { llm } from "@livekit/agents";
import type { voice } from "@livekit/agents";
import logger from "./logger.js";

/**
 * Release provider resources held by the primary session's LLM/realtime model
 * before bridging (realtime models expose `close()`; pipeline LLMs may not).
 */
export function releasePrimarySessionLlm(
  session: voice.AgentSession | null,
): void {
  if (!session?.llm) return;
  const lm = session.llm as llm.RealtimeModel & { close?: () => void };
  lm.close?.();
}

/**
 * After a blind bridge, stop the agent hearing/responding without calling
 * {@link voice.AgentSession.close} so RecorderIO can keep recording until job shutdown.
 * Strategy A: interrupt + realtime close + detach activity audio input (SDK internal activity).
 */
export function detachPrimaryAgentMediaAfterBridge(
  session: voice.AgentSession | null,
): void {
  if (!session) return;
  try {
    session.interrupt();
  } catch (e) {
    logger.debug({ e }, "interrupt during bridge media detach");
  }
  releasePrimarySessionLlm(session);
  try {
    (
      session as unknown as { activity?: { detachAudioInput(): void } }
    ).activity?.detachAudioInput();
  } catch (e) {
    logger.warn({ e }, "detachAudioInput during bridge media detach");
  }
}

/**
 * LLM instance to reuse for the consultative transfer AgentSession in the
 * consultation room (same as primary session's `llm`).
 */
export function getLlmForTransferSession(
  session: voice.AgentSession,
): llm.LLM | llm.RealtimeModel {
  if (!session.llm) {
    throw new Error("Agent session has no LLM for transfer consultation");
  }
  return session.llm as llm.LLM | llm.RealtimeModel;
}
