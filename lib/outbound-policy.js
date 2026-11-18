/**
 * The outbound policy of an organisation: the destination classes its calls
 * may reach, the hours they may be made, how many outside calls it may have in
 * progress, how many it may start in a minute, and how much they may cost in a
 * day and a month.
 *
 * A brand sets a ceiling. An organisation's own values may only be lower.
 * lib/outbound-authorisation.js applies the policy on our chargeable trunks,
 * to organisations that have the phone system (docs/outbound-call-authorisation.md).
 *
 * This module reads no database, so anything may import it.
 *
 * @module lib/outbound-policy
 */
import { stepReady } from './schema-guards.js';

export const DESTINATION_CLASSES = [
  'ukLandline', 'ukMobile', 'freephone', 'service', 'premium', 'crownDependencies', 'international',
];

/** The classes an organisation may call when nobody has changed them. */
export const DEFAULT_CLASSES = Object.freeze({
  ukLandline: true,
  ukMobile: true,
  freephone: true,
  service: false,
  premium: false,
  crownDependencies: false,
  international: false,
});

export const LIMIT_FIELDS = ['callsInProgress', 'callsPerMinute', 'spendPerDayMicros', 'spendPerMonthMicros'];

/**
 * The ceiling of a brand that sets none, and of each field a brand leaves out.
 * Spend is in micros of a pound (1e-6 GBP), the unit of `costMicros`.
 */
export const PLATFORM_CEILING = Object.freeze({
  classes: DEFAULT_CLASSES,
  callsInProgress: 10,
  callsPerMinute: 10,
  spendPerDayMicros: 50_000_000,
  spendPerMonthMicros: 500_000_000,
});

const MAX_COUNT = 10_000;
const MAX_SPEND_MICROS = 1e15;
export const DEFAULT_TIME_ZONE = 'Europe/London';

// Ofcom numbering: 01481 Guernsey, 01534 Jersey, 01624 Isle of Man, and the
// islands' mobile ranges as far as we know them. A missing mobile range is
// classed as a UK mobile; the tariff still prices it.
const CROWN_DEPENDENCY_PREFIXES = [
  '441481', '441534', '441624',
  '447509', '447524', '447624', '447781', '447797', '447829', '447839', '447911', '447924', '447937',
];

/** False until the schema 75 upgrade has run (lib/schema-guards.js). The policy then refuses to decide. */
export function outboundPolicyReady() {
  return stepReady('outboundPolicy');
}

/** The refusal codes of the policy. */
export const POLICY_CODES = Object.freeze({
  destinationClass: 'destination_class',
  outsideHours: 'outside_hours',
  callsInProgress: 'calls_in_progress_limit',
  callsPerMinute: 'calls_per_minute_limit',
  spendPerDay: 'daily_spend_limit',
  spendPerMonth: 'monthly_spend_limit',
  unavailable: 'outbound_policy_unavailable',
  notReady: 'outbound_policy_not_ready',
});

/** The refusals that mean a limit was reached. The first of these each day sends a notice. */
export const LIMIT_CODES = new Set([
  POLICY_CODES.callsInProgress, POLICY_CODES.callsPerMinute, POLICY_CODES.spendPerDay, POLICY_CODES.spendPerMonth,
]);

const CLASS_NAMES = {
  ukLandline: 'a UK landline',
  ukMobile: 'a UK mobile',
  freephone: 'a freephone number',
  service: 'a service number',
  premium: 'a premium rate, personal or directory number',
  crownDependencies: 'a Channel Islands or Isle of Man number',
  international: 'an international number',
};

/**
 * The class of a destination in canonical `+E.164` form, or null for a UK
 * number that is in no class (such as 05 or 04) and for anything that is not a
 * number.
 *
 * @param {string|null} destination
 * @returns {string|null}
 */
