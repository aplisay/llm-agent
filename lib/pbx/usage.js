/**
 * Usage for the calls the phone system carries. Every call and every answered
 * leg writes a row when call control ends it, so every call is on the usage
 * record.
 *
 * Only a leg out to an outside number on a platform trunk is priced: it
 * carries the destination charge, as an agent's outside leg does. Everything
 * else stays inside the organisation, or is a call in, and is written at
 * nothing (`costMicros` 0, `costStatus` 'free').
 *
 * The rows use their own technology names (`pbx`, `recording`,
 * `transcription`), so a rate line written for agent calls never prices them.
 *
 * Loaded on demand by lib/pbx/call-records.js, so call records do not load rating.
 *
 * @module lib/pbx/usage
 */
import { UsageRecord, Trunk } from '../database.js';
import { costUsageRow } from '../rates.js';
import { phoneSystemTrunkChargeable } from '../outbound-authorisation.js';
import defaultLogger from '../logger.js';
import { PBX_LEG_MODEL } from './call-records.js';

export const PBX_USAGE = Object.freeze({ technology: 'pbx', provider: 'pbx', unit: 'milliseconds' });
export const FREE_COST_STATUS = 'free';
// The kinds call control gives a leg to a phone on a line. Every other leg with a trunk went outside.
const INSIDE_LEG_KINDS = new Set(['line']);

/** True for an answered leg that went out to an outside number. */
export function isOutsideLeg(call) {
  return call?.modelName === PBX_LEG_MODEL && Boolean(call.parentId) && Boolean(call.outboundTrunkId)
    && Boolean(call.calledId) && !INSIDE_LEG_KINDS.has(call.metadata?.pbx?.kind);
}

/**
 * Write one meter of a call, once. A priced meter is costed and settled when
 * it is created; a free one is written already costed at nothing.
 */
async function meter(call, { technology, provider, detail, unit, quantity, media = null, priced, metadata = null }, {
  Usage = UsageRecord, cost = costUsageRow, log = defaultLogger,
} = {}) {
  const meterKey = Usage.meterKey({ technology, provider, detail, unit });
  const defaults = {
    sessionId: call.id,
    meterKey,
    callId: call.id,
    organisationId: call.organisationId,
    technology,
    provider,
    detail,
    unit,
    media,
    quantity: Math.max(0, Math.trunc(Number(quantity) || 0)),
    finalised: true,
    billedAt: call.startedAt || call.createdAt || new Date(),
    metadata,
    ...(priced ? {} : { costMicros: 0, appliedCostMicros: 0, costStatus: FREE_COST_STATUS }),
  };
  const [row, created] = await Usage.findOrCreate({ where: { sessionId: call.id, meterKey }, defaults });
  if (created && priced) await cost(row, { log });
  return row;
}

/**
 * Write the usage of a phone system call or leg that has ended. Never throws.
 *
 * @param {object} call             the ended `calls` row
 * @param {object} [end]
 * @param {number} [end.recordedMs]    how long the call was recorded, sent on the call's own end
 * @param {number} [end.transcribedMs] how much of the leg was transcribed
 */
export async function writePbxCallUsage(call, { recordedMs, transcribedMs } = {}, models = {}) {
  const { log = defaultLogger, Trunk: Trunks = Trunk } = models;
  try {
    let priced = false;
    let metadata = null;
    if (isOutsideLeg(call)) {
      const trunk = await Trunks.findByPk(call.outboundTrunkId, { attributes: ['id', 'chargeable', 'flags'] });
      priced = phoneSystemTrunkChargeable(trunk);
      if (priced) metadata = { destinationRaw: call.calledId };
    }
    await meter(call, {
      ...PBX_USAGE, detail: call.modelName, quantity: call.duration, media: 'telephony', priced, metadata,
    }, { ...models, Usage: models.UsageRecord, log });
    if (Number(recordedMs) > 0) {
      await meter(call, {
        technology: 'recording', provider: 'pbx', detail: call.modelName, unit: 'milliseconds', quantity: recordedMs, priced: true,
      }, { ...models, Usage: models.UsageRecord, log });
    }
    if (Number(transcribedMs) > 0) {
      await meter(call, {
        technology: 'transcription', provider: 'deepgram', detail: call.modelName, unit: 'milliseconds', quantity: transcribedMs, priced: true,
      }, { ...models, Usage: models.UsageRecord, log });
    }
  } catch (err) {
    log.warn({ err: err?.message, callId: call?.id }, 'could not write the usage of a phone system call');
  }
}
