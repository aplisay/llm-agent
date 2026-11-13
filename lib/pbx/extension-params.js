/**
 * The settings an extension holds in `params`, by type. Pure.
 *
 * validateExtensionParams returns `{ ok: true, params }` with the cleaned
 * settings, or `{ ok: false, code, field, error }`. Unknown keys are refused.
 */
import {
  pbxRelease,
  releasedDestinationKinds,
  openingHoursReleased,
  huntSettingsReleased,
  queueSettingsReleased,
} from './release.js';

export const DEFAULT_RING_SECONDS = 30;
// The SIP path gives up on an unanswered call at 120 s, so a longer ring time
// never happened. 90 leaves room for the seconds before the ring starts.
export const MAX_RING_SECONDS = 90;
export const DEFAULT_STEP_SECONDS = 20;
export const HUNT_ORDERS = ['fixed', 'round_robin', 'longest_idle'];
const DESTINATION_KEYS = ['before', 'noAnswer', 'outOfHours'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const E164_RE = /^\+[1-9][0-9]{6,14}$/;
const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const refuse = (key, error, code = 'invalid_params') => ({ ok: false, code, field: `params.${key}`, error });
const isInteger = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

/** A schedule: `{ timezone, windows: [{ days: [1..7], from: "HH:MM", to: "HH:MM" }] }`. Day 1 is Monday. */
export function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) return 'must be an object';
  if (typeof schedule.timezone !== 'string' || !schedule.timezone) return 'needs a timezone';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: schedule.timezone });
  } catch {
    return `unknown timezone ${schedule.timezone}`;
  }
  if (!Array.isArray(schedule.windows) || !schedule.windows.length) return 'needs at least one window';
  for (const window of schedule.windows) {
    if (!Array.isArray(window?.days) || !window.days.length || !window.days.every((day) => isInteger(day, 1, 7))) {
      return 'each window needs days from 1 (Monday) to 7 (Sunday)';
    }
    if (!TIME_RE.test(window.from ?? '') || !TIME_RE.test(window.to ?? '')) return 'each window needs from and to as HH:MM';
  }
  return null;
}

function validateDestination(key, destination, release) {
  if (!destination || typeof destination !== 'object') return refuse(key, `${key} must be a destination or null`);
  if (!['agent', 'extension', 'external'].includes(destination.kind)) {
    return refuse(key, `${key}.kind must be agent, extension or external`);
  }
  if (!releasedDestinationKinds(release).includes(destination.kind)) {
    return refuse(key, 'This kind of destination is not available yet', 'destination_not_available');
  }
  if (destination.kind === 'agent') {
    if (!UUID_RE.test(destination.instanceId ?? '')) return refuse(key, `${key}.instanceId must be an id`);
    return { ok: true, value: { kind: 'agent', instanceId: destination.instanceId } };
  }
  if (destination.kind === 'extension') {
    if (!UUID_RE.test(destination.extensionId ?? '')) return refuse(key, `${key}.extensionId must be an id`);
    return { ok: true, value: { kind: 'extension', extensionId: destination.extensionId } };
  }
  if (!E164_RE.test(destination.number ?? '')) return refuse(key, `${key}.number must be a number in E.164 form`);
  return { ok: true, value: { kind: 'external', number: destination.number } };
}

export function validateExtensionParams(type, params, { release = pbxRelease() } = {}) {
  if (params === undefined || params === null) return { ok: true, params: {} };
  if (typeof params !== 'object' || Array.isArray(params)) {
    return { ok: false, code: 'invalid_params', field: 'params', error: 'params must be an object' };
  }
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue; // null clears a setting
    if (key === 'ringSeconds') {
      if (!isInteger(value, 5, MAX_RING_SECONDS)) return refuse(key, `ringSeconds must be a whole number from 5 to ${MAX_RING_SECONDS}`);
      out[key] = value;
    } else if (key === 'callWaiting' || key === 'record') {
      if (typeof value !== 'boolean') return refuse(key, `${key} must be true or false`);
      out[key] = value;
    } else if (key === 'stepSeconds' || key === 'order') {
      if (!huntSettingsReleased(release) || type !== 'hunt') return refuse(key, `${key} is only for an extension of type hunt`);
      if (key === 'stepSeconds' && !isInteger(value, 5, 120)) return refuse(key, 'stepSeconds must be a whole number from 5 to 120');
      if (key === 'order' && !HUNT_ORDERS.includes(value)) return refuse(key, `order must be one of ${HUNT_ORDERS.join(', ')}`);
      out[key] = value;
    } else if (key === 'openingHours') {
      if (!openingHoursReleased(release)) return refuse(key, 'Opening hours are not available yet', 'feature_not_available');
      const problem = validateSchedule(value);
      if (problem) return refuse(key, `openingHours ${problem}`);
      out[key] = value;
    } else if (DESTINATION_KEYS.includes(key)) {
      const checked = validateDestination(key, value, release);
      if (!checked.ok) return checked;
      out[key] = checked.value;
    } else if (key === 'queue') {
      if (!queueSettingsReleased(release) || type !== 'queue') return refuse(key, 'queue settings are only for an extension of type queue');
      if (typeof value !== 'object' || Array.isArray(value)) return refuse(key, 'queue must be an object');
      out[key] = value;
    } else {
      return refuse(key, `Unknown setting: ${key}`);
    }
  }
  return { ok: true, params: out };
}

/** The settings with their defaults filled in. */
export function effectiveParams(params = {}) {
  return {
    ringSeconds: params.ringSeconds ?? DEFAULT_RING_SECONDS,
    callWaiting: params.callWaiting ?? true,
    record: params.record ?? false,
    stepSeconds: params.stepSeconds ?? DEFAULT_STEP_SECONDS,
    order: params.order ?? 'fixed',
    openingHours: params.openingHours ?? null,
    before: params.before ?? null,
    noAnswer: params.noAnswer ?? null,
    outOfHours: params.outOfHours ?? null,
  };
}

/** Every destination a set of params names, as `{ key, destination }`. */
export function destinationsIn(params = {}) {
  return DESTINATION_KEYS.filter((key) => params?.[key]).map((key) => ({ key, destination: params[key] }));
}
