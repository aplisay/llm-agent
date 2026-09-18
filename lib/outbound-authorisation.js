/**
 * Outbound destination authorisation — the single policy that decides whether a
 * dialled number may be carried, for EVERY worker technology and every path that
 * puts a call out of the platform (the originate API, blind/consultative
 * transfers, WebRTC bridge legs, fallback numbers).
 *
 * Two different trust models, keyed on WHOSE minutes are at risk:
 *
 *  - **Not our carrier** (a registration B2BUA to the customer's own PBX, a BYO
 *    trunk, no outbound trunk at all): the agent author's `options.outboundCallFilter`
 *    is authoritative, defaulting to UK geographic/mobile. This is the historical
 *    behaviour and is preserved exactly — the fraud risk is the customer's own.
 *
 *  - **Our chargeable public trunk** (`Trunk.chargeable`, the carrier minutes WE
 *    pay for): the agent-supplied filter is a tenant-controlled input and therefore
 *    CANNOT be the authority — an agent author (or a prompt-injected LLM working
 *    within a wide filter) could otherwise dial premium-rate or international
 *    revenue-share destinations at our cost. On these trunks a destination must
 *    satisfy ALL of:
 *      a. `Trunk.outboundCallFilter` — the operator's per-trunk allow pattern,
 *         applied to the CANONICAL `+E.164` form, defaulting to UK geographic/
 *         mobile ({@link DEFAULT_TRUNK_OUTBOUND_FILTER}) when unset;
 *      b. **rateable** — the destination longest-prefix-matches a prefix in the
 *         tariff named by the destination line of the rate card in force for this
 *         org/user (lib/rates.js + lib/tariffs.js). If we cannot price the call we
 *         will not carry it;
 *      c. the agent's own `options.outboundCallFilter` when set — which can only
 *         ever NARROW (a) and (b), never widen them.
 *
 * The policy lives server-side because only the API server can see `Trunk`,
 * `RateCard` and `Tariff`. Workers do not re-implement it: they call
 * `POST /api/agent-db/outbound-authorisation` (see that path) and fail CLOSED.
 *
 * @module lib/outbound-authorisation
 */
import {
  Trunk as DefaultTrunk,
  Organisation as DefaultOrganisation,
  User as DefaultUser,
  RateCard as DefaultRateCard,
  Tariff as DefaultTariff,
  TariffPrefix as DefaultTariffPrefix,
} from './database.js';
import { resolveEffectiveRateCard } from './rates.js';
import { normaliseDestination, resolveTariff, matchTariffPrefix } from './tariffs.js';
import {
  DEFAULT_AGENT_OUTBOUND_FILTER,
  DEFAULT_TRUNK_OUTBOUND_FILTER,
  filterAllows,
} from './outbound-filter.js';

export {
  DEFAULT_AGENT_OUTBOUND_FILTER,
  DEFAULT_TRUNK_OUTBOUND_FILTER,
  MAX_FILTER_LENGTH,
  filterAllows,
  validateOutboundCallFilter,
} from './outbound-filter.js';

/**
 * Canonical `+E.164` form of a dialled destination, or null when it is not a
 * plausible number (the `WebRTC` sentinel, an internal test id, junk). Wraps
 * {@link normaliseDestination} — the SAME normalisation the billing path freezes
 * onto the usage row, so "what we authorise" and "what we rate" cannot diverge.
 *
 * @param {string} raw
 * @param {object} [opts]
 * @param {string} [opts.defaultCountry='GB'] home country for national `0…` forms
 * @returns {string|null}
 */
export function canonicaliseDestination(raw, { defaultCountry = 'GB' } = {}) {
  const intl = normaliseDestination(raw, { defaultCountry });
  return intl ? `+${intl}` : null;
}

/**
 * Resolve the trunk an outbound leg will egress on, and hence whether WE carry
 * its cost.
 *
 * A registration-originated leg goes out over the customer's own B2BUA (their
 * PBX, never our carrier) and is therefore never chargeable — mirroring the
 * billing gate in `telephony.ts` / `call_session.py` that declines to stamp
 * `Call.outboundTrunkId` in that case.
 *
 * Otherwise we consider, in order, the trunk id the caller states for the leg,
 * the platform's configured public outbound trunk (`APLISAY_OUTBOUND_TRUNK_ID` —
 * the same env the workers stamp billing from), and the caller number's own
 * `aplisayId` trunk. The FIRST chargeable trunk found wins; if none is chargeable
 * the first resolvable trunk is returned for context.
 *
 * @returns {Promise<{trunk: object|null, chargeable: boolean}>}
 */
