import "dotenv/config";
import { RoomServiceClient } from "livekit-server-sdk";

export const DISCONNECT_REASONS = {
  BRIDGED_PARTICIPANT: "Bridged participant disconnected",
  ORIGINAL_PARTICIPANT: "Original participant disconnected",
  SESSION_TIMEOUT: "Session timeout",
  SESSION_CLOSED: "Session closed",
  AGENT_INITIATED_HANGUP: "Agent initiated hangup",
  UNCAUGHT_ERROR_RUNNING_AGENT: "UNCAUGHT ERROR: running agent worker",
  WATCHDOG_NO_PARTICIPANTS: "Watchdog: no remote participants",
  // The agent asked to hang up but the AgentStateChanged edge that normally
  // drives teardown never arrived (see the hangup watchdog in
  // voice-agent-runtime.ts). Distinct from AGENT_INITIATED_HANGUP so the
  // fallback path is visible in call records rather than masquerading as the
  // healthy one.
  HANGUP_WATCHDOG: "Agent initiated hangup (watchdog)",
  // A tool was invoked in a runaway loop past the kill threshold; the call is
  // being torn down because the model cannot recover on its own.
  TOOL_LOOP_DETECTED: "Runaway tool-call loop detected",
  // options.inactivity.hangup is set and the inactivity prompt went unanswered
  // INACTIVITY_PROMPT_COUNT times. Distinct from SESSION_TIMEOUT so an abandoned
  // call reclaimed deliberately is not confused with one that simply ran out the
  // model's maxDuration.
  INACTIVITY_TIMEOUT: "Inactivity timeout",
  // The realtime provider ended the session without being asked to — Ultravox's own
  // maxDuration, an inactivityMessages endBehavior hangup, or an outage. Distinct from
  // SESSION_TIMEOUT: that one means OUR long-stop reclaimed a leg nobody ended, which
  // is precisely the symptom this reason exists to stop being mistaken for a cause.
  // NB Call.end discards `reason` for `status` (always "ended normally") — this string
  // is durable in the hangup transaction-log row and the invocation log, not in status.
  REALTIME_PROVIDER_ENDED: "Realtime provider ended session",
} as const;

/**
 * The three LiveKit server credentials, asserted present, read at call time.
 *
 * `dotenv` is aliased to secretenv (see agents/livekit/deploy/gcp/README.md), so the
 * import at the top of this module is what expands SECRETENV_BUNDLE into process.env.
 * A process that never received the SECRETENV pair has none of these set — most
 * easily a `docker exec` shell, which is built from the image/compose environment and
 * so does NOT inherit the exports entrypoint.sh eval'd into PID 1. Handing undefined
 * to a client constructor failed inside the SDK with
 * `Cannot read properties of undefined (reading 'startsWith')`, which names neither
 * the missing variable nor the reason. This names both.
 */
export function livekitCredentials(): [string, string, string] {
  const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
  const missing = Object.entries({
    LIVEKIT_URL,
    LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET,
  })
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(
      `LiveKit credentials missing from the environment: ${missing.join(", ")}. ` +
        "In a container these come from the SECRETENV bundle that entrypoint.sh " +
        "decrypts, so run through the image entrypoint " +
        "(`docker compose run --rm livekit-agent setup`, or " +
        "`docker exec <container> /bin/sh /usr/src/app/entrypoint.sh setup`) — a bare " +
        "`node dist/realtime.js …` inside the container gets no secrets at all.",
    );
  }
  return [LIVEKIT_URL!, LIVEKIT_API_KEY!, LIVEKIT_API_SECRET!];
}

let cachedRoomService: RoomServiceClient | undefined;

/**
 * The shared RoomServiceClient, built on first use rather than at import.
 *
 * Laziness is load-bearing: this module is on the import path of every entry point,
 * including `realtime.js setup`, which never touches the room service. Constructing
 * at module scope meant an unconfigured environment took the process down during
 * module evaluation — before the subcommand it was asked to run had a chance to say
 * what it actually needed.
 */
export function getRoomService(): RoomServiceClient {
  return (cachedRoomService ??= new RoomServiceClient(...livekitCredentials()));
}
