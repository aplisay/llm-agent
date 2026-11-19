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
 *         ever NARROW (a) and (b), never widen them;
 *      d. for an organisation with the phone system, its own outbound policy
 *         (lib/outbound-policy.js): destination classes, hours, outside calls
 *         in progress and started a minute, and spend a day and a month, each
 *         no wider than its brand's ceiling. Every path inherits it: phones,
 *         agent transfers and the originate API.
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
  Extension as DefaultExtension,
  DirectoryEntry as DefaultDirectoryEntry,
  Call as DefaultCall,
  Brand as DefaultBrand,
  OutboundEvent as DefaultOutboundEvent,
  Op,
} from './database.js';
import { resolveEffectiveRateCard } from './rates.js';
import { phoneSystemReady, hasCapability } from './capabilities.js';
import { presentAttributes } from './schema-guards.js';
import { brandsReady } from './brands.js';
import {
  ceilingFor, effectivePolicy, checkDestination, checkLimits, classifyDestination, periodsAt, outboundPolicyReady,
  LIMIT_CODES, POLICY_CODES, DEFAULT_TIME_ZONE,
} from './outbound-policy.js';
import { outboundSpendSince } from './outbound-spend.js';
import { sendOutboundNotice } from './outbound-notice.js';
import defaultLogger from './logger.js';
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
 * Is this dialled string the number of a live extension of the organisation's
 * own phone system (any type but `connection`)? Those digits ring something
 * only inside a phone system call, which call control places. On any other
 * path they would go out to the customer's own PBX and ring the wrong thing,
 * so they are refused and the agent falls through to its next target.
 *
 * @returns {Promise<object|null>} the extension, or null
 */
export async function internalExtensionDialled({ organisationId, dialled }, {
  Extension = DefaultExtension, DirectoryEntry = DefaultDirectoryEntry,
} = {}) {
  const digits = String(dialled ?? '').replace(/[\s-]/g, '');
  if (!organisationId || !/^[0-9]{1,8}$/.test(digits)) return null;
  // Without the phone system schema there is no extensions table to read.
  if (!phoneSystemReady()) return null;
  const extension = await Extension.findOne({
    where: { organisationId, number: digits, deletedAt: null, type: { [Op.ne]: 'connection' } },
    attributes: ['id', 'number', 'type', 'entryId'],
  });
  if (!extension) return null;
  if (extension.entryId) {
    const entry = await DirectoryEntry.findOne({ where: { id: extension.entryId, deletedAt: null }, attributes: ['id'] });
    if (!entry) return null;
  }
  return extension;
}

// A call row left `live` by a lost end write would otherwise hold a slot for good.
export const IN_PROGRESS_MAX_AGE_MS = 4 * 60 * 60 * 1000;
// An allowed decision holds a place in progress until its call has a row, or
// for this long if none comes (a leg that rang out, or was never placed).
export const DECISION_HOLDS_PLACE_MS = 2 * 60 * 1000;
export const KEEP_OUTBOUND_EVENTS_DAYS = 40;

/** The full ceiling of a brand (lib/outbound-policy.js). A brand with none, or none found, gets the platform's. */
export async function brandCeiling(brandId, { Brand = DefaultBrand } = {}) {
  if (!brandId || !brandsReady() || !outboundPolicyReady()) return ceilingFor(null);
  const row = await Brand.findByPk(brandId, { attributes: ['id', 'outboundCeiling'] });
  return ceilingFor(row?.outboundCeiling);
}

/**
 * What the organisation's outbound limits count right now. Only legs on our
 * chargeable trunks count, as only those pass through the policy.
 *
 * A call is in progress from the decision that allowed it. Until its call has
 * a row (a phone system leg has one once the network answers it), the allowed
 * decision holds the place, for up to {@link DECISION_HOLDS_PLACE_MS}. A
 * decision is matched to its row by trunk and by the last nine digits of the
 * number called. After that the live row holds the place.
 */
