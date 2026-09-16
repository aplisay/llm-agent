/**
 * End the call when the realtime provider ends the session the caller hears:
 * Ultravox's own maxDuration, an options.inactivity.hangup endBehavior hangup,
 * or an outage. Without it the caller hears dead air until the "Session
 * timeout" long-stop (seen on staging: 2m10s).
 *
 * The SDK cannot report this. AgentSession.Error forwards the inner Error, so
 * `recoverable` is lost, and the Close event never arrives because closeImpl
 * blocks in drain(). So the Ultravox plugin reports it out of band, for one
 * session per model: its primary session (RealtimeModel.setProviderEndedCallback).
 *
 * A handover changes the session the caller hears. A full-stack handover or a
 * hand-back builds a new model, and the runtime arms that model too. An in-place
 * handover opens a new session on the running model, and the runtime marks that
 * session primary before the SDK creates it (markNextSessionPrimary). A consult
 * leg also opens a session on the running model. It is never primary
 * (clearNextSessionPrimary).
 */
import logger from "./logger.js";

/**
 * The `voice.AgentSession` surface the hook uses. The realtime model is
 * `session.llm`, not the voice.Agent that createVoiceModelAndSession returns as
 * `model`: the hook once shipped bound to that one and never fired.
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
      // INFO, not debug: app-level debug is invisible inside job processes. If
      // this line is absent, the hook is NOT armed.
      logger.info({ callId, modelName }, "provider-ended teardown hook armed");
      return true;
    },
  };
}

/**
 * Before an in-place handover: make the next session created from the running
 * model its primary session, so a provider end on the incoming agent's session
 * ends the call. Returns false, and changes nothing, for a model without the mark.
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
 * Before a consult leg starts its session on the primary's model: drop a mark
 * that a handover left behind, so the consult session never becomes primary.
 */
export function clearNextSessionPrimary(realtimeModel: unknown): void {
  (realtimeModel as ProviderEndedModel | null | undefined)?.clearNextSessionPrimary?.();
}
