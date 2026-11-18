/**
 * True when a REFER transfer reported failure although it completed. Some PBXs
 * answer the finished transfer with a SIP 500, or the caller's participant has
 * already left by the time the result comes back. See docs/call-transfers.md.
 */
export function isReferFalseFailure(err: unknown): boolean {
  // livekit-server-sdk 2.17 throws SipCallError and rewrites its message as
  // "SIP call failed: 500 ...", so match the status code, not only the old text.
  if ((err as { sipStatusCode?: unknown } | null | undefined)?.sipStatusCode === 500) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    /\b500:? Internal Server Error\b/.test(message) ||
    message.includes("twirp error unknown: participant does not exist")
  );
}
