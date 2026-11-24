/**
 * The monthly charge for each extension of an organisation with the phone
 * system, drawn from its credit balance (docs/billing-calls-from-usage.md,
 * "The phone system").
 *
 * The charge is a usage row for each extension and calendar month, priced by
 * the `extension` line of the organisation's rate card, and settled against
 * the balance like any other row. It is charged in advance: for the month the
 * job runs in, from the latest of the first of the month, the day the
 * extension was created and the day charging started (part months by the
 * day). An extension removed during a month is not refunded. `connection`
 * extensions are free.
 *
 * Nothing is charged until `upgrade-db` has brought the database to the
 * extension charge step, and no day before that upgrade is charged: it writes
 * the instant into the metadata table once (EXTENSION_CHARGE_STARTED_KEY).
 *
 * Each row's session id names the extension and the month, so a job that runs
 * twice, or on several servers at once, writes and charges each month once. A
 * row the rate card cannot price (no line, or no rate) is closed at nothing,
 * so a later card never prices a past month.
 *
 * If a charge draws money and leaves the balance below zero, the organisation
 * is marked (`chargeUnpaidSince`). Thirty days later, with the balance still
 * below zero, its phones stop taking calls; emergency calls still go out
 * (lib/pbx/ring-plan.js).
 *
 * @module lib/extension-charge
 */
import { Organisation, Extension, UsageRecord, Metadata, Op } from './database.js';
import { costUsageRow, resolveEffectiveRateCard, resolveRowCost } from './rates.js';
import { hasCapability, phoneSystemReady } from './capabilities.js';
import { presentAttributes, EXTENSION_CHARGE_STARTED_KEY } from './schema-guards.js';
import { extensionChargeReady } from './balance-rules.js';
import { periodsAt, DEFAULT_TIME_ZONE } from './outbound-policy.js';
import defaultLogger from './logger.js';

export { UNPAID_DAYS, phonesSuspended, extensionChargeReady } from './balance-rules.js';

export const CHARGE_TIME_ZONE = DEFAULT_TIME_ZONE;
export const EXTENSION_CHARGE = Object.freeze({ technology: 'extension', provider: 'pbx', unit: 'day' });
// Fixed, so a change of the extension's type within a month does not make a second row.
export const EXTENSION_CHARGE_METER_KEY = 'extension-charge';
export const FREE_EXTENSION_TYPES = new Set(['connection']);
// The cost status of a charge the rate card could not price, closed at nothing.
export const UNPRICED_COST_STATUS = 'unpriced';
const HOUR_MS = 60 * 60 * 1000;

/** True for an extension that is charged each month. */
export function isChargedExtension(extension) {
  return Boolean(extension?.type) && !FREE_EXTENSION_TYPES.has(extension.type);
}

/** The session id of an extension's charge for a month (`YYYY-MM`). */
export function chargeSessionId(extensionId, month) {
  return `extension-charge:${extensionId}:${month}`;
}

/** The instant charging started, as `upgrade-db` wrote it. Null before that. */
export async function chargeStartedAt({ Metadata: Meta = Metadata } = {}) {
  const row = await Meta.findByPk(EXTENSION_CHARGE_STARTED_KEY, { attributes: ['key', 'value'] });
  const at = row?.value ? new Date(row.value) : null;
  return at && !Number.isNaN(at.valueOf()) ? at : null;
}

/**
 * The part of the current month an extension is charged for, in the charge's
 * time zone: from the latest of the first, the day it was created and the day
 * charging started, to the last day. Null when it was created, or charging
 * starts, after today.
 *
 * The billing instant, which picks the rate card, is noon UTC on the first day
 * charged: inside that UK day all year. When the extension was made, or
 * charging started, later that day, it is that instant instead, so a rate that
 * starts with the organisation covers its first part month.
 *
 * @returns {{ month: string, from: string, to: string, days: number, daysInMonth: number, billedAt: Date } | null}
 */
