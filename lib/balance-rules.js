/**
 * What an empty credit balance stops for an organisation with the phone
 * system. Pure: no database, so the ring plan can use it.
 *
 * - With the balance at zero or below, outside calls are refused
 *   (lib/outbound-authorisation.js). Calls in, calls between extensions and
 *   emergency calls go on.
 * - Once a monthly extension charge has been unpaid for {@link UNPAID_DAYS}
 *   days and the balance is still below zero, the organisation's phones stop
 *   taking calls (lib/pbx/ring-plan.js). Emergency calls still go out.
 *
 * An untracked balance (null) is never empty.
 *
 * @module lib/balance-rules
 */

export const UNPAID_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const tracked = (balance) => balance !== null && balance !== undefined && Number.isFinite(Number(balance));

/** A tracked balance at zero or below. */
export function balanceEmpty(organisation) {
  return tracked(organisation?.balance) && Number(organisation.balance) <= 0;
}

/** A monthly charge unpaid for {@link UNPAID_DAYS} days, with the balance still below zero. */
export function phonesSuspended(organisation, now = new Date()) {
  const since = organisation?.chargeUnpaidSince;
  if (!since || !tracked(organisation.balance) || Number(organisation.balance) >= 0) return false;
  return new Date(since).valueOf() <= now.valueOf() - UNPAID_DAYS * DAY_MS;
}
