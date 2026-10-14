/**
 * Which of the caller session's transcript items are logged while a transfer is
 * in progress. A blind transfer sets the flag as soon as its tool runs, but the
 * turn that asked for it can land later: Ultravox and OpenAI Realtime send the
 * caller's final transcript with or after the tool call, and the SDK adds the
 * agent's message only when its playout ends. Those items still pass.
 */

/** How long after the transfer request the caller's late transcript is still accepted. */
export const LATE_USER_TRANSCRIPT_MS = 3000;

export type TransferTranscriptGate = {
  /** Call when the transfer tool is invoked, before it sets the in-progress flag. */
  noteTransferRequested(): void;
  /**
   * Whether an item may be logged. `createdAt` is the SDK's ChatMessage time, which
   * for an agent message is when its speech started.
   */
  allows(item: { role: string; createdAt?: number }): boolean;
};

export function createTransferTranscriptGate(opts: {
  transferInProgress: () => boolean;
  now?: () => number;
}): TransferTranscriptGate {
  const now = opts.now ?? Date.now;
  let requestedAt: number | undefined;
  return {
    noteTransferRequested() {
      requestedAt = now();
    },
    allows({ role, createdAt }) {
      if (!opts.transferInProgress()) return true;
      if (requestedAt === undefined) return false;
      if (role === "user") return now() - requestedAt <= LATE_USER_TRANSCRIPT_MS;
      return createdAt !== undefined && createdAt < requestedAt;
    },
  };
}
