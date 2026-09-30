/** The caller as the worker holds it: an inbound participant, or the SIP participant an outbound call dialled. */
export type CallerRef = { identity?: string; participantIdentity?: string } | null | undefined;

/** The parts of an rtc-node Room this reads. */
export type RoomPresence = {
  isConnected?: boolean;
  remoteParticipants?: Map<string, { identity: string }>;
};

/**
 * Whether the caller has left a room this job is connected to. False when that
 * cannot be told: there is no caller, or the job has not joined the room (a
 * failure before the session started).
 */
export function callerLeftRoom(room: RoomPresence | null | undefined, caller: CallerRef): boolean {
  const identity = caller?.identity || caller?.participantIdentity;
  if (!identity || !room?.isConnected) return false;
  for (const p of room.remoteParticipants?.values() ?? []) {
    if (p.identity === identity) return false;
  }
  return true;
}
