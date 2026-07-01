/**
 * Destination tariffs (Phase D — telco-style destination-number call charging).
 *
 * When an org originates a call (originate API) or bridge-transfers OUT on a trunk
 * it does NOT own, we carry the carrier cost and must bill it through. The charge
 * is a longest-prefix match on the NORMALISED international destination number
 * against a named, date-ranged **tariff** (a prefix deck), priced as a per-call
 * connect fee PLUS a per-minute rate (both micro-pence; either may be 0).
 *
 * Tariffs mirror {@link RateCard}: named, dated ([startDate, endDate) with a null
 * endDate open until a later same-name tariff supersedes), and IMMUTABLE once a
 * costed usage row references them (a price change is a NEW dated tariff). A rate
 * card links to a tariff by NAME via a `destination`-dimension line; the resolver
 * (lib/rates.js) loads the tariff effective @billedAt and longest-prefix-matches
 * the row's frozen normalised destination.
 *
 * This module is the env-independent core: normalisation, longest-prefix match,
 * temporal resolution, validation, and the referenced-immutability check.
 *
 * @module lib/tariffs
 */
import {
  Tariff as DefaultTariff,
  TariffPrefix as DefaultTariffPrefix,
  UsageRecord as DefaultUsageRecord,
} from './database.js';

/**
 * ISO-3166 alpha-2 → E.164 country calling code, used to expand a LOCAL-format
 * dialled number (a leading national-trunk `0`) to international digits. Default
 * home country is GB; extend as Aplisay onboards more. An unknown country means a
 * local `0…` number cannot be expanded (treated as un-chargeable, returns null).
 */
export const CALLING_CODES = {
  GB: '44', IE: '353', FR: '33', DE: '49', ES: '34', IT: '39', NL: '31', BE: '32',
  PT: '351', SE: '46', NO: '47', DK: '45', FI: '358', PL: '48', CH: '41', AT: '43',
  US: '1', CA: '1', AU: '61', NZ: '64', ZA: '27', IN: '91', SG: '65', HK: '852', AE: '971',
};

/** The E.164 calling code for an ISO-3166 alpha-2 country, or null if unknown. */
export function callingCodeFor(country) {
  return CALLING_CODES[String(country || '').toUpperCase()] || null;
}

/**
 * Normalise a dialled destination to international digits-only (no `+`) — the form
 * tariff prefixes are stored in (e.g. `447970…`). Handles `+44…` / `0044…` / `44…`
 * (already international) and national `0…` (expanded with the home country's
 * calling code). Returns null for un-chargeable inputs: the `WebRTC` sentinel,
 * internal test ids (`00000`), or anything not a plausible 6–15 digit E.164 number.
 *
 * @param {string} raw            the dialled number / calledId
 * @param {object} [opts]
 * @param {string} [opts.defaultCountry='GB'] ISO-3166 alpha-2 home country
 * @returns {string|null} international digits, or null if not chargeable
 */
export function normaliseDestination(raw, { defaultCountry = 'GB' } = {}) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  const hasPlus = /^\+/.test(s);
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;

  let intl;
  if (hasPlus) {
    intl = digits;                 // +447970… → 447970…
  } else if (digits.startsWith('00')) {
    intl = digits.slice(2);        // 00447970… (intl access) → 447970…
  } else if (digits.startsWith('0')) {
    const cc = callingCodeFor(defaultCountry);
    if (!cc) return null;          // can't expand a national number without a home code
    intl = cc + digits.slice(1);   // 07970… → 447970…
  } else {
    intl = digits;                 // already international (447970…)
  }
  return /^\d{6,15}$/.test(intl) ? intl : null;
}

/**
 * Longest-prefix match over an in-memory deck: the row whose `prefix` is the
 * longest leading substring of `number`. Prefixes are unique within a tariff so
 * there are no ties. Returns the row, or null when nothing matches.
 *
 * @param {string} number          normalised international digits
 * @param {Array<{prefix:string}>} prefixRows
 */
export function longestPrefixMatch(number, prefixRows = []) {
  if (!number) return null;
  let best = null;
  for (const row of prefixRows) {
    const p = row?.prefix;
    if (p && number.startsWith(p) && (!best || p.length > String(best.prefix).length)) best = row;
  }
  return best;
}

/**
 * Longest-prefix match against a tariff's deck IN THE DB — generates the ≤15
 * candidate prefixes of `number` and asks Postgres for the longest stored one
 * (indexed equality IN + order by prefix length DESC). Scales to large decks.
 *
 * @returns {Promise<TariffPrefix|null>} the matched prefix row (connect/perMinute)
 */
