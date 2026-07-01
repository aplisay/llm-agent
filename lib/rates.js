/**
 * Costing engine (Phase 2) — values `usage_records` against named, date-ranged
 * {@link RateCard}s at transaction end and decrements {@link Organisation}.balance.
 *
 * Design (see docs/implementation/rate-cards-implementation-plan.md §2, §4):
 *  - **Cost-at-write / frozen.** Each finalised row is valued ONCE at its
 *    `billedAt` instant; later rate edits never move historical cost (rate cards
 *    are immutable once referenced — a price change is a new card).
 *  - **Additive, itemised by orthogonal dimension** (`audio-path | model | tts |
 *    stt`). A row's cost = Σ over dimensions of (most-specific matching line's
 *    price × the row quantity converted to that line's unit). One voice/ms row is
 *    priced on BOTH audio-path (handler+media) and model (the model id in
 *    `detail`) for a minute-billed realtime model; a pipeline call itemises across
 *    its separate voice / llm / tts / stt rows.
 *  - **Match = key omission is wildcard.** A line matches a row iff every
 *    *specified* `match` key equals the row's field; the most-specific (most keys)
 *    line wins within each dimension. `media` is only meaningful on voice rows.
 *  - **Never throws.** A costing failure must never become a metering failure, so
 *    every public entry point is best-effort: a resolver throw stamps
 *    `costStatus='errored'` and leaves the quantity untouched.
 *  - **Idempotent settle.** balance -= (costMicros - appliedCostMicros) in one
 *    atomic statement, then appliedCostMicros = costMicros — convergent, so a
 *    reflush / per-row finalisation / nightly sweep all share it without
 *    double-applying.
 *
 * All money is **micro-pence** (1e-6 GBP penny); GBP-only in v1.
 *
 * @module lib/rates
 */
import {
  UsageRecord as DefaultUsageRecord,
  RateCard as DefaultRateCard,
  Organisation as DefaultOrganisation,
  User as DefaultUser,
  Call as DefaultCall,
  Tariff as DefaultTariff,
  TariffPrefix as DefaultTariffPrefix,
} from './database.js';
import { resolveTariff, matchTariffPrefix, computeDestinationCost, normaliseDestination } from './tariffs.js';
import { maybeFireBalanceCallbacks } from './balance-callback.js';
import defaultLogger from './logger.js';

const MS_PER_MINUTE = 60000;

/**
 * Money scale: balances and costs are stored internally in **micro-pence**
 * (1e-6 GBP); a penny is 1e-2 GBP = **1e4** micro-pence. Convert at the API edge
 * (pennies, the Stripe/UI unit) ↔ internal (micros). One shared helper so the
 * scale lives in exactly one place (see the scale-assertion test).
 */
export const MICROS_PER_PENNY = 10000;
export function penniesToMicros(pennies) {
  return Math.round(Number(pennies) * MICROS_PER_PENNY);
}
export function microsToPennies(micros) {
  return micros == null ? null : Number(micros) / MICROS_PER_PENNY;
}

/**
 * The pricing dimensions; a card line declares exactly one. The first four use
 * exact-key matching (see resolveRowCost). `destination` is special: it prices a
 * carried outbound leg by LONGEST-PREFIX match on the row's normalised destination
 * against a NAMED tariff (resolved async in costUsageRow, not resolveRowCost).
 */
export const DIMENSIONS = ['audio-path', 'model', 'tts', 'stt', 'destination'];

/** Row fields a rate line may match on. `dim` is the grouping, NOT a match key. */
const MATCH_KEYS = ['technology', 'provider', 'detail', 'unit', 'media'];

/**
 * Structural validation of a RateCard `detail` ({ lines: [...] }) for the CRUD
 * write path. Returns an error string, or null when valid. (The semantic
 * same-meter double-charge guardrail is UI-guided; this is the persistence gate.)
 */
