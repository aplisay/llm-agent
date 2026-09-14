/**
 * The SDK emits away once per silence, so repeat prompts with a call-scoped timer. See PR #340.
 * Attach every replacement session and read the active agent's options; Ultravox prompts natively.
 */
import { voice } from "@livekit/agents";
import type { Agent } from "./api-client.js";
import logger from "./logger.js";
import { speakInactivityMessage, type SpeechStack, type TextSpeaker } from "./speak-text.js";
import {
  inactivityAwayTimeoutSecs,
  inactivityHangupEnabled,
  INACTIVITY_PROMPT_COUNT,
} from "./voice-session-factory.js";

/** The `voice.AgentSession` surface the kick uses. */
export interface KickSession extends TextSpeaker {
  options: { userAwayTimeout?: number | null };
  on(
    event: voice.AgentSessionEventTypes.UserStateChanged,
    listener: (ev: voice.UserStateChangedEvent) => void,
  ): unknown;
}

/** The agent driving the current session, and how that session speaks. */
export interface ActiveAgent extends SpeechStack {
  agent: Agent;
  modelName: string;
}

export interface InactivityKickParams {
  /** The session the caller hears. Null while a full-stack handover swaps it. */
  currentSession(): KickSession | null;
  activeAgent(): ActiveAgent;
  /** The caller is bridged to a transfer target, so they cannot hear the agent. */
  isBridged(): boolean;
  /**
   * The caller is on hold for a consultation, bridged, or being transferred.
   * Their silence is expected, so prompts do not count towards a hangup.
   */
  transferInFlight(): boolean;
  /** Ends the call once INACTIVITY_PROMPT_COUNT prompts went unanswered. */
  endCall(): Promise<void>;
}

export interface InactivityKick {
  /** Listen on a session the call runs. */
  attach(session: KickSession): void;
  /**
   * In-place handovers retain the session: update its away timeout before the SDK next arms the timer. See PR #340.
   */
  applyAwayTimeout(): void;
  /** Stop prompting and forget the count. */
  stop(): void;
}

interface KickSettings {
  message: string;
  timeoutSecs: number;
  hangup: boolean;
}

function kickSettings({ agent, modelName, voiceMode }: ActiveAgent): KickSettings | null {
  if (voiceMode === "realtime" && modelName.includes("livekit:ultravox/")) return null;
  const timeoutSecs = inactivityAwayTimeoutSecs(agent);
  const message = agent?.options?.inactivity?.message;
  if (timeoutSecs === undefined || typeof message !== "string") return null;
  return { message: message.trim(), timeoutSecs, hangup: inactivityHangupEnabled(agent) };
}

export function createInactivityKick(params: InactivityKickParams): InactivityKick {
  let timer: NodeJS.Timeout | null = null;
  /** The session whose "away" started the current run of prompts. */
  let awaySession: KickSession | null = null;
  let prompts = 0;

  const stop = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    awaySession = null;
    prompts = 0;
  };

  const kick = async (): Promise<void> => {
    timer = null;
    const session = params.currentSession();
    const active = params.activeAgent();
    const settings = kickSettings(active);
    // Prompts end with the session that went away. A handover's new session
    // starts its own, with the incoming agent's options.
    if (!session || session !== awaySession || !settings) {
      stop();
      return;
    }
    timer = setTimeout(() => void kick(), settings.timeoutSecs * 1000);
    if (params.isBridged()) return;
    try {
      speakInactivityMessage(session, settings.message, active);
    } catch (e) {
      logger.info({ e }, "inactivity kick failed");
    }

    if (!settings.hangup || params.transferInFlight()) return;
    prompts += 1;
    if (prompts < INACTIVITY_PROMPT_COUNT) return;
    logger.info(
      { prompts, inactivityTimeoutSecs: settings.timeoutSecs },
      "inactivity prompt unanswered, ending call",
    );
    stop();
    await params.endCall().catch((e) => logger.error({ e }, "error ending call on inactivity"));
  };

  return {
    attach(session) {
      session.on(voice.AgentSessionEventTypes.UserStateChanged, (ev) => {
        // A session replaced by a full-stack handover can still emit events.
        if (session !== params.currentSession()) return;
        // Any other state means the caller is back, so a later silence starts
        // the count again.
        stop();
        if (ev?.newState !== "away") return;
        awaySession = session;
        void kick();
      });
    },
    applyAwayTimeout() {
      const session = params.currentSession();
      const settings = kickSettings(params.activeAgent());
      if (session && settings) session.options.userAwayTimeout = settings.timeoutSecs;
    },
    stop,
  };
}
