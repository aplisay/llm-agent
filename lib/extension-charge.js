/**
 * The monthly charge for each extension of an organisation with the phone
 * system, drawn from its credit balance (docs/billing-calls-from-usage.md,
 * "The phone system").
 *
 * The charge is a usage row for each extension and calendar month, priced by
 * the `extension` line of the organisation's rate card, and settled against
 * the balance like any other row. It is charged in advance: for the month the
 * job runs in, from the day the extension was created (part months by the day)
 * or from the first of the month. An extension removed during a month is not
 * refunded. `connection` extensions are free.
 *
 * Each row's session id names the extension and the month, so a job that runs
 * twice, or on two servers at once, writes and charges each month once.
 *
 * If a charge leaves the balance below zero, the organisation is marked
 * (`chargeUnpaidSince`). Thirty days later, with the balance still below
 * zero, its phones stop taking calls; emergency calls still go out
 * (lib/pbx/ring-plan.js).
 *
 * @module lib/extension-charge
 */
import { Organisation, Extension, UsageRecord, Op } from './database.js';
import { costUsageRow, resolveEffectiveRateCard, resolveRowCost } from './rates.js';
import { hasCapability, phoneSystemReady } from './capabilities.js';
import { stepReady, presentAttributes } from './schema-guards.js';
import { periodsAt, DEFAULT_TIME_ZONE } from './outbound-policy.js';
import defaultLogger from './logger.js';

export { UNPAID_DAYS, phonesSuspended } from './balance-rules.js';

export const CHARGE_TIME_ZONE = DEFAULT_TIME_ZONE;
export const EXTENSION_CHARGE = Object.freeze({ technology: 'extension', provider: 'pbx', unit: 'day' });
// Fixed, so a change of the extension's type within a month does not make a second row.
export const EXTENSION_CHARGE_METER_KEY = 'extension-charge';
export const FREE_EXTENSION_TYPES = new Set(['connection']);
const HOUR_MS = 60 * 60 * 1000;

/** True for an extension that is charged each month. */
export function isChargedExtension(extension) {
  return Boolean(extension?.type) && !FREE_EXTENSION_TYPES.has(extension.type);
}

/** The session id of an extension's charge for a month (`YYYY-MM`). */
export function chargeSessionId(extensionId, month) {
  return `extension-charge:${extensionId}:${month}`;
}

/**
 * The part of the current month an extension is charged for, in the charge's
 * time zone: from the day it was created, or from the first, to the last day.
 * Null when it was created after `now`.
 *
 * @returns {{ month: string, from: string, to: string, days: number, daysInMonth: number, billedAt: Date } | null}
 */
export function chargePeriod({ createdAt, now = new Date(), timeZone = CHARGE_TIME_ZONE }) {
  const today = periodsAt(now, timeZone);
  const created = periodsAt(createdAt ?? now, timeZone);
  if (created.day > today.day) return null;
  const month = today.day.slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const startsThisMonth = created.day.slice(0, 7) === month;
  const fromDay = startsThisMonth ? Number(created.day.slice(8, 10)) : 1;
  const pad = (n) => String(n).padStart(2, '0');
  return {
    month,
    from: `${month}-${pad(fromDay)}`,
    to: `${month}-${pad(daysInMonth)}`,
    days: daysInMonth - fromDay + 1,
    daysInMonth,
    billedAt: startsThisMonth ? created.dayStart : today.monthStart,
  };
}

/** The usage row an extension's charge for a period is written as. */
function chargeRow(extension, period) {
  return {
    sessionId: chargeSessionId(extension.id, period.month),
    meterKey: EXTENSION_CHARGE_METER_KEY,
    organisationId: extension.organisationId,
    ...EXTENSION_CHARGE,
    detail: extension.type,
    quantity: period.days,
    finalised: true,
    billedAt: period.billedAt,
    metadata: {
      extensionId: extension.id,
      number: extension.number,
      month: period.month,
      from: period.from,
      to: period.to,
      daysInMonth: period.daysInMonth,
    },
  };
}

/**
 * What adding an extension of this type would cost now, for the effect of a
 * write: the full month and the part month from today. The amounts are null
 * when the organisation's rate card has no `extension` line, or no card.
 */
export async function extensionPrice({ organisationId, type, at = new Date() }, models = {}) {
  const period = chargePeriod({ createdAt: at, now: at });
  const empty = { amountMicros: null, firstPeriodMicros: null, currency: null, startsOn: period.from };
  if (!isChargedExtension({ type })) return { ...empty, amountMicros: 0, firstPeriodMicros: 0 };
  const { card } = await resolveEffectiveRateCard({ organisationId, at }, models);
  if (!card) return empty;
  const row = (days) => ({
    ...EXTENSION_CHARGE, detail: type, quantity: days, metadata: { daysInMonth: period.daysInMonth },
  });
  return {
    amountMicros: resolveRowCost(row(period.daysInMonth), card).costMicros,
    firstPeriodMicros: resolveRowCost(row(period.days), card).costMicros,
    currency: card.currency || 'gbp',
    startsOn: period.from,
  };
}

