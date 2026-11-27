/**
 * Would an outside call by an organisation be refused at this moment, and why.
 * The checks a call meets (lib/outbound-authorisation.js) that do not depend on
 * the number dialled, run without writing a decision. Every reason that applies
 * is listed, not only the first.
 *
 * A web page reads it on every view, so each organisation's answer is kept for
 * NOW_CACHE_MS in this process, and reads that arrive while it is worked out
 * share the one result.
 *
 * @module lib/outbound-now
 */
import {
  effectivePolicy, withinHours, periodsAt, POLICY_CODES, DEFAULT_TIME_ZONE,
} from './outbound-policy.js';
import { brandCeiling, outboundUsage } from './outbound-authorisation.js';
import { balanceEmpty, phonesSuspended } from './balance-rules.js';
import { phonesStopped } from './pbx/ring-plan.js';

export const NOW_CACHE_MS = 15_000;
const CACHE_MAX = 5000;
const cache = new Map(); // organisationId -> { until, value }

const MESSAGES = {
  organisation_deactivated: 'The organisation is deactivated, so its phones make no calls except to 999 and 112.',
  charge_unpaid: 'A monthly charge has been unpaid for 30 days, so the phones make no calls except to 999 and 112.',
  [POLICY_CODES.balanceEmpty]: 'The credit balance is empty, so outside calls are refused until it is topped up.',
  [POLICY_CODES.destinationClass]: 'The outbound policy allows no kind of number.',
  [POLICY_CODES.outsideHours]: 'Outside calls are not allowed at this time.',
  [POLICY_CODES.spendPerDay]: "Today's spend on outside calls has reached its limit.",
  [POLICY_CODES.spendPerMonth]: "This month's spend on outside calls has reached its limit.",
  [POLICY_CODES.callsInProgress]: 'The most outside calls allowed at once are in progress.',
  [POLICY_CODES.callsPerMinute]: 'The most outside calls allowed in a minute have started.',
  [POLICY_CODES.unavailable]: 'The outbound use could not be read, so outside calls are refused.',
};

const reason = (code, extra = {}) => ({ code, message: MESSAGES[code], ...extra });

/** The start of the next local day, and of the next local month, after `at`. */
function nextPeriods(at, timeZone) {
  const { dayStart, monthStart } = periodsAt(at, timeZone);
  return {
    nextDay: periodsAt(new Date(dayStart.valueOf() + 36 * 3_600_000), timeZone).dayStart,
    nextMonth: periodsAt(new Date(monthStart.valueOf() + 32 * 86_400_000), timeZone).monthStart,
  };
}

/**
 * @param {object} organisation  the row: status, balance, chargeUnpaidSince, outboundPolicy, brand
 * @returns {Promise<{ blocked: boolean, at: string, reasons: object[] }>}
 */
export async function outboundNow(organisation, { at = new Date(), models = {} } = {}) {
  const reasons = [];
  if (phonesStopped(organisation)) reasons.push(reason('organisation_deactivated'));
  if (phonesSuspended(organisation, at)) reasons.push(reason('charge_unpaid'));
  if (balanceEmpty(organisation)) reasons.push(reason(POLICY_CODES.balanceEmpty));

  const effective = effectivePolicy(organisation.outboundPolicy, await brandCeiling(organisation.brand, models));
  if (!Object.values(effective.classes).some(Boolean)) reasons.push(reason(POLICY_CODES.destinationClass));
  if (effective.hoursUnusable || !withinHours(effective.hours, at)) reasons.push(reason(POLICY_CODES.outsideHours));

  const timeZone = effective.hours?.timeZone || DEFAULT_TIME_ZONE;
  const usage = await outboundUsage({ organisationId: organisation.id, at, timeZone }, models);
  const { nextDay, nextMonth } = nextPeriods(at, timeZone);
  const limits = [
    ['callsInProgress', usage.callsInProgress, POLICY_CODES.callsInProgress],
    ['callsPerMinute', usage.callsLastMinute, POLICY_CODES.callsPerMinute],
    ['spendPerDayMicros', usage.spendToday, POLICY_CODES.spendPerDay, nextDay],
    ['spendPerMonthMicros', usage.spendMonth, POLICY_CODES.spendPerMonth, nextMonth],
  ];
  for (const [limit, current, code, until] of limits) {
    const value = effective[limit];
    if (typeof current !== 'number' || !Number.isFinite(current)) {
      reasons.push(reason(POLICY_CODES.unavailable, { limit }));
    } else if (current >= value) {
      reasons.push(reason(code, { limit, value, current, ...(until ? { until: until.toISOString() } : {}) }));
    }
  }
  return { blocked: reasons.length > 0, at: at.toISOString(), reasons };
}

/** {@link outboundNow}, kept for NOW_CACHE_MS per organisation. */
export async function cachedOutboundNow(organisation, { now = Date.now(), models } = {}) {
  const hit = cache.get(organisation.id);
  if (hit && hit.until > now) return hit.value;
  if (cache.size >= CACHE_MAX) {
    for (const [id, entry] of cache) if (entry.until <= now) cache.delete(id);
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  }
  const value = outboundNow(organisation, { at: new Date(now), models });
  cache.set(organisation.id, { until: now + NOW_CACHE_MS, value });
  // A failed read is not kept.
  value.catch(() => { if (cache.get(organisation.id)?.value === value) cache.delete(organisation.id); });
  return value;
}

/** Drop an organisation's kept answer, after a change to its policy here. */
export function forgetOutboundNow(organisationId) {
  cache.delete(organisationId);
}
