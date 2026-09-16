/**
 * Use the plugin's provider-end hook because SDK error events lose recoverability and close can stall. See PR #342.
 * Follow the session the caller hears across handovers; consult sessions must never become primary.
 */
import logger from "./logger.js";

/**
 * The realtime model is session.llm; the returned voice.Agent cannot report provider termination. See PR #342.
 */
export interface ProviderEndedSession {
  llm?: unknown;
}

/** The Ultravox RealtimeModel methods this module uses. Other models have none. */
type ProviderEndedModel = {
  setProviderEndedCallback?: (cb: (info: unknown) => void) => void;
  setNextSessionPrimary?: () => void;
  clearNextSessionPrimary?: () => void;
};

export interface ProviderEndedParams {
  /** The session the caller hears. Null while a full-stack handover swaps it. */
  currentSession(): ProviderEndedSession | null;
  /** The call is already coming down. */
  isCleaningUp(): boolean;
  /** A full-stack handover is closing the outgoing session. */
  handoverInProgress(): boolean;
  /** The caller is bridged to a transfer target and no longer hears the agent. */
  isBridged(): boolean;
  /** The caller is on hold for a consultation. */
  consultInProgress(): boolean;
  endCall(): Promise<void>;
}

export interface ProviderEndedTeardown {
  /**
   * Arm the hook on the realtime model of `session`. Returns false, and arms
   * nothing, for a model that does not report provider-ended.
   */
  arm(session: ProviderEndedSession, log: { callId: string; modelName: string }): boolean;
}

export function createProviderEndedTeardown(params: ProviderEndedParams): ProviderEndedTeardown {
  return {
    arm(session, { callId, modelName }) {
      const model = session.llm as ProviderEndedModel | null | undefined;
      if (typeof model?.setProviderEndedCallback !== "function") {
        logger.info(
          { callId, modelName },
          "realtime model does not report provider-ended; teardown hook not armed",
        );
        return false;
      }
      model.setProviderEndedCallback((info: unknown) => {
        // A model replaced by a full-stack handover no longer speaks to the caller.
        if (session !== params.currentSession()) return;
        if (params.isCleaningUp() || params.handoverInProgress()) return;
        if (params.isBridged() || params.consultInProgress()) return;
        logger.warn({ info, callId }, "realtime provider ended the session; ending call");
        void params
          .endCall()
          .catch((e) => logger.error({ e }, "error ending call after provider end"));
      });
      // Keep registration at INFO: app-level debug is unavailable in job processes. See PR #187.
      logger.info({ callId, modelName }, "provider-ended teardown hook armed");
      return true;
    },
  };
}

/**
 * Mark the incoming handover session as primary so its provider-side end tears down the call. See PR #342.
 * Return false for models without the one-shot override.
 */
export function markNextSessionPrimary(realtimeModel: unknown): boolean {
  const model = realtimeModel as ProviderEndedModel | null | undefined;
  if (typeof model?.setNextSessionPrimary !== "function") {
    return false;
  }
  model.setNextSessionPrimary();
  return true;
}

/**
 * Clear any unused handover mark before a consult starts, or its session could become primary. See PR #342.
 */
export function clearNextSessionPrimary(realtimeModel: unknown): void {
  (realtimeModel as ProviderEndedModel | null | undefined)?.clearNextSessionPrimary?.();
}
