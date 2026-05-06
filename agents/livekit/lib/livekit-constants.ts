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
} as const;

export const roomService = new RoomServiceClient(
  LIVEKIT_URL!,
  LIVEKIT_API_KEY!,
  LIVEKIT_API_SECRET!,
);
