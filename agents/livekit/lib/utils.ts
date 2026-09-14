/**
 * Wraps an async operation with a timeout.
 * If the operation doesn't complete within the specified time, the timeout error is thrown.
 * The timeout is automatically cleared if the operation completes first.
 *
 * @param operation - The async operation to execute
 * @param timeoutMs - Timeout duration in milliseconds
 * @param timeoutError - The error to throw if the timeout is reached
 * @param onTimeout - Optional callback to execute when timeout occurs (e.g., for logging)
 * @returns The result of the operation, or throws the timeout error
 */
export async function withTimeout<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  timeoutError: Error,
  onTimeout?: () => void
): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      if (onTimeout) {
        onTimeout();
      }
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(), timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Bound session.close() and absorb failures so a stalled provider cannot prevent call-record teardown. See PR #183.
 *
 * @param session - Anything with a `close()`; `null`/`undefined` is a no-op.
 * @param timeoutMs - Upper bound on the close.
 * @param onFailure - Notified once if the close rejected or timed out.
 */
export async function closeSessionBounded(
  session: { close: () => Promise<void> | void } | null | undefined,
  timeoutMs: number,
  onFailure?: (error: Error) => void,
): Promise<void> {
  if (!session) {
    return;
  }
  try {
    await withTimeout(
      () => Promise.resolve(session.close()),
      timeoutMs,
      new Error("session close timed out"),
    );
  } catch (e) {
    onFailure?.(e instanceof Error ? e : new Error(String(e)));
  }
}