export function classifyDestination(destination) {
  if (typeof destination !== 'string' || !/^\+[1-9]\d{5,14}$/.test(destination)) return null;
  const digits = destination.slice(1);
  if (!digits.startsWith('44')) return 'international';
  const national = digits.slice(2);
  if (national.length < 6 || national.length > 10) return null;
  if (CROWN_DEPENDENCY_PREFIXES.some((prefix) => digits.startsWith(prefix))) return 'crownDependencies';
  // 070 personal numbers and 076 pagers sit inside 07 but are charged like premium numbers.
  if (/^7[06]/.test(national)) return 'premium';
  if (/^9/.test(national) || /^118/.test(national)) return 'premium';
  if (/^80[08]/.test(national)) return 'freephone';
  if (/^8[47]/.test(national)) return 'service';
  if (/^[123]/.test(national)) return 'ukLandline';
  if (/^7/.test(national)) return 'ukMobile';
  return null;
}

const isCount = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_COUNT;
const isSpend = (value) => Number.isInteger(value) && value >= 0 && value <= MAX_SPEND_MICROS;
const validLimit = (field, value) => (field.startsWith('spend') ? isSpend(value) : isCount(value));

function validTimeZone(zone) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** An error `{ field, error }` for an hours rule that cannot be stored, or null. */
function hoursError(hours) {
  if (hours === null) return null;
  if (!hours || typeof hours !== 'object' || Array.isArray(hours)) {
    return { field: 'hours', error: 'hours must be an object or null' };
  }
  const { timeZone = DEFAULT_TIME_ZONE, days, from, to } = hours;
  if (typeof timeZone !== 'string' || !validTimeZone(timeZone)) {
    return { field: 'hours.timeZone', error: 'hours.timeZone must be an IANA time zone, such as Europe/London' };
  }
  if (!Array.isArray(days) || !days.length || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    || new Set(days).size !== days.length) {
    return { field: 'hours.days', error: 'hours.days must list days from 1 (Monday) to 7 (Sunday), each once' };
  }
  if (typeof from !== 'string' || !TIME_RE.test(from)) return { field: 'hours.from', error: 'hours.from must be a time such as 08:00' };
  if (typeof to !== 'string' || !TIME_RE.test(to)) return { field: 'hours.to', error: 'hours.to must be a time such as 18:00' };
  if (from === to) return { field: 'hours.to', error: 'hours.from and hours.to must differ' };
  return null;
}

function classesError(classes, field) {
  if (!classes || typeof classes !== 'object' || Array.isArray(classes)) {
    return { field, error: `${field} must be an object of class names and true or false` };
  }
  for (const [name, value] of Object.entries(classes)) {
    if (!DESTINATION_CLASSES.includes(name)) return { field: `${field}.${name}`, error: `Unknown destination class: ${name}` };
    if (typeof value !== 'boolean') return { field: `${field}.${name}`, error: `${field}.${name} must be true or false` };
  }
  return null;
}

/**
 * Apply a change to a stored policy. Send only the fields to change: a class
 * not named keeps its value, and a limit or the hours set to null goes back to
 * the brand's ceiling (for a limit) or to no hours rule.
 *
 * @returns {{ policy: object } | { error: string, field: string }}
 */
export function mergePolicy(stored, change) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) {
    return { field: 'body', error: 'The body must be an object' };
  }
  const known = new Set(['classes', 'hours', ...LIMIT_FIELDS]);
  const unknown = Object.keys(change).find((key) => !known.has(key));
  if (unknown) return { field: unknown, error: `Unknown field: ${unknown}` };

  const base = stored && typeof stored === 'object' ? stored : {};
  const policy = { ...base };
  if (change.classes !== undefined) {
    const err = classesError(change.classes, 'classes');
    if (err) return err;
    policy.classes = { ...(base.classes || {}), ...change.classes };
  }
  for (const field of LIMIT_FIELDS) {
    if (change[field] === undefined) continue;
    if (change[field] === null) {
      delete policy[field];
      continue;
    }
    if (!validLimit(field, change[field])) {
      return { field, error: `${field} must be a whole number from 0${field.startsWith('spend') ? '' : ` to ${MAX_COUNT}`}, or null` };
    }
    policy[field] = change[field];
  }
  if (change.hours !== undefined) {
    const err = hoursError(change.hours);
    if (err) return err;
    if (change.hours === null) delete policy.hours;
    else policy.hours = { timeZone: change.hours.timeZone || DEFAULT_TIME_ZONE, days: [...change.hours.days].sort(), from: change.hours.from, to: change.hours.to };
  }
  return { policy };
}