/** A trunk owned by a phone registration (`trunks.flags.provider === 'registration'`). */
export function isRegistrationTrunk(trunk) {
  const flags = trunk?.flags;
  return !!flags && typeof flags === 'object' && flags.provider === 'registration' && typeof flags.registrationId === 'string' && !!flags.registrationId;
}

export async function resolveEgressTrunk({
  outboundTrunkId,
  aplisayId,
  registrationOriginated,
} = {}, { Trunk = DefaultTrunk, env = process.env } = {}) {
  if (registrationOriginated) return { trunk: null, chargeable: false };

  // A number on a REGISTRATION trunk (schema 62) egresses through the
  // customer's own registration B2BUA, never our carrier, whatever the
  // platform default trunk says. Decided before the candidate walk because
  // that walk tries the chargeable default ahead of the caller's own trunk.
  if (typeof aplisayId === 'string' && aplisayId.trim()) {
    const own = await Trunk.findByPk(aplisayId.trim());
    if (own && isRegistrationTrunk(own)) return { trunk: own, chargeable: false };
  }

  const candidates = [outboundTrunkId, env.APLISAY_OUTBOUND_TRUNK_ID, aplisayId]
    .filter((id) => typeof id === 'string' && id.trim())
    .map((id) => id.trim());
  const seen = new Set();
  let first = null;
  for (const id of candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    // eslint-disable-next-line no-await-in-loop
    const trunk = await Trunk.findByPk(id);
    if (!trunk) continue;
    if (trunk.chargeable) return { trunk, chargeable: true };
    if (!first) first = trunk;
  }
  return { trunk: first, chargeable: false };
}

/**
 * Does this trunk accept encrypted media (SDES SRTP / `RTP/SAVP`) on legs we
 * originate onto it? Carried in `Trunk.flags.srtp`.
 *
 * Only the OFFER is affected. A trunk that offers us SAVP is still answered in
 * kind, and `SIPBRIDGE_SRTP_REQUIRED` still overrides everything.
 *
 * @param {object|null} trunk a `Trunk` row (or anything carrying `.flags`)
 * @returns {boolean} true when SRTP may be offered on this trunk
 */
export function trunkAllowsSrtp(trunk) {
  const flags = trunk?.flags;
  if (!flags || typeof flags !== 'object') return true;
  return flags.srtp !== false;
}

/**
 * Can we price a call to this destination for this org/user? Mirrors the costing
 * resolution in `costUsageRow` exactly — per-user rate override first, then the
 * organisation's, then the covering rate card, its `destination` line, the named
 * tariff effective now, and finally a longest-prefix match on the destination —
 * so a number that authorises here is a number that will actually be charged.
 *
 * @returns {Promise<{rateable: boolean, reason?: string, rateName?: string,
 *                    tariff?: string, prefix?: string, destination?: string}>}
 */
export async function isDestinationRateable({ organisationId, userId, calledId, at = new Date() }, {
  Organisation = DefaultOrganisation, User = DefaultUser, RateCard = DefaultRateCard,
  Tariff = DefaultTariff, TariffPrefix = DefaultTariffPrefix,
} = {}) {
  const { rateName, card } = await resolveEffectiveRateCard(
    { organisationId, userId, at }, { Organisation, User, RateCard },
  );
  if (!rateName) return { rateable: false, reason: 'no rate assigned to this organisation' };
  if (!card) return { rateable: false, reason: `no rate card "${rateName}" in force`, rateName };

  const lines = Array.isArray(card?.detail?.lines) ? card.detail.lines : [];
  const destLine = lines.find((l) => l && l.dim === 'destination' && l.tariff);
  if (!destLine) {
    return { rateable: false, reason: `rate "${rateName}" prices no destinations`, rateName };
  }

  const tariff = await resolveTariff(destLine.tariff, at, { Tariff });
  if (!tariff) {
    return { rateable: false, reason: `no tariff "${destLine.tariff}" in force`, rateName };
  }

  // Normalise with the TARIFF's own home country, as the costing path does.
  const number = normaliseDestination(calledId, { defaultCountry: tariff.defaultCountry });
  if (!number) return { rateable: false, reason: 'destination is not a dialable number', rateName };

  const prefixRow = await matchTariffPrefix(tariff.id, number, { TariffPrefix });
  if (!prefixRow) {
    return {
      rateable: false,
      reason: `destination is not in tariff "${tariff.name}"`,
      rateName,
      tariff: tariff.name,
      destination: `+${number}`,
    };
  }
  return {
    rateable: true, rateName, tariff: tariff.name, prefix: prefixRow.prefix, destination: `+${number}`,
  };
}