export function validateRateLines(detail) {
  if (detail == null) return null;
  if (typeof detail !== 'object' || Array.isArray(detail) || !Array.isArray(detail.lines)) {
    return 'detail must be an object of the form { lines: [...] }';
  }
  for (let i = 0; i < detail.lines.length; i += 1) {
    const line = detail.lines[i];
    if (!line || typeof line !== 'object') return `line ${i}: must be an object`;
    if (!DIMENSIONS.includes(line.dim)) return `line ${i}: dim must be one of ${DIMENSIONS.join('|')}`;
    if (line.match != null && (typeof line.match !== 'object' || Array.isArray(line.match))) {
      return `line ${i}: match must be an object`;
    }
    if (line.dim === 'destination') {
      // A destination line prices via a NAMED tariff (a longest-prefix deck), not
      // an inline unit/priceMicros: the per-call connect + per-minute rates live on
      // the tariff's prefix rows. Exactly one destination line is meaningful.
      if (typeof line.tariff !== 'string' || !line.tariff) return `line ${i}: destination line requires a tariff name`;
      continue;
    }
    if (typeof line.unit !== 'string' || !line.unit) return `line ${i}: unit is required`;
    if (!Number.isFinite(Number(line.priceMicros))) return `line ${i}: priceMicros must be a number`;
  }
  return null;
}

/**
 * Convert a metered `quantity` (in the row's meter `unit`) into the rate line's
 * billing `unit`. Only time needs scaling (ms/seconds → minute); token and
 * character counts are 1:1 with their billing unit (a line matches a specific
 * token unit, e.g. `output_tokens`, priced per `token`).
 *
 * @returns {number} quantity expressed in `lineUnit` (may be fractional)
 */
export function toLineUnits(quantity, rowUnit, lineUnit) {
  const q = Number(quantity) || 0;
  if (lineUnit === 'minute') {
    if (rowUnit === 'milliseconds') return q / MS_PER_MINUTE;
    if (rowUnit === 'seconds') return q / 60;
    return q; // already minutes
  }
  return q;
}

/** A line matches iff every *specified* match key equals the row's field. */
export function lineMatchesRow(match = {}, row = {}) {
  for (const key of MATCH_KEYS) {
    if (match[key] === undefined || match[key] === null) continue; // wildcard
    if (row[key] !== match[key]) return false;
  }
  return true;
}

/** Specificity = number of specified match keys (more specific wins within a dim). */
function lineSpecificity(match = {}) {
  return MATCH_KEYS.reduce((n, k) => n + (match[k] !== undefined && match[k] !== null ? 1 : 0), 0);
}

/**
 * Pure additive resolver: value one usage row against a rate card's lines.
 *
 * For each dimension present in the card, pick the most-specific line that
 * matches the row (ties broken deterministically by line order — the card
 * validator forbids genuinely ambiguous equal-specificity lines), convert the row
 * quantity to that line's unit, and SUM the per-dimension costs.
 *
 * @param {object} row     { technology, provider, detail, unit, media, quantity }
 * @param {object} card    a RateCard (uses `detail.lines`)
 * @returns {{ costMicros: number|null, status: 'matched'|'no_line', breakdown: Array }}
 */
export function resolveRowCost(row, card) {
  const lines = Array.isArray(card?.detail?.lines) ? card.detail.lines : [];
  const breakdown = [];
  let costMicros = 0;

  for (const dim of DIMENSIONS) {
    // `destination` is not an exact-key dimension — it's a longest-prefix tariff
    // match resolved async in costUsageRow (needs a DB read). Skip it here.
    if (dim === 'destination') continue;
    // Candidate lines for this dimension that match the row, most-specific first
    // (stable: equal specificity keeps card line order).
    const candidates = lines
      .map((line, index) => ({ line, index }))
      .filter(({ line }) => line && line.dim === dim && lineMatchesRow(line.match, row))
      .sort((a, b) => lineSpecificity(b.line.match) - lineSpecificity(a.line.match) || a.index - b.index);

    const best = candidates[0]?.line;
    if (!best) continue;

    const quantity = toLineUnits(row.quantity, row.unit, best.unit);
    const lineMicros = Math.round((Number(best.priceMicros) || 0) * quantity);
    costMicros += lineMicros;
    breakdown.push({
      dim,
      match: best.match,
      unit: best.unit,
      priceMicros: Number(best.priceMicros) || 0,
      quantity,
      costMicros: lineMicros,
    });
  }

  return breakdown.length
    ? { costMicros, status: 'matched', breakdown }
    : { costMicros: null, status: 'no_line', breakdown: [] };
}