/** An error `{ field, error }` for a brand's ceiling, or null. Fields left out take the platform's value. */
export function validateCeiling(ceiling) {
  if (ceiling === null) return null;
  if (!ceiling || typeof ceiling !== 'object' || Array.isArray(ceiling)) {
    return { field: 'outboundCeiling', error: 'outboundCeiling must be an object or null' };
  }
  const known = new Set(['classes', ...LIMIT_FIELDS]);
  const unknown = Object.keys(ceiling).find((key) => !known.has(key));
  if (unknown) return { field: `outboundCeiling.${unknown}`, error: `Unknown field: ${unknown}` };
  if (ceiling.classes !== undefined) {
    const err = classesError(ceiling.classes, 'outboundCeiling.classes');
    if (err) return err;
  }
  for (const field of LIMIT_FIELDS) {
    if (ceiling[field] === undefined) continue;
    if (!validLimit(field, ceiling[field])) {
      return { field: `outboundCeiling.${field}`, error: `outboundCeiling.${field} must be a whole number from 0` };
    }
  }
  return null;
}

/**
 * The full ceiling for a brand's stored one. A field the brand does not set,
 * and a brand with no ceiling, take the platform's value: there is no
 * "no ceiling".
 */
export function ceilingFor(brandCeiling) {
  const stored = brandCeiling && typeof brandCeiling === 'object' && !Array.isArray(brandCeiling) ? brandCeiling : {};
  const classes = {};
  for (const name of DESTINATION_CLASSES) {
    const value = stored.classes?.[name];
    classes[name] = typeof value === 'boolean' ? value : PLATFORM_CEILING.classes[name];
  }
  const ceiling = { classes };
  for (const field of LIMIT_FIELDS) {
    ceiling[field] = validLimit(field, stored[field]) ? stored[field] : PLATFORM_CEILING[field];
  }
  return ceiling;
}

/** The first field of a policy that is wider than the ceiling, as `{ field, error }`, or null. */
export function aboveCeiling(policy, ceiling) {
  for (const name of DESTINATION_CLASSES) {
    if (policy?.classes?.[name] === true && !ceiling.classes[name]) {
      return { field: `classes.${name}`, error: `Calls to ${CLASS_NAMES[name].replace(/^an? /, '')}s are not available for this organisation` };
    }
  }
  for (const field of LIMIT_FIELDS) {
    if (policy?.[field] != null && policy[field] > ceiling[field]) {
      return { field, error: `${field} may be at most ${ceiling[field]}` };
    }
  }
  return null;
}

/**
 * The policy that applies: each class is open only when both the organisation
 * and the ceiling open it, and each limit is the lower of the two. A stored
 * value that is not usable is read as closed or as the ceiling, never as open.
 */
export function effectivePolicy(policy, ceiling) {
  const stored = policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : {};
  const classes = {};
  for (const name of DESTINATION_CLASSES) {
    const own = typeof stored.classes?.[name] === 'boolean' ? stored.classes[name] : DEFAULT_CLASSES[name];
    classes[name] = own && ceiling.classes[name] === true;
  }
  const effective = { classes };
  for (const field of LIMIT_FIELDS) {
    const own = validLimit(field, stored[field]) ? stored[field] : null;
    effective[field] = own === null ? ceiling[field] : Math.min(own, ceiling[field]);
  }
  effective.hours = stored.hours && !hoursError(stored.hours) ? stored.hours : null;
  // A stored hours rule that no longer validates closes every hour rather than none.
  effective.hoursUnusable = Boolean(stored.hours) && !effective.hours;
  return effective;
}

const partsFormatters = new Map();
function zonedParts(at, timeZone) {
  let fmt = partsFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    });
    partsFormatters.set(timeZone, fmt);
  }
  const parts = Object.fromEntries(fmt.formatToParts(at).map((p) => [p.type, p.value]));
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(parts.weekday) + 1;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second), weekday,
  };
}

/** The instant that is local midnight at the start of the given local date. */
function localMidnight(year, month, day, timeZone) {
  const target = Date.UTC(year, month - 1, day);
  let guess = target;
  // Two passes settle the zone's offset, also across a clock change.
  for (let i = 0; i < 2; i += 1) {
    const p = zonedParts(new Date(guess), timeZone);
    const shown = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    guess += target - shown;
  }
  return new Date(guess);
}

