/**
 * Best guess, while the call runs, at when the caller stopped speaking for the
 * turn a `user` row carries. Every signal here comes after the caller stopped,
 * so the earliest valid one is the closest. Ultravox rows are corrected from
 * Ultravox's own timings when the call ends (user-turn-corrections.ts).
 */

/**
 * How long after a reply or tool call starts its user transcript may still
 * arrive. Ultravox sends the caller's final transcript with its first output
 * (measured 0 to 0.7 s later); older reply starts belong to an earlier turn.
 */
export const RESPONSE_TRANSCRIPT_WINDOW_MS = 2500;

export type UserTurnClock = {
  /** The agent started speaking, or a tool was invoked. */
  noteResponseStarted(at?: number): void;
  /** The session's user state went to speaking (provider or local VAD). */
  noteUserStarted(at?: number): void;
  /** The session's user state went back to listening. */
  noteUserStopped(at?: number): void;
  /**
   * The time for a user item that arrived at `arrivedAt`. `metrics` is the SDK's
   * ChatMessage metrics: a pipeline session sets `stoppedSpeakingAt` (seconds).
   */
  stamp(item: { metrics?: { stoppedSpeakingAt?: number } }, arrivedAt?: number): Date;
};

export function createUserTurnClock(opts: { now?: () => number } = {}): UserTurnClock {
  const now = opts.now ?? Date.now;
  let responseStartedAt: number | undefined;
  let userStartedAt: number | undefined;
  let userStoppedAt: number | undefined;
  let lastStamp = -Infinity;
  return {
    noteResponseStarted(at = now()) {
      responseStartedAt = at;
    },
    noteUserStarted(at = now()) {
      userStartedAt = at;
    },
    noteUserStopped(at = now()) {
      userStoppedAt = at;
    },
    stamp(item, arrivedAt = now()) {
      const candidates: number[] = [];
      const stopped = item.metrics?.stoppedSpeakingAt;
      if (typeof stopped === "number" && Number.isFinite(stopped)) candidates.push(stopped * 1000);
      if (userStoppedAt !== undefined) candidates.push(userStoppedAt);
      if (
        responseStartedAt !== undefined &&
        arrivedAt - responseStartedAt <= RESPONSE_TRANSCRIPT_WINDOW_MS &&
        (userStartedAt === undefined || responseStartedAt > userStartedAt)
      ) {
        candidates.push(responseStartedAt);
      }
      const valid = candidates.filter((t) => t > lastStamp && t <= arrivedAt);
      const at = valid.length ? Math.min(...valid) : arrivedAt;
      lastStamp = at;
      responseStartedAt = undefined;
      userStartedAt = undefined;
      userStoppedAt = undefined;
      return new Date(at);
    },
  };
}
