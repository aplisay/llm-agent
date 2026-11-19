/**
 * The place an allowed outside leg holds in its organisation's calls in
 * progress before the leg has a call row (lib/outbound-authorisation.js counts
 * them). Call control tells llm-agent when an outside leg was not answered or
 * could not be dialled, and that gives the place back at once.
 *
 * Kept apart from lib/outbound-authorisation.js so the phone system's call
 * records can use it without loading rating.
 *
 * @module lib/outbound-places
 */
import { OutboundEvent as DefaultOutboundEvent } from './database.js';
import { outboundPolicyReady } from './outbound-policy.js';
import defaultLogger from './logger.js';

// An allowed decision holds a place until its call has a row, until call
// control says the leg ended unanswered, or for this long if neither comes.
export const DECISION_HOLDS_PLACE_MS = 2 * 60 * 1000;
// Allows for the clocks of the servers that write the decision, the call row and the event.
export const CLOCK_MARGIN_MS = 5000;

// The kinds call control gives an outside leg: one rung for a call in, and a call out from a line.
const OUTSIDE_LEG_KINDS = new Set(['external', 'outside']);

/** The number of an outside leg that call control says was not answered or not dialled, or null. */
export function unansweredOutsideLeg(event) {
  const data = event?.data;
  if (!data || !OUTSIDE_LEG_KINDS.has(data.kind) || typeof data.number !== 'string') return null;
  if (event.type === 'leg_not_answered') return data.number;
  if (event.type === 'leg_skipped' && data.reason === 'dial_failed') return data.number;
  return null;
}

/**
 * Give back the place of the oldest allowed decision to this number that still
 * holds one. A decision is matched by the last nine digits of the number, as
 * its call row is. One event gives back one place, once.
 *
 * @returns {Promise<boolean>} true when a place was given back
 */
export async function releaseOutboundPlace({ organisationId, number, at = new Date(), eventId }, {
  OutboundEvent = DefaultOutboundEvent,
} = {}) {
  const digits = String(number ?? '').replace(/\D/g, '');
  if (!organisationId || !eventId || !digits || !outboundPolicyReady()) return false;
  try {
    const [rows] = await OutboundEvent.sequelize.query(
      `UPDATE outbound_events SET released_at = :at, released_by = :eventId
        WHERE id = (
          SELECT id FROM outbound_events
           WHERE organisation_id = :organisationId AND allowed AND released_at IS NULL
             AND at > :since AND at <= :until
             AND right(regexp_replace(destination, '\\D', '', 'g'), 9) = right(:digits, 9)
           ORDER BY at LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
      {
        replacements: {
          organisationId,
          eventId,
          digits,
          at,
          since: new Date(at.valueOf() - DECISION_HOLDS_PLACE_MS - CLOCK_MARGIN_MS),
          until: new Date(at.valueOf() + CLOCK_MARGIN_MS),
        },
      },
    );
    return rows.length === 1;
  } catch (err) {
    // The same event arriving twice at once: the unique index on released_by lets one through.
    if (err?.name === 'SequelizeUniqueConstraintError') return false;
    throw err;
  }
}

/**
 * Give back the places of the outside legs these new call control events end.
 * Never throws: a place not given back is held until its time runs out.
 */
export async function releasePlacesForEvents(organisationId, events, models = {}) {
  const { log = defaultLogger } = models;
  for (const event of events) {
    const number = unansweredOutsideLeg(event);
    if (!number) continue;
    try {
      // eslint-disable-next-line no-await-in-loop
      await releaseOutboundPlace({ organisationId, number, at: event.at, eventId: event.id }, models);
    } catch (err) {
      log.warn({ err: err?.message, organisationId, eventId: event.id }, 'outbound policy: could not give back the place of a leg');
    }
  }
}
