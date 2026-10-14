/**
 * Corrects `user` row times from the realtime model's own record of when the
 * caller spoke (Ultravox's message timings), just before the row's call record
 * ends, so the stored log and the end hook carry the reconciled times. Rows
 * streamed during the call keep their provisional time on the live socket.
 */
import type { Call } from "./api-client.js";

/** A transaction-log entry as sendMessage logged it: batched (entry) or streamed (row id). */
export type LoggedTransactionLog = {
  call: Call;
  entry?: { createdAt?: Date };
  id?: number;
};

/** A model that knows when the caller's turns happened, keyed by the user transcript's item id. */
export type UserTurnTimingSource = {
  userTurnTimings(): Promise<Map<string, { startMs: number; endMs: number }>>;
};

/** A row-id/time pair the end request applies to an already stored row. */
export type TransactionLogCorrection = { id: number; createdAt: Date };

/** Slack for clock skew; Ultravox's clock and ours agreed to about 55 ms when measured. */
export const CORRECTION_SKEW_MS = 250;
/** Cap on the whole correction step; the rows keep their guesses on timeout. */
export const CORRECTION_TIMEOUT_MS = 2000;

type PendingRow = {
  itemId: string;
  guess: Date;
  source: UserTurnTimingSource | undefined;
  logged: Promise<LoggedTransactionLog | undefined>;
};

export function isUserTurnTimingSource(value: unknown): value is UserTurnTimingSource {
  return typeof (value as UserTurnTimingSource | undefined)?.userTurnTimings === "function";
}

const within = <T>(p: Promise<T>, ms: number): Promise<T | undefined> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });

export function createUserTurnCorrections(opts: {
  logger?: { debug: (...args: any[]) => void; warn: (...args: any[]) => void };
  timeoutMs?: number;
} = {}) {
  const timeoutMs = opts.timeoutMs ?? CORRECTION_TIMEOUT_MS;
  let pending: PendingRow[] = [];

  async function correct(call: Call): Promise<void> {
    const rows = pending;
    const logged = await within(Promise.all(rows.map((r) => r.logged)), timeoutMs);
    if (!logged) return;
    const mine = rows
      .map((row, i) => ({ row, log: logged[i] }))
      .filter((r): r is { row: PendingRow; log: LoggedTransactionLog } => r.log?.call === call);
    if (!mine.length) return;
    pending = pending.filter((r) => !mine.some((m) => m.row === r));

    const sources = [...new Set(mine.map((m) => m.row.source).filter(isUserTurnTimingSource))];
    if (!sources.length) return;
    const maps = await within(Promise.all(sources.map((s) => s.userTurnTimings())), timeoutMs);
    if (!maps) {
      opts.logger?.warn({ callId: call.id }, "user turn timings timed out; keeping provisional times");
      return;
    }
    const timings = new Map(maps.flatMap((m) => [...m]));

    let previous = -Infinity;
    let corrected = 0;
    for (const { row, log } of mine) {
      const guess = row.guess.getTime();
      const end = timings.get(row.itemId)?.endMs;
      const at = end !== undefined && end <= guess + CORRECTION_SKEW_MS && end > previous ? end : guess;
      previous = at;
      if (at === guess) continue;
      corrected++;
      if (log.entry) {
        log.entry.createdAt = new Date(at);
      } else if (log.id !== undefined) {
        const c = call as Call & { transactionLogCorrections?: TransactionLogCorrection[] };
        (c.transactionLogCorrections ??= []).push({ id: log.id, createdAt: new Date(at) });
      }
    }
    opts.logger?.debug({ callId: call.id, rows: mine.length, corrected }, "user turn times corrected");
  }

  return {
    /** Record a logged `user` row with its guessed time and the model that produced it. */
    add(row: PendingRow): void {
      pending.push(row);
    },
    /** Apply corrections to `call`'s rows; never throws. */
    beforeEnd: (call: Call): Promise<void> => correct(call).catch(() => undefined),
  };
}
