import "dotenv/config";
import { RoomServiceClient } from "livekit-server-sdk";

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;

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

export const roomService = new RoomServiceClient(
  LIVEKIT_URL!,
  LIVEKIT_API_KEY!,
  LIVEKIT_API_SECRET!,
);
