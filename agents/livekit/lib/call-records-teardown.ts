import logger from "./logger.js";

/**
 * How long the job's shutdown callback waits for the call records to end.
 * Ending a consult can take 8 s on its own (the TransferAgent session close
 * bound in transfer-handler.ts), and agents-js kills a job process that has
 * not exited 60 s after it asked it to close.
 */
export const RECORDS_SETTLE_TIMEOUT_MS = 20_000;

export interface CallRecordsTeardownSteps {
  /** Ends a consultative transfer still in progress, and the consult leg's record. */
  endTransfer(reason: string): Promise<void>;
  /** What must land before the call's record ends: side STT usage, the usage flush. */
  beforeEnd(): Promise<void>;
  /** Ends the record of the call the caller is on. */
  endCall(reason: string): Promise<unknown>;
}

export interface CallRecordsTeardown {
  /**
   * Ends the call's records, once: a later call shares the first run and its
   * reason. Never rejects.
   */
  end(reason: string): Promise<void>;
  /**
   * For the job's shutdown callback. agents-js exits the job process as soon
   * as its shutdown callbacks return, and teardown started by a session close
   * or a room deletion is not awaited by anything else. So this waits for an
   * end() already running, and ends a consult that is still open. Bounded,
   * never rejects.
   */
  settle(reason: string, timeoutMs?: number): Promise<void>;
}

const logged = (step: string) => (e: unknown) => {
  logger.error({ e, step }, "error ending call records");
};

export function createCallRecordsTeardown(steps: CallRecordsTeardownSteps): CallRecordsTeardown {
  let ending: Promise<void> | null = null;

  const end = (reason: string): Promise<void> => {
    ending ??= (async () => {
      // The consult leg and the call do not depend on each other, so neither
      // waits for the other: the call's end time stays the time it ended.
      await Promise.all([
        steps.endTransfer(reason).catch(logged("transfer")),
        (async () => {
          await steps.beforeEnd().catch(logged("before end"));
          await steps.endCall(reason).catch(logged("call"));
        })(),
      ]);
    })();
    return ending;
  };

  const settle = async (reason: string, timeoutMs = RECORDS_SETTLE_TIMEOUT_MS): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    const work = Promise.all([steps.endTransfer(reason).catch(logged("transfer")), ending]);
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          logger.warn({ timeoutMs, reason }, "call records did not end before the job exit");
          resolve();
        }, timeoutMs);
        timer.unref();
      }),
    ]);
    clearTimeout(timer);
  };

  return { end, settle };
}