/**
 * Destination (carrier-passthrough) cost for a carried outbound leg — the telco
 * dimension. The card's `destination` line names a tariff; load the tariff
 * effective @billedAt and LONGEST-PREFIX-match the row's frozen normalised
 * destination (`row.metadata.destination`, stamped only on billable legs — see D3),
 * then charge, via {@link computeDestinationCost}: a flat call-start cost + a
 * per-prefix connect fee + the peak/off-peak per-minute rate (chosen by the call
 * start time in the tariff's timezone/schedule) over the duration rounded UP to the
 * tariff's rounding increment (our 6-second cost-recovery policy). Additive with the
 * exact-dimension cost. Returns null when the card has no destination line, the row
 * isn't destination-billable, or no tariff/prefix matches.
 *
 * @returns {Promise<{costMicros:number, entry:object}|null>}
 */
export async function resolveDestinationCost(row, card, billedAt, {
  Tariff = DefaultTariff, TariffPrefix = DefaultTariffPrefix,
} = {}) {
  const lines = Array.isArray(card?.detail?.lines) ? card.detail.lines : [];
  const destLine = lines.find((l) => l && l.dim === 'destination' && l.tariff);
  const raw = row?.metadata?.destinationRaw;
  if (!destLine || !raw) return null;
  const tariff = await resolveTariff(destLine.tariff, billedAt, { Tariff });
  if (!tariff) return null;
  // Normalise the frozen dialled number with the TARIFF's own home country, then
  // longest-prefix-match its (immutable) deck.
  const number = normaliseDestination(raw, { defaultCountry: tariff.defaultCountry });
  if (!number) return null;
  const prefixRow = await matchTariffPrefix(tariff.id, number, { TariffPrefix });
  if (!prefixRow) return null;
  const c = computeDestinationCost(tariff, prefixRow, { billedAt, durationMs: row.quantity });
  const startIso = (tariff.startDate instanceof Date ? tariff.startDate : new Date(tariff.startDate)).toISOString();
  return {
    costMicros: c.costMicros,
    entry: {
      dim: 'destination', tariff: tariff.name, tariffStart: startIso, number, prefix: prefixRow.prefix,
      peak: c.peak, callStartMicros: c.callStartMicros, connectMicros: c.connectMicros,
      perMinuteMicros: c.perMinuteMicros, minimumMicros: c.minimumMicros,
      billedSeconds: c.billedSeconds, minutes: c.minutes, costMicros: c.costMicros,
    },
  };
}

/**
 * Validate an `Organisation.rateHistory` ([{ name, startDate }]) on assignment:
 * a sorted-by-startDate list, no duplicate startDates, and EVERY entry's name has
 * a rate card covering its startDate. Returns an error string, or null when valid
 * (null/[] history = untracked, allowed). Async — checks covering cards.
 */
export async function validateRateHistory(history, { RateCard = DefaultRateCard } = {}) {
  if (history == null) return null;
  if (!Array.isArray(history)) return 'rateHistory must be an array of { name, startDate }';
  let prev = -Infinity;
  const seen = new Set();
  for (let i = 0; i < history.length; i += 1) {
    const e = history[i];
    if (!e || typeof e.name !== 'string' || !e.name || e.startDate == null) {
      return `entry ${i}: { name, startDate } required`;
    }
    const t = new Date(e.startDate).valueOf();
    if (Number.isNaN(t)) return `entry ${i}: invalid startDate`;
    if (seen.has(t)) return `entry ${i}: duplicate startDate`;
    if (t < prev) return 'rateHistory must be sorted by startDate ascending';
    seen.add(t);
    prev = t;
    // eslint-disable-next-line no-await-in-loop
    const card = await resolveRateCard(e.name, new Date(e.startDate), { RateCard });
    if (!card) return `entry ${i}: no rate card "${e.name}" covers ${e.startDate}`;
  }
  return null;
}

/**
 * The org's assigned rate-name at `billedAt`: the `rateHistory` entry with the
 * greatest `startDate <= billedAt`. Returns null when untracked / not-yet-assigned.
 *
 * @param {object} org      Organisation (uses `rateHistory` [{name,startDate}])
 * @param {Date}   billedAt
 * @returns {string|null}
 */