/** True when the extension already has its charge for the month that holds `at`. */
export async function chargedThisMonth(extensionId, { at = new Date() } = {}, { UsageRecord: Usage = UsageRecord } = {}) {
  const { month } = chargePeriod({ createdAt: at, now: at });
  return (await Usage.count({ where: { sessionId: chargeSessionId(extensionId, month), meterKey: EXTENSION_CHARGE_METER_KEY } })) > 0;
}

/**
 * Mark or clear the organisation's unpaid charge after its balance moved.
 * Marked only when a charge was just drawn and the balance is below zero;
 * cleared whenever the balance is at zero or above, or not tracked.
 */
export async function noteChargeBalance(organisationId, { charged = false, now = new Date(), transaction } = {}, {
  Organisation: Organisations = Organisation,
} = {}) {
  if (!stepReady('extensionCharge')) return;
  const org = await Organisations.findByPk(organisationId, {
    attributes: ['id', 'balance', 'chargeUnpaidSince'], transaction,
  });
  if (!org) return;
  const below = org.balance !== null && org.balance !== undefined && Number(org.balance) < 0;
  if (below && charged && !org.chargeUnpaidSince) {
    await Organisations.update({ chargeUnpaidSince: now }, { where: { id: organisationId, chargeUnpaidSince: null }, transaction });
  } else if (!below && org.chargeUnpaidSince) {
    await Organisations.update({ chargeUnpaidSince: null }, { where: { id: organisationId }, transaction });
  }
}

/**
 * Charge one organisation's extensions for the current month. Only live
 * extensions are charged: one removed before the job saw it is not.
 *
 * @returns {Promise<{ charged: number, existing: number }>}
 */
export async function chargeOrganisation(organisation, { now = new Date(), log = defaultLogger } = {}, models = {}) {
  const { Extension: Extensions = Extension, UsageRecord: Usage = UsageRecord, cost = costUsageRow } = models;
  const counts = { charged: 0, existing: 0 };
  if (!hasCapability(organisation, 'phoneSystem')) return counts;
  const extensions = await Extensions.findAll({
    where: { organisationId: organisation.id, deletedAt: null, type: { [Op.notIn]: [...FREE_EXTENSION_TYPES] } },
    attributes: ['id', 'organisationId', 'number', 'type', 'createdAt'],
  });
  for (const extension of extensions) {
    const period = chargePeriod({ createdAt: extension.createdAt, now });
    if (!period) continue;
    const defaults = chargeRow(extension, period);
    // eslint-disable-next-line no-await-in-loop
    const [row, created] = await Usage.findOrCreate({
      where: { sessionId: defaults.sessionId, meterKey: defaults.meterKey },
      defaults,
    });
    if (!created) {
      counts.existing += 1;
      continue;
    }
    counts.charged += 1;
    // eslint-disable-next-line no-await-in-loop
    await cost(row, { log });
  }
  await noteChargeBalance(organisation.id, { charged: counts.charged > 0, now }, models);
  return counts;
}

/**
 * Charge every organisation with the phone system for the current month.
 * Safe to run at any time and as often as wanted.
 */
export async function runExtensionCharges({ now = new Date(), log = defaultLogger } = {}, models = {}) {
  const { Organisation: Organisations = Organisation, Extension: Extensions = Extension } = models;
  const totals = { organisations: 0, charged: 0, existing: 0, failed: 0 };
  if (!phoneSystemReady()) return totals;
  const owners = await Extensions.findAll({
    where: { deletedAt: null, type: { [Op.notIn]: [...FREE_EXTENSION_TYPES] } },
    attributes: ['organisationId'],
    group: ['organisationId'],
    raw: true,
  });
  for (const { organisationId } of owners) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const organisation = await Organisations.findByPk(organisationId, {
        attributes: presentAttributes(Organisations, ['id', 'capabilities']),
      });
      if (!organisation) continue;
      // eslint-disable-next-line no-await-in-loop
      const counts = await chargeOrganisation(organisation, { now, log }, models);
      totals.organisations += 1;
      totals.charged += counts.charged;
      totals.existing += counts.existing;
    } catch (err) {
      totals.failed += 1;
      log.warn({ err: err?.message, organisationId }, 'extension charge failed for an organisation; the next run tries again');
    }
  }
  return totals;
}

/**
 * Run the charge every hour, so a new month and a new extension are charged
 * soon after they start. Started by the server only (index.mjs).
 *
 * @returns {() => void} stop
 */
export function startExtensionCharges({ intervalMs = HOUR_MS, log = defaultLogger, databaseStarted } = {}) {
  let timer = null;
  let stopped = false;
  const run = () => runExtensionCharges({ log })
    .then((totals) => { if (totals.charged || totals.failed) log.info(totals, 'extension charges'); })
    .catch((err) => log.warn({ err: err?.message }, 'extension charge run failed; it runs again in an hour'));
  Promise.resolve(databaseStarted).then(() => {
    if (stopped) return;
    run();
    timer = setInterval(run, intervalMs);
    if (timer.unref) timer.unref();
  });
  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
  };
}