/**
 * The starts of the local day and month that contain `at`, and the local date
 * as `YYYY-MM-DD`. Spend limits and the daily notice run on these.
 */
export function periodsAt(at, timeZone = DEFAULT_TIME_ZONE) {
  const zone = validTimeZone(timeZone) ? timeZone : DEFAULT_TIME_ZONE;
  const p = zonedParts(at, zone);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    dayStart: localMidnight(p.year, p.month, p.day, zone),
    monthStart: localMidnight(p.year, p.month, 1, zone),
    day: `${p.year}-${pad(p.month)}-${pad(p.day)}`,
  };
}

/** True when `at` is inside the hours rule. A rule whose `to` is before its `from` runs past midnight. */
export function withinHours(hours, at) {
  if (!hours) return true;
  const p = zonedParts(at, hours.timeZone || DEFAULT_TIME_ZONE);
  const minute = p.hour * 60 + p.minute;
  const toMinutes = (text) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  const from = toMinutes(hours.from);
  const to = toMinutes(hours.to);
  if (from < to) return hours.days.includes(p.weekday) && minute >= from && minute < to;
  // Past midnight: the part after midnight belongs to the day before.
  if (minute >= from) return hours.days.includes(p.weekday);
  if (minute < to) return hours.days.includes(p.weekday === 1 ? 7 : p.weekday - 1);
  return false;
}

const pounds = (micros) => `£${(micros / 1e6).toFixed(2)}`;

/**
 * The checks that need no counts: the destination's class and the hours.
 * @returns {{ code: string, reason: string, destinationClass?: string|null } | null}
 */
export function checkDestination(effective, { destination, at = new Date() }) {
  const destinationClass = classifyDestination(destination);
  if (!destinationClass) {
    return {
      code: POLICY_CODES.destinationClass, destinationClass: null,
      reason: `destination ${destination} is in no destination class the organisation's outbound policy allows`,
    };
  }
  if (!effective.classes[destinationClass]) {
    return {
      code: POLICY_CODES.destinationClass, destinationClass,
      reason: `destination ${destination} is ${CLASS_NAMES[destinationClass]}, which the organisation's outbound policy does not allow`,
    };
  }
  if (effective.hoursUnusable || !withinHours(effective.hours, at)) {
    return { code: POLICY_CODES.outsideHours, destinationClass, reason: 'outside calls are not allowed at this time by the organisation\'s outbound policy' };
  }
  return null;
}

/**
 * The checks on counts and spend. A count that is not a number fails closed.
 *
 * @param {object} effective  from {@link effectivePolicy}
 * @param {{ callsInProgress: number, callsLastMinute: number, spendToday: number, spendMonth: number }} usage
 * @returns {{ code: string, reason: string, limit: string, value: number, current: number } | null}
 */
export function checkLimits(effective, usage) {
  const checks = [
    ['callsInProgress', usage?.callsInProgress, POLICY_CODES.callsInProgress,
      (v) => `the organisation already has ${v} outside calls in progress, its limit`],
    ['callsPerMinute', usage?.callsLastMinute, POLICY_CODES.callsPerMinute,
      (v) => `the organisation has started ${v} outside calls in the last minute, its limit`],
    ['spendPerDayMicros', usage?.spendToday, POLICY_CODES.spendPerDay,
      (v) => `the organisation has spent ${pounds(v)} on outside calls today, at or over its daily limit of ${pounds(effective.spendPerDayMicros)}`],
    ['spendPerMonthMicros', usage?.spendMonth, POLICY_CODES.spendPerMonth,
      (v) => `the organisation has spent ${pounds(v)} on outside calls this month, at or over its monthly limit of ${pounds(effective.spendPerMonthMicros)}`],
  ];
  for (const [limit, current, code, say] of checks) {
    const value = effective[limit];
    if (typeof current !== 'number' || !Number.isFinite(current)) {
      return { code: POLICY_CODES.unavailable, limit, value, current: null, reason: 'the organisation\'s outbound usage could not be read' };
    }
    if (current >= value) return { code, limit, value, current, reason: say(current) };
  }
  return null;
}
