/**
 * True when a REFER transfer reported failure although it completed. Some PBXs
 * answer the finished transfer with a SIP 500, or drop the caller's leg before
 * the result arrives, so the call ends first or the participant has already
 * left. See docs/call-transfers.md.
 */
export function isReferFalseFailure(err: unknown): boolean {
  const e = err as { sipStatusCode?: unknown; metadata?: Record<string, unknown> } | null | undefined;
  // livekit-server-sdk 2.17 throws SipCallError and rewrites its message as
  // "SIP call failed: 500 ...", so match the status code, not only the old text.
  if (e?.sipStatusCode === 500 || e?.metadata?.sip_transfer_reason === "STR_CALL_ENDED") {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err ?? "");
  return (
    /\b500:? Internal Server Error\b/.test(message) ||
    message.includes("call ended before transfer completed") ||
    message.includes("twirp error unknown: participant does not exist")
  );
}