export function resolveOrgRateName(org, billedAt) {
  const history = Array.isArray(org?.rateHistory) ? org.rateHistory : [];
  const at = billedAt instanceof Date ? billedAt.valueOf() : new Date(billedAt).valueOf();
  let best = null;
  let bestStart = -Infinity;
  for (const entry of history) {
    if (!entry?.name || entry.startDate == null) continue;
    const start = new Date(entry.startDate).valueOf();
    if (start <= at && start >= bestStart) {
      bestStart = start;
      best = entry.name;
    }
  }
  return best;
}

/**
 * The RateCard for `name` effective at `billedAt`: stored interval is
 * [startDate, endDate) with a null endDate open until a later same-name card
 * supersedes. Non-overlap is DB-enforced, so at most one card matches.
 *
 * @returns {Promise<RateCard|null>}
 */
export async function resolveRateCard(name, billedAt, { RateCard = DefaultRateCard, Op } = {}) {
  if (!name) return null;
  const op = Op || RateCard.sequelize.Sequelize.Op;
  const at = billedAt instanceof Date ? billedAt : new Date(billedAt);
  return RateCard.findOne({
    where: {
      name,
      startDate: { [op.lte]: at },
      [op.or]: [{ endDate: null }, { endDate: { [op.gt]: at } }],
    },
    order: [['startDate', 'DESC']],
  });
}

/**
 * Canonical billing instant for a row: the interaction START. Voice/worker rows
 * resolve it from their Call (`startedAt`, falling back createdAt → row.created_at,
 * never dereferencing a null startedAt); text rows use the `metadata.startedAt`
 * anchor. Frozen once set on the row.
 *
 * @returns {Promise<Date>}
 */
export async function resolveBilledAt(row, { Call = DefaultCall } = {}) {
  if (row.billedAt) return row.billedAt;
  if (row.callId) {
    const call = await Call.findByPk(row.callId, { attributes: ['startedAt', 'createdAt'] });
    if (call) return call.startedAt || call.createdAt || row.createdAt || new Date();
  }
  const anchor = row.metadata?.startedAt;
  if (anchor) return new Date(anchor);
  return row.createdAt || new Date();
}

/**
 * Apply a row's frozen cost to its organisation's balance, idempotently.
 *
 * In ONE atomic statement: `balance -= (costMicros - appliedCostMicros)`; then set
 * `appliedCostMicros = costMicros`. Convergent — a reflush with a recomputed cost
 * applies only the difference, and re-running with no change is a no-op. Skipped
 * when the balance is untracked (null) or the row has no cost (unmatched/errored).
 *
 * @returns {Promise<void>}
 */
export async function settle(row, org, { transaction } = {}) {
  if (!org || org.balance === null || org.balance === undefined) return null; // untracked
  if (row.costMicros === null || row.costMicros === undefined) return null;   // nothing to apply
  const previous = Number(org.balance) || 0;
  const applied = Number(row.appliedCostMicros) || 0;
  const cost = Number(row.costMicros) || 0;
  const delta = cost - applied;
  if (delta !== 0) {
    // Atomic, not read-then-save: SQL `balance = balance - :by` regardless of the
    // in-memory value, so concurrent settles on the same org never lose a write.
    await org.decrement('balance', { by: delta, transaction });
  }
  if (applied !== cost) {
    await row.update({ appliedCostMicros: cost }, { transaction });
  }
  // The balance movement, for edge-triggered balance callbacks. `previous` is the
  // in-memory pre-settle value (best-effort under concurrency — see balance-callback).
  return { previous, next: previous - delta };
}

/**
 * Cost ONE usage row and settle it — idempotent and never-throw.
 *
 * 1. resolve `billedAt`; resolve the org's rate-name @billedAt; resolve the
 *    RateCard effective @billedAt.
 * 2. additive-resolve → costMicros + per-line breakdown (stamped in metadata for
 *    `/usage` itemisation).
 * 3. stamp billedAt/costMicros/currency/rateName/rateCardStart/costStatus; on a
 *    resolver throw → costStatus='errored', costMicros untouched (the quantity is
 *    never rolled back — costing is isolated from metering).
 * 4. settle() against Organisation.balance.
 *
 * @param {UsageRecord} row a finalised usage row (instance)
 * @param {object} [deps] injectable models (tests)
 * @returns {Promise<UsageRecord|null>} the row, or null if it could not be loaded
 */
