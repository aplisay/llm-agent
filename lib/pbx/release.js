/**
 * Which phone-system features this deployment accepts, from PBX_RELEASE. It is
 * one setting for the deployment. The per-organisation switch is the
 * `phoneSystem` capability (lib/capabilities.js).
 */

export const PBX_RELEASES = ['1', '1c', '2', '3', '4'];

export function pbxRelease(env = process.env) {
  const value = String(env.PBX_RELEASE ?? '').trim().toLowerCase();
  return PBX_RELEASES.includes(value) ? value : '1';
}

const reached = (release, step) => PBX_RELEASES.indexOf(release) >= PBX_RELEASES.indexOf(step);

export function releasedExtensionTypes(release = pbxRelease()) {
  const types = ['connection', 'ring_all'];
  if (reached(release, '1c')) types.push('hunt', 'forward');
  if (reached(release, '2')) types.push('agent');
  if (reached(release, '4')) types.push('queue');
  return types;
}

/** The kinds of place a call can be sent on to: before it rings, on no answer, out of hours. */
export function releasedDestinationKinds(release = pbxRelease()) {
  const kinds = [];
  if (reached(release, '1c')) kinds.push('extension', 'external');
  if (reached(release, '2')) kinds.push('agent');
  return kinds;
}

export function releasedPhoneKinds(release = pbxRelease()) {
  const kinds = ['deskphone', 'external'];
  if (reached(release, '2')) kinds.push('browser');
  return kinds;
}

export const openingHoursReleased = (release = pbxRelease()) => reached(release, '1c');
export const huntSettingsReleased = (release = pbxRelease()) => reached(release, '1c');
export const phoneRulesReleased = (release = pbxRelease()) => reached(release, '3');
export const queueSettingsReleased = (release = pbxRelease()) => reached(release, '4');