/**
 * THE authorisation decision for one outbound destination. Every technology
 * routes through this (directly on the API server, or over
 * `/api/agent-db/outbound-authorisation` from a worker).
 *
 * @param {object}  params
 * @param {string}  params.calledId               the dialled destination, as dialled
 * @param {object}  [params.agentOptions]         the agent's `options` (reads `outboundCallFilter`)
 * @param {string}  [params.organisationId]       owning organisation (for rating)
 * @param {string}  [params.userId]               owning user (per-user rate override)
 * @param {string}  [params.aplisayId]            the caller number's trunk id
 * @param {string}  [params.outboundTrunkId]      explicit egress trunk id, when the caller knows it
 * @param {boolean} [params.registrationOriginated] leg egresses a customer B2BUA
 * @param {Date}    [params.at]                   decision instant (tests)
 * @returns {Promise<{allowed: boolean, code: string, reason: string|null,
 *                    chargeable: boolean, trunkId: string|null, destination: string|null,
 *                    tariff?: string, prefix?: string, srtp?: boolean}>}
 *          `srtp` is present on allowed decisions only: false when the egress
 *          trunk's `flags.srtp` forbids offering encrypted media (see
 *          {@link trunkAllowsSrtp}). Callers pass it to the handler so the
 *          worker can stamp the offer contract on the leg.
 */
export async function authoriseOutboundDestination({
  calledId,
  agentOptions,
  organisationId,
  userId,
  aplisayId,
  outboundTrunkId,
  registrationOriginated = false,
  at = new Date(),
} = {}, models = {}) {
  const agentFilter = agentOptions?.outboundCallFilter || null;
  const dialled = typeof calledId === 'string' ? calledId.trim() : '';

  if (!dialled) {
    return {
      allowed: false, code: 'invalid_destination', chargeable: false, trunkId: null, destination: null,
      reason: 'no destination number supplied',
    };
  }

  const { trunk, chargeable } = await resolveEgressTrunk(
    { outboundTrunkId, aplisayId, registrationOriginated }, models,
  );
  const trunkId = trunk?.id || null;

  // ---- Not our carrier: historical, tenant-authoritative behaviour ----
  if (!chargeable) {
    const pattern = agentFilter || DEFAULT_AGENT_OUTBOUND_FILTER;
    if (!filterAllows(pattern, dialled)) {
      return {
        allowed: false,
        code: agentFilter ? 'agent_filter' : 'default_filter',
        chargeable: false,
        trunkId,
        destination: canonicaliseDestination(dialled),
        reason: agentFilter
          ? `destination ${dialled} does not match the agent's outbound call filter pattern`
          : `destination ${dialled} is not a valid UK geographic or mobile number`,
      };
    }
    return {
      allowed: true, code: 'ok', chargeable: false, trunkId,
      destination: canonicaliseDestination(dialled), reason: null,
      srtp: trunkAllowsSrtp(trunk),
    };
  }

  // ---- Our chargeable public trunk: operator policy is authoritative ----
  const destination = canonicaliseDestination(dialled);
  if (!destination) {
    return {
      allowed: false, code: 'invalid_destination', chargeable: true, trunkId, destination: null,
      reason: `destination ${dialled} is not a dialable international number`,
    };
  }

  // (a) per-trunk operator allow pattern, on the canonical form.
  const trunkFilter = trunk?.outboundCallFilter || DEFAULT_TRUNK_OUTBOUND_FILTER;
  if (!filterAllows(trunkFilter, destination)) {
    return {
      allowed: false, code: 'trunk_filter', chargeable: true, trunkId, destination,
      reason: `destination ${destination} is not permitted on this outbound trunk`,
    };
  }

  // (b) must be rateable for this org — if we cannot charge it we do not carry it.
  const rating = await isDestinationRateable({ organisationId, userId, calledId: dialled, at }, models);
  if (!rating.rateable) {
    return {
      allowed: false, code: 'not_rateable', chargeable: true, trunkId, destination,
      reason: `destination ${destination} is not rated for this organisation (${rating.reason})`,
    };
  }

  // (c) the agent's own filter may narrow, never widen. Applied to the RAW dialled
  // string so existing agent patterns keep their existing meaning.
  if (agentFilter && !filterAllows(agentFilter, dialled)) {
    return {
      allowed: false, code: 'agent_filter', chargeable: true, trunkId, destination,
      reason: `destination ${dialled} does not match the agent's outbound call filter pattern`,
    };
  }

  return {
    allowed: true, code: 'ok', chargeable: true, trunkId, destination, reason: null,
    tariff: rating.tariff, prefix: rating.prefix,
    srtp: trunkAllowsSrtp(trunk),
  };
}

export default authoriseOutboundDestination;