export async function matchTariffPrefix(tariffId, number, { TariffPrefix = DefaultTariffPrefix } = {}) {
  if (tariffId == null || !number) return null;
  const candidates = [];
  for (let i = 1; i <= number.length; i += 1) candidates.push(number.slice(0, i));
  const { Sequelize } = TariffPrefix.sequelize;
  return TariffPrefix.findOne({
    where: { tariffId, prefix: candidates },
    order: [[Sequelize.fn('length', Sequelize.col('prefix')), 'DESC']],
  });
}

/**
 * The Tariff for `name` effective at `billedAt`: stored interval is
 * [startDate, endDate) with a null endDate open until a later same-name tariff
 * supersedes. Non-overlap is DB-enforced, so at most one matches. Mirrors
 * resolveRateCard.
 *
 * @returns {Promise<Tariff|null>}
 */
export async function resolveTariff(name, billedAt, { Tariff = DefaultTariff, Op } = {}) {
  if (!name) return null;
  const op = Op || Tariff.sequelize.Sequelize.Op;
  const at = billedAt instanceof Date ? billedAt : new Date(billedAt);
  return Tariff.findOne({
    where: {
      name,
      startDate: { [op.lte]: at },
      [op.or]: [{ endDate: null }, { endDate: { [op.gt]: at } }],
    },
    order: [['startDate', 'DESC']],
  });
}

/**
 * The destination charge for a matched prefix over `minutes` of carried call:
 * a one-time connect fee plus a per-minute rate (micro-pence). Either may be 0.
 *
 * @param {{connectMicros:number, perMinuteMicros:number}|null} prefixRow
 * @param {number} minutes
 * @returns {number} micro-pence
 */
export function destinationCostMicros(prefixRow, minutes) {
  if (!prefixRow) return 0;
  const connect = Number(prefixRow.connectMicros) || 0;
  const perMin = Number(prefixRow.perMinuteMicros) || 0;
  return Math.round(connect + perMin * (Number(minutes) || 0));
}

/** Validate a tariff prefix deck (array of { prefix, connectMicros, perMinuteMicros }). */
export function validatePrefixes(prefixes) {
  if (prefixes == null) return null;
  if (!Array.isArray(prefixes)) return 'prefixes must be an array';
  const seen = new Set();
  for (let i = 0; i < prefixes.length; i += 1) {
    const p = prefixes[i];
    if (!p || typeof p !== 'object') return `prefix ${i}: must be an object`;
    if (typeof p.prefix !== 'string' || !/^\d{1,15}$/.test(p.prefix)) return `prefix ${i}: prefix must be 1-15 digits`;
    if (seen.has(p.prefix)) return `prefix ${i}: duplicate prefix ${p.prefix}`;
    seen.add(p.prefix);
    if (!Number.isFinite(Number(p.connectMicros)) || Number(p.connectMicros) < 0) return `prefix ${i}: connectMicros must be a number >= 0`;
    if (!Number.isFinite(Number(p.perMinuteMicros)) || Number(p.perMinuteMicros) < 0) return `prefix ${i}: perMinuteMicros must be a number >= 0`;
  }
  return null;
}

/** Validate a tariff create/update payload (header + optional prefix deck). */
export function validateTariffInput({ name, startDate, defaultCountry, prefixes } = {}) {
  if (!name || typeof name !== 'string') return 'name is required';
  if (!startDate) return 'startDate is required';
  if (defaultCountry != null && !callingCodeFor(defaultCountry)) {
    return `defaultCountry "${defaultCountry}" has no known calling code`;
  }
  return validatePrefixes(prefixes);
}

/**
 * Is this tariff version frozen? True once any costed usage row's cost breakdown
 * names it (by tariff name + tariffStart) — the destination-dimension analogue of
 * RateCard's referenced check. Editing such a tariff would retroactively move
 * historical cost, so the CRUD layer rejects it (supersede instead). Uses a JSONB
 * containment (`@>`) match against metadata.costBreakdown.
 *
 * @returns {Promise<boolean>}
 */
export async function isTariffReferenced(tariff, { UsageRecord = DefaultUsageRecord } = {}) {
  if (!tariff) return false;
  const { Op } = UsageRecord.sequelize.Sequelize;
  const start = tariff.startDate instanceof Date ? tariff.startDate : new Date(tariff.startDate);
  const found = await UsageRecord.findOne({
    where: {
      metadata: { [Op.contains]: { costBreakdown: [{ tariff: tariff.name, tariffStart: start.toISOString() }] } },
    },
    attributes: ['id'],
  });
  return Boolean(found);
}

export default {
  CALLING_CODES,
  callingCodeFor,
  normaliseDestination,
  longestPrefixMatch,
  matchTariffPrefix,
  resolveTariff,
  destinationCostMicros,
  validatePrefixes,
  validateTariffInput,
  isTariffReferenced,
};