export async function costUsageRow(row, {
  UsageRecord = DefaultUsageRecord,
  RateCard = DefaultRateCard,
  Organisation = DefaultOrganisation,
  User = DefaultUser,
  Call = DefaultCall,
  Tariff = DefaultTariff,
  TariffPrefix = DefaultTariffPrefix,
  log = defaultLogger,
} = {}) {
  if (!row) return null;
  try {
    const billedAt = await resolveBilledAt(row, { Call });

    const org = row.organisationId
      ? await Organisation.findByPk(row.organisationId)
      : null;
    // Per-user rate override (Phase 5): the user's own rateHistory wins when it
    // covers billedAt; otherwise fall back to the organisation's rate. The balance
    // settled is still the ORG's — per-user pricing, org wallet.
    const user = row.userId
      ? await User.findByPk(row.userId, { attributes: ['rateHistory'] }).catch(() => null)
      : null;
    const rateName = (user && resolveOrgRateName(user, billedAt)) || resolveOrgRateName(org, billedAt);
    const card = rateName ? await resolveRateCard(rateName, billedAt, { RateCard }) : null;

    if (!card) {
      // No assigned / covering card — record the anchor + outcome, leave cost null.
      await row.update({ billedAt, costStatus: 'no_rate' });
      return row;
    }

    // Exact-dimension cost (sync) + the additive destination/carrier cost (async
    // tariff longest-prefix match). A row with only a destination match still costs.
    const base = resolveRowCost(row, card);
    const dest = await resolveDestinationCost(row, card, billedAt, { Tariff, TariffPrefix });
    let costMicros = base.costMicros;
    let status = base.status;
    const breakdown = [...base.breakdown];
    if (dest) {
      costMicros = (costMicros ?? 0) + dest.costMicros;
      breakdown.push(dest.entry);
      status = 'matched';
    }
    await row.update({
      billedAt,
      costMicros,
      currency: card.currency || 'gbp',
      rateName: card.name,
      rateCardStart: card.startDate,
      costStatus: status,
      metadata: { ...(row.metadata || {}), costBreakdown: breakdown },
    });

    if (org) {
      const moved = await settle(row, org);
      // Edge-triggered balanceLow / balanceNegative callbacks (never-throw).
      if (moved) await maybeFireBalanceCallbacks(org, moved.previous, moved.next, { log });
    }
    return row;
  } catch (err) {
    // Never let a costing failure surface — flag for the sweep to retry, and
    // leave the metered quantity intact.
    log.error(err, 'costUsageRow failed; flagging errored');
    try {
      await row.update({ costStatus: 'errored' });
    } catch (err2) {
      log.error(err2, 'costUsageRow: failed to flag errored');
    }
    return row;
  }
}

/**
 * Reconciliation sweep — cost every finalised row not yet settled to a price:
 * never-costed rows (`costMicros IS NULL`, incl. `no_rate`/`no_line`) and rows
 * flagged for retry (`errored`). This is THREE tools in one:
 *  - **backfill** historical rows from before costing went live;
 *  - **retry** transient resolver failures;
 *  - **re-cost-on-correction** — a row left `no_rate` (org had no covering card
 *    at the time) is valued once a covering / superseding card is assigned.
 *
 * `matched` rows are NOT re-costed — their cost is frozen (cost-at-write). settle
 * is convergent, so running this repeatedly never double-applies. Bounded by
 * `limit`; call in a loop (or nightly) until `scanned < limit`.
 *
 * @returns {Promise<{ scanned: number, costed: number }>}
 */
export async function sweepUncostedRows({
  UsageRecord = DefaultUsageRecord,
  limit = 500,
  log = defaultLogger,
} = {}) {
  const { Op } = UsageRecord.sequelize.Sequelize;
  const rows = await UsageRecord.findAll({
    where: {
      finalised: true,
      [Op.or]: [
        { costMicros: null },
        { costStatus: { [Op.in]: ['no_rate', 'errored'] } },
      ],
    },
    order: [['id', 'ASC']],
    limit,
  });
  let costed = 0;
  for (const row of rows) {
    await costUsageRow(row, { log });
    if (row.costStatus === 'matched') costed += 1;
  }
  if (rows.length) log.info({ scanned: rows.length, costed }, 'rates sweep: costed uncosted/errored rows');
  return { scanned: rows.length, costed };
}

export default costUsageRow;