export async function outboundUsage({
  organisationId, at = new Date(), timeZone = DEFAULT_TIME_ZONE, transaction,
}, {
  Call = DefaultCall, OutboundEvent = DefaultOutboundEvent, spendSource = outboundSpendSince, UsageRecord,
} = {}) {
  const periods = periodsAt(at, timeZone);
  const [live] = await Call.sequelize.query(
    `SELECT COUNT(*)::int AS n FROM calls c JOIN trunks t ON t.id = c.outbound_trunk_id
      WHERE c.organisation_id = :organisationId AND c.live = true AND c.ended_at IS NULL
        AND t.chargeable = true AND c.created_at > :since`,
    {
      replacements: { organisationId, since: new Date(at.valueOf() - IN_PROGRESS_MAX_AGE_MS) },
      type: Call.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  // The 5 second margin allows for the clocks of the servers that write the two rows.
  const [waiting] = await Call.sequelize.query(
    `SELECT COUNT(*)::int AS n FROM outbound_events e
      WHERE e.organisation_id = :organisationId AND e.allowed AND e.at > :holdSince AND e.at <= :at
        AND NOT EXISTS (
          SELECT 1 FROM calls c
           WHERE c.organisation_id = e.organisation_id AND c.outbound_trunk_id = e.trunk_id
             AND c.created_at >= e.at - interval '5 seconds'
             AND right(regexp_replace(c.called_id, '\\D', '', 'g'), 9) = right(regexp_replace(e.destination, '\\D', '', 'g'), 9))`,
    {
      replacements: { organisationId, at, holdSince: new Date(at.valueOf() - DECISION_HOLDS_PLACE_MS) },
      type: Call.sequelize.QueryTypes.SELECT,
      transaction,
    },
  );
  const callsLastMinute = await OutboundEvent.count({
    where: { organisationId, allowed: true, at: { [Op.gt]: new Date(at.valueOf() - 60_000), [Op.lte]: at } },
    transaction,
  });
  const spendModels = UsageRecord ? { UsageRecord } : {};
  const spendToday = await spendSource({ organisationId, since: periods.dayStart, until: at, transaction }, spendModels);
  const spendMonth = await spendSource({ organisationId, since: periods.monthStart, until: at, transaction }, spendModels);
  return {
    callsInProgress: Number(live?.n ?? NaN) + Number(waiting?.n ?? NaN),
    callsLastMinute,
    spendToday,
    spendMonth,
    periods,
  };
}

/** Today's refusals by the policy, by code, for the organisation's notice. */
export async function outboundNotices({ organisationId, since }, { OutboundEvent = DefaultOutboundEvent } = {}) {
  const rows = await OutboundEvent.sequelize.query(
    `SELECT code, COUNT(*)::int AS count, MIN(at) AS "firstAt", MAX(at) AS "lastAt" FROM outbound_events
      WHERE organisation_id = :organisationId AND allowed = false AND at >= :since
      GROUP BY code ORDER BY MIN(at)`,
    { replacements: { organisationId, since }, type: OutboundEvent.sequelize.QueryTypes.SELECT },
  );
  return rows.map((row) => ({ ...row, limit: LIMIT_CODES.has(row.code) }));
}

/**
 * Take the organisation's notice for the day on this refusal's row, unless
 * another row has it. The unique index on (organisation, day) settles a race
 * between servers. True when this row took it.
 */
async function claimNotice({ organisationId, rowId, day }, { OutboundEvent = DefaultOutboundEvent } = {}) {
  try {
    const [rows] = await OutboundEvent.sequelize.query(
      `UPDATE outbound_events SET notice_day = :day
        WHERE id = :rowId AND NOT EXISTS (
          SELECT 1 FROM outbound_events WHERE organisation_id = :organisationId AND notice_day = :day)
        RETURNING id`,
      { replacements: { organisationId, rowId, day } },
    );
    return rows.length === 1;
  } catch (err) {
    if (err?.name === 'SequelizeUniqueConstraintError') return false;
    throw err;
  }
}

/** Send the day's notice. If the send fails the claim is given back, so the next refusal by a limit sends it. */
async function sendNotice({ organisation, refusal, day, at, rowId }, models) {
  const { OutboundEvent = DefaultOutboundEvent, log = defaultLogger, notify = sendOutboundNotice } = models;
  let sent;
  try {
    sent = await notify(organisation, { ...refusal, day, at }, { log });
  } catch {
    sent = false;
  }
  if (sent !== false) return;
  await OutboundEvent.update({ noticeDay: null }, { where: { id: rowId } })
    .catch((err) => log.warn({ err: err?.message, organisationId: organisation.id }, 'outbound notice: could not give back the day'));
}

/**
 * Step (d): the organisation's own outbound policy, for a leg on one of our
 * chargeable trunks. Null when the organisation does not have the phone
 * system, so the policy does not apply. Otherwise it records the decision and
 * answers `{ refusal }` or `{ allowed: true }`. Anything it cannot read or
 * write is a refusal: it fails closed.
 */
export async function applyOrganisationPolicy({
  organisationId, destination, trunkId = null, at = new Date(),
}, models = {}) {
  const { Organisation = DefaultOrganisation, log = defaultLogger, notify = sendOutboundNotice } = models;
  const unavailable = (err) => {
    log.error({ err: err?.message, organisationId }, 'outbound policy could not decide, refusing the call');
    return {
      refusal: {
        code: POLICY_CODES.unavailable,
        reason: 'the organisation\'s outbound policy could not be read, so the call is refused',
      },
    };
  };
  if (!organisationId || !phoneSystemReady()) return null;
  let organisation;
  try {
    organisation = await Organisation.findByPk(organisationId, {
      attributes: presentAttributes(Organisation, ['id', 'capabilities', 'outboundPolicy', 'brand', 'billingConfig']),
    });
  } catch (err) {
    return unavailable(err);
  }
  if (!hasCapability(organisation, 'phoneSystem')) return null;
  if (!outboundPolicyReady()) {
    return {
      refusal: {
        code: POLICY_CODES.notReady,
        reason: 'the outbound policy needs a database upgrade (tools/agent-admin.js upgrade-db), so the call is refused',
      },
    };
  }
  let decided;
  try {
    const effective = effectivePolicy(organisation.outboundPolicy, await brandCeiling(organisation.brand, models));
    const timeZone = effective.hours?.timeZone || DEFAULT_TIME_ZONE;
    const { sequelize } = models.Call || DefaultCall;
    const { OutboundEvent = DefaultOutboundEvent } = models;
    // The count and the write of the decision are one step for the organisation,
    // so calls decided at the same moment cannot all pass a limit.
    decided = await sequelize.transaction(async (transaction) => {
      await sequelize.query('SELECT pg_advisory_xact_lock(hashtext(:space), hashtext(:organisationId))', {
        replacements: { space: 'outbound_policy', organisationId }, transaction,
      });
      let refusal = checkDestination(effective, { destination, at });
      let day = null;
      if (!refusal) {
        const usage = await outboundUsage({ organisationId, at, timeZone, transaction }, models);
        refusal = checkLimits(effective, usage);
        day = usage.periods.day;
      }
      const row = await OutboundEvent.create({
        organisationId,
        at,
        allowed: !refusal,
        code: refusal?.code || 'ok',
        destinationClass: classifyDestination(destination),
        destination,
        trunkId,
      }, { transaction });
      return { refusal, day, rowId: row.id };
    });
  } catch (err) {
    return unavailable(err);
  }
  const { refusal, day, rowId } = decided;
  if (refusal && LIMIT_CODES.has(refusal.code) && day) {
    try {
      if (await claimNotice({ organisationId, rowId, day }, models)) {
        sendNotice({ organisation, refusal, day, at, rowId }, { ...models, log, notify }).catch(() => {});
      }
    } catch (err) {
      log.warn({ err: err?.message, organisationId }, 'outbound notice: could not take the day');
    }
  }
  return refusal ? { refusal } : { allowed: true };
}

/** Delete decisions older than {@link KEEP_OUTBOUND_EVENTS_DAYS}. Run by the daily purge. */
export async function purgeOutboundEvents({ before = new Date(Date.now() - KEEP_OUTBOUND_EVENTS_DAYS * 86_400_000) } = {}, {
  OutboundEvent = DefaultOutboundEvent,
} = {}) {
  if (!outboundPolicyReady()) return 0;
  return OutboundEvent.destroy({ where: { at: { [Op.lt]: before } } });
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

  if (await internalExtensionDialled({ organisationId, dialled }, models)) {
    return {
      allowed: false, code: 'internal_extension_not_reachable', chargeable: false, trunkId: null, destination: null,
      reason: `${dialled} is an extension of the organisation's phone system, which this call cannot ring`,
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

  // (d) the organisation's own outbound policy, last because it counts and records.
  const policy = await applyOrganisationPolicy({ organisationId, destination, trunkId, at }, models);
  if (policy?.refusal) {
    return { allowed: false, chargeable: true, trunkId, destination, ...policy.refusal };
  }

  return {
    allowed: true, code: 'ok', chargeable: true, trunkId, destination, reason: null,
    tariff: rating.tariff, prefix: rating.prefix,
    srtp: trunkAllowsSrtp(trunk),
  };
}

export default authoriseOutboundDestination;
