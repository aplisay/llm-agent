/**
 * When a desk phone is asked to fetch its settings again, and where call
 * control is. Reads no database, so anything may import it.
 *
 * A phone whose settings changed is asked at once. Until it has fetched it is
 * asked again after a growing wait, a fixed number of times. After that the
 * phone's own daily refresh brings the change.
 */

// The wait before ask 2, 3, 4, 5 and 6 for one version of the settings.
export const RESYNC_WAITS_MS = [60, 5 * 60, 15 * 60, 60 * 60, 6 * 60 * 60].map((seconds) => seconds * 1000);
export const RESYNC_MAX_ASKS = RESYNC_WAITS_MS.length + 1;
export const RESYNC_BATCH = 100;
export const RESYNC_TIMEOUT_MS = 3000;

/**
 * Whether a device should be asked now.
 * @param {{ configVersion, resyncVersion, resyncAttempts, resyncRequestedAt }} device
 * @returns {{ due: boolean, attempts: number }} `attempts`: asks already made for this version
 */
export function resyncDue(device, now = Date.now()) {
  // A new version of the settings starts the count again.
  const attempts = device.resyncVersion === device.configVersion ? device.resyncAttempts ?? 0 : 0;
  if (attempts === 0) return { due: true, attempts };
  if (attempts >= RESYNC_MAX_ASKS) return { due: false, attempts };
  const asked = device.resyncRequestedAt ? new Date(device.resyncRequestedAt).getTime() : 0;
  return { due: now - asked >= RESYNC_WAITS_MS[attempts - 1], attempts };
}

/**
 * Where call control takes requests, and the token it expects. Null when
 * CALLCTL_URL or CALLCTL_SHARED_TOKEN is unset: phones are then not asked.
 */
export function callctlTarget(env = process.env) {
  const raw = String(env.CALLCTL_URL || '').trim().replace(/\/+$/, '');
  const token = String(env.CALLCTL_SHARED_TOKEN || '').trim();
  if (!token || !/^https?:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/i.test(raw)) return null;
  return { url: `${raw}/phones/resync`, token };
}

export const RESYNC_STATES = ['sent', 'held', 'no_binding', 'failed', 'unknown_action'];
