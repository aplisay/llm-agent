import type { JobContext, voice } from "@livekit/agents";
import logger from "./logger.js";
import { closeSessionBounded } from "./utils.js";

/** Same bound as the old-session close in an agent handover. */
const FAILED_SESSION_CLOSE_TIMEOUT_MS = 8_000;

/**
 * Close a failed fallback attempt's session and clear the job's primary AgentSession.
 * agents-js keeps the first started session as primary even after close(), and
 * AgentSession.start() then throws for any later session that records.
 */
export async function releaseFailedAttemptSession(
  ctx: Pick<JobContext, "_primaryAgentSession">,
  failed: Pick<voice.AgentSession, "close"> | null,
): Promise<void> {
  await closeSessionBounded(failed, FAILED_SESSION_CLOSE_TIMEOUT_MS, (e) =>
    logger.warn(
      { e: e.message },
      "failed attempt's session close failed/timed out; retrying anyway",
    ),
  );
  ctx._primaryAgentSession = undefined;
}
