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
