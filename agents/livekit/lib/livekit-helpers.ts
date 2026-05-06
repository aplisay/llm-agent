import logger from "./logger.js";
import { roomService } from "./livekit-constants.js";

/**
 * Delete a LiveKit room with retry on transient errors.
 *
 *  - 404 ("Not Found") is treated as success: the room is already gone.
 *  - Other 4xx errors are not retried (the request is malformed / forbidden).
 *  - 5xx and network/unknown errors are retried up to MAX_ATTEMPTS times with
 *    exponential backoff. This catches the common case where the LiveKit API
 *    is briefly slow or unavailable during room cleanup, which previously left
 *    rooms alive (visible as a climbing concurrent-session count on the
 *    LiveKit dashboard).
 *
 * Throws on persistent failure so callers can choose to log and continue.
 */
export async function deleteRoomWithRetry(roomName: string): Promise<void> {
  const MAX_ATTEMPTS = 3;
  let attempt = 0;
  let lastErr: unknown;
  while (attempt < MAX_ATTEMPTS) {
    attempt++;
    try {
      await roomService.deleteRoom(roomName);
      if (attempt > 1) {
        logger.info({ roomName, attempt }, "deleteRoom succeeded after retry");
      }
      return;
    } catch (e) {
      lastErr = e;
      const err = e as { status?: number; code?: string | number; message?: string };
      const status = err?.status;
      const code = err?.code;
      // 404 — already deleted, treat as success.
      if (status === 404 || code === "not_found") return;
      // 4xx other than 404 — not retryable.
      if (typeof status === "number" && status >= 400 && status < 500) throw e;
      // 5xx / network / unknown — retry with backoff.
      if (attempt >= MAX_ATTEMPTS) break;
      const backoffMs = 250 * 2 ** (attempt - 1); // 250ms, 500ms
      logger.warn(
        { roomName, attempt, status, code, error: err?.message },
        "deleteRoom failed, retrying",
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
  throw lastErr;
}