export function chargePeriod({ createdAt, now = new Date(), startedAt = null, timeZone = CHARGE_TIME_ZONE }) {
  const today = periodsAt(now, timeZone);
  const created = periodsAt(createdAt ?? now, timeZone);
  const started = startedAt ? periodsAt(startedAt, timeZone) : null;
  if (created.day > today.day || (started && started.day > today.day)) return null;
  const month = today.day.slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const from = [`${month}-01`, created.day, started?.day].filter(Boolean).reduce((a, b) => (b > a ? b : a));
  const fromDay = Number(from.slice(8, 10));
  let billedAt = new Date(Date.UTC(year, monthNumber - 1, fromDay, 12));
  if (created.day === from && createdAt && new Date(createdAt) > billedAt) billedAt = new Date(createdAt);
  if (started?.day === from && new Date(startedAt) > billedAt) billedAt = new Date(startedAt);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    month,
    from,
    to: `${month}-${pad(daysInMonth)}`,
    days: daysInMonth - fromDay + 1,
    daysInMonth,
    billedAt,
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
 * What the job will charge for an extension of this type this month, for the
 * effect of a write: the full month, and the part it charges now, from the
 * latest of the first, `createdAt` and the day charging started, on the rate
 * card in force at the job's billing instant. `priced` is false, and both
 * amounts 0, when that card has no `extension` line or there is no card: the
 * job then charges nothing.
 */
export async function extensionPrice({
  organisationId, type, at = new Date(), createdAt = at, startedAt,
}, models = {}) {
  const start = startedAt === undefined ? await chargeStartedAt(models) : startedAt;
  const period = start ? chargePeriod({ createdAt, now: at, startedAt: start }) : null;
  const nothing = {
    amountMicros: 0, firstPeriodMicros: 0, currency: null, startsOn: period?.from ?? null, priced: false,
  };
  if (!period || !isChargedExtension({ type })) return nothing;
  const { card } = await resolveEffectiveRateCard({ organisationId, at: period.billedAt }, models);
  if (!card) return nothing;
  const row = (days) => ({
    ...EXTENSION_CHARGE, detail: type, quantity: days, metadata: { daysInMonth: period.daysInMonth },
  });
  const full = resolveRowCost(row(period.daysInMonth), card).costMicros;
  if (full === null) return { ...nothing, currency: card.currency || 'gbp' };
  return {
    amountMicros: full,
    firstPeriodMicros: resolveRowCost(row(period.days), card).costMicros ?? 0,
    currency: card.currency || 'gbp',
    startsOn: period.from,
    priced: true,
  };
}

/** True when the extension already has its charge for the month that holds `at`. */
export async function chargedThisMonth(extensionId, { at = new Date() } = {}, { UsageRecord: Usage = UsageRecord } = {}) {
  const { month } = chargePeriod({ createdAt: at, now: at });
  return (await Usage.count({ where: { sessionId: chargeSessionId(extensionId, month), meterKey: EXTENSION_CHARGE_METER_KEY } })) > 0;
}

/**
 * Mark or clear the organisation's unpaid charge after its balance moved.
 * Marked only when a charge just drew money and the balance is below zero;
 * cleared whenever the balance is at zero or above, or not tracked.
 */
export async function noteChargeBalance(organisationId, { drew = false, now = new Date(), transaction } = {}, {
  Organisation: Organisations = Organisation,
} = {}) {
  if (!extensionChargeReady()) return;
  const org = await Organisations.findByPk(organisationId, {
    attributes: ['id', 'balance', 'chargeUnpaidSince'], transaction,
  });
  if (!org) return;
  const below = org.balance !== null && org.balance !== undefined && Number(org.balance) < 0;
  if (below && drew && !org.chargeUnpaidSince) {
    await Organisations.update({ chargeUnpaidSince: now }, { where: { id: organisationId, chargeUnpaidSince: null }, transaction });
  } else if (!below && org.chargeUnpaidSince) {
    await Organisations.update({ chargeUnpaidSince: null }, { where: { id: organisationId }, transaction });
  }
}

/** A charge row that has no cost yet, or whose costing failed. */
const needsCosting = (row) => row.costMicros === null || row.costMicros === undefined || row.costStatus === 'errored';

/** Close a charge the rate card could not price at nothing, so no later card prices it. */
async function closeUnpriced(row, Usage) {
  if (row.costMicros !== null && row.costMicros !== undefined) return;
  if (row.costStatus !== 'no_line' && row.costStatus !== 'no_rate') return;
  await Usage.update(
    { costMicros: 0, costStatus: UNPRICED_COST_STATUS, metadata: { ...(row.metadata || {}), unpricedBecause: row.costStatus } },
    { where: { id: row.id, costMicros: null } },
  );
}

/**
 * Charge one organisation's extensions for the current month. Only live
 * extensions are charged: one removed before the job saw it is not. A row
 * left without a cost by an earlier run is costed now.
 *
 * @returns {Promise<{ charged: number, existing: number, repaired: number, drew: number }>}
 */
export async function chargeOrganisation(organisation, { now = new Date(), log = defaultLogger, startedAt } = {}, models = {}) {
  const { Extension: Extensions = Extension, UsageRecord: Usage = UsageRecord, cost = costUsageRow } = models;
  const counts = { charged: 0, existing: 0, repaired: 0, drew: 0 };
  if (!extensionChargeReady() || !hasCapability(organisation, 'phoneSystem')) return counts;
  const start = startedAt === undefined ? await chargeStartedAt(models) : startedAt;
  if (!start) return counts;
  const extensions = await Extensions.findAll({
    where: { organisationId: organisation.id, deletedAt: null, type: { [Op.notIn]: [...FREE_EXTENSION_TYPES] } },
    attributes: ['id', 'organisationId', 'number', 'type', 'createdAt'],
  });
  const month = periodsAt(now, CHARGE_TIME_ZONE).day.slice(0, 7);
  // One read of the month's rows, so a run that finds them all costed writes nothing.
  const found = extensions.length
    ? await Usage.findAll({ where: { sessionId: extensions.map((e) => chargeSessionId(e.id, month)), meterKey: EXTENSION_CHARGE_METER_KEY } })
    : [];
  const existing = new Map(found.map((row) => [row.sessionId, row]));
  for (const extension of extensions) {
    const period = chargePeriod({ createdAt: extension.createdAt, now, startedAt: start });
    if (!period) continue;
    const defaults = chargeRow(extension, period);
    let row = existing.get(defaults.sessionId);
    let created = false;
    if (!row) {
      // eslint-disable-next-line no-await-in-loop
      [row, created] = await Usage.findOrCreate({ where: { sessionId: defaults.sessionId, meterKey: defaults.meterKey }, defaults });
    }
    if (!created && !needsCosting(row)) {
      counts.existing += 1;
      continue;
    }
    counts[created ? 'charged' : 'repaired'] += 1;
    const appliedBefore = Number(row.appliedCostMicros) || 0;
    // eslint-disable-next-line no-await-in-loop
    await cost(row, { log });
    // eslint-disable-next-line no-await-in-loop
    await closeUnpriced(row, Usage);
    if ((Number(row.appliedCostMicros) || 0) > appliedBefore) counts.drew += 1;
  }
  await noteChargeBalance(organisation.id, { drew: counts.drew > 0, now }, models);
  return counts;
}

/**
 * Charge every organisation with the phone system for the current month.
 * Safe to run at any time and as often as wanted. Does nothing until the
 * extension charge schema step is ready and its start is recorded.
 */
export async function runExtensionCharges({ now = new Date(), log = defaultLogger } = {}, models = {}) {
  const { Organisation: Organisations = Organisation, Extension: Extensions = Extension } = models;
  const totals = { organisations: 0, charged: 0, existing: 0, repaired: 0, failed: 0 };
  if (!phoneSystemReady() || !extensionChargeReady()) return totals;
  const startedAt = await chargeStartedAt(models);
  if (!startedAt) {
    log.warn('the extension charge schema step is ready but its start is not recorded: run tools/agent-admin.js upgrade-db');
    return totals;
  }
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
      const counts = await chargeOrganisation(organisation, { now, log, startedAt }, models);
      totals.organisations += 1;
      totals.charged += counts.charged;
      totals.existing += counts.existing;
      totals.repaired += counts.repaired;
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
    .then((totals) => { if (totals.charged || totals.repaired || totals.failed) log.info(totals, 'extension charges'); })
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
