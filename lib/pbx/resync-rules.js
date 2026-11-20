/**
 * When a desk phone is asked to fetch its settings again. Reads no database,
 * so anything may import it.
 *
 * Call control takes the phones that are due (lib/pbx/resync.js). A phone
 * whose settings changed is due at once. Until it has fetched it is due again
 * after a growing wait, a fixed number of times. After that the phone's own
 * daily refresh brings the change.
 */

// The wait before ask 2, 3, 4, 5 and 6 for one version of the settings.
export const RESYNC_WAITS_MS = [60, 5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60].map((seconds) => seconds * 1000);
export const RESYNC_MAX_ASKS = RESYNC_WAITS_MS.length + 1;
// The shortest time between two asks for one phone, whatever changed.
export const RESYNC_MIN_GAP_MS = 10 * 1000;
export const RESYNC_BATCH = 100;

// A claim request may be held open this long, and looks again this often.
export const RESYNC_MAX_HOLD_SECONDS = 30;
export const RESYNC_HOLD_POLL_MS = 2000;
// Requests held open at once in one process. One more is answered at once.
export const RESYNC_MAX_HELD = 8;

/**
 * Whether a device should be asked now. The query in claimDueResyncs applies
 * the same rule in SQL: keep the two in step.
 * @param {{ configVersion, resyncVersion, resyncAttempts, resyncRequestedAt }} device
 * @returns {{ due: boolean, attempts: number }} `attempts`: asks already made for this version
 */
export function resyncDue(device, now = Date.now()) {
  // A new version of the settings starts the count again.
  const attempts = device.resyncVersion === device.configVersion ? device.resyncAttempts ?? 0 : 0;
  if (attempts >= RESYNC_MAX_ASKS) return { due: false, attempts };
  const asked = device.resyncRequestedAt ? new Date(device.resyncRequestedAt).getTime() : null;
  if (asked === null) return { due: true, attempts };
  const wait = attempts === 0 ? RESYNC_MIN_GAP_MS : RESYNC_WAITS_MS[attempts - 1];
  return { due: now - asked >= wait, attempts };
}

// What call control may report for an ask it took.
export const RESYNC_STATES = ['queued', 'sent', 'held', 'no_binding', 'failed', 'unknown_action'];
