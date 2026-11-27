/**
 * Call redaction, behind DELETE /calls/{callId}.
 *
 * The call row is kept as the billing record: who, when, how long, which
 * agent, model and trunk. Its usage_records rows, which hold the cost and the
 * billed destination, are not touched. Everything that identifies the caller
 * or holds what was said is removed: caller and called numbers, metadata,
 * agent options, transcripts, call events, invocation logs and the recording.
 * The row is then marked redacted and customer reads leave it out.
 *
 * One DELETE redacts every leg of the conversation (all rows joined by
 * parentId), because each leg holds the caller number and its own transcript.
 *
 * Needs schema 78 (lib/schema-guards.js `callRedaction`).
 */
import {
  Call, TransactionLog, InvocationLog, CallEvent, CallConcurrency, Op,
} from './database.js';
import { stepReady } from './schema-guards.js';
import { recordingStorageConfig, openRecordingStore } from './recording/index.js';
import { callRedactionReady } from './redacted-calls.js';

export { callRedactionReady, notRedacted, CALL_REDACTED } from './redacted-calls.js';

const HOUR_MS = 60 * 60 * 1000;

// Late writes (invocation log, recording upload, transcript backfill) land
// shortly after a call ends. Redacting before they arrive would let them put
// data back on paths that do not check, so refuse until they have landed.
export const SETTLE_MS = 15 * 60 * 1000;

// A leg with no end after this long is treated as stuck (a lost end signal),
// not live, so it does not block redaction for ever.
export const STUCK_MS = 24 * HOUR_MS;

const MAX_DEPTH = 100;
const MAX_LEGS = 1000;

/** True when the call exists and is redacted. Worker write paths use it to drop late writes. */
export async function isCallRedacted(callId) {
  if (!callRedactionReady() || !callId) return false;
  const call = await Call.findByPk(callId, { attributes: ['id', 'redactedAt'] });
  return Boolean(call?.redactedAt);
}

/**
 * Every leg of the conversation that `callId` belongs to, within `scope`.
 * Null when `callId` is not in scope. Throws when the tree is larger than
 * MAX_LEGS, so a redaction is never partial.
 */
export async function findCallTree(callId, scope) {
  const start = await Call.findOne({ where: { id: callId, ...scope }, attributes: ['id', 'parentId'] });
  if (!start) return null;
  let root = start;
  const seenUp = new Set([root.id]);
  for (let i = 0; root.parentId && i < MAX_DEPTH; i += 1) {
    if (seenUp.has(root.parentId)) break;
    // eslint-disable-next-line no-await-in-loop
    const parent = await Call.findOne({ where: { id: root.parentId, ...scope }, attributes: ['id', 'parentId'] });
    if (!parent) break;
    seenUp.add(parent.id);
    root = parent;
  }
  const legs = new Map();
  let frontier = [root.id];
  while (frontier.length) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await Call.findAll({ where: { id: { [Op.in]: frontier }, ...scope } });
    for (const row of rows) legs.set(row.id, row);
    if (legs.size > MAX_LEGS) throw new Error(`call tree of ${callId} has more than ${MAX_LEGS} legs`);
    // eslint-disable-next-line no-await-in-loop
    const children = await Call.findAll({ where: { parentId: { [Op.in]: frontier }, ...scope }, attributes: ['id'] });
    frontier = children.map((c) => c.id).filter((id) => !legs.has(id));
  }
  return [...legs.values()];
}

/** Why a leg cannot be redacted yet, or null when it can. */
export function legBlocker(leg, now = new Date()) {
  const created = new Date(leg.createdAt ?? leg.startedAt ?? 0).getTime();
  if (leg.live || !leg.endedAt) {
    return now.getTime() - created < STUCK_MS ? 'in_progress' : null;
  }
  return now.getTime() - new Date(leg.endedAt).getTime() < SETTLE_MS ? 'recently_ended' : null;
}

export async function deleteFromRecordingStore(objectName) {
  if (recordingStorageConfig().enabled) await (await openRecordingStore()).delete(objectName);
}

/**
 * Redact the conversation that `callId` belongs to.
 *
 * Returns one of:
 *  - `{ outcome: 'not_found' }`: not in scope, or already redacted;
 *  - `{ outcome: 'busy', blockers }`: a leg is live or ended too recently;
 *  - `{ outcome: 'redacted', callIds, recordingErrors }`.
 *
 * Database changes are one transaction. Recording objects are deleted after
 * it commits, best effort: a failure is reported in `recordingErrors` and
 * the object name is logged so it can be removed by hand.
 */
export async function redactCallTree({
  callId, scope, actorId = null, now = new Date(), log, deleteRecordingObject = deleteFromRecordingStore,
}) {
  const legs = await findCallTree(callId, scope);
  if (!legs || legs.find((leg) => leg.id === callId)?.redactedAt) return { outcome: 'not_found' };

  const blockers = legs
    .map((leg) => ({ callId: leg.id, reason: legBlocker(leg, now) }))
    .filter((b) => b.reason);
  if (blockers.length) return { outcome: 'busy', blockers };

  const callIds = legs.map((leg) => leg.id);
  const recordings = legs.filter((leg) => leg.recordingId).map((leg) => ({ callId: leg.id, objectName: leg.recordingId }));

  await Call.sequelize.transaction(async (transaction) => {
    const where = { callId: { [Op.in]: callIds } };
    // First, so a write that checks "not erased" under this lock cannot land after the deletes below.
    await Call.findAll({ where: { id: { [Op.in]: callIds } }, attributes: ['id'], transaction, lock: transaction.LOCK.UPDATE });
    await TransactionLog.destroy({ where, transaction, hooks: false });
    await InvocationLog.destroy({ where, transaction });
    // call_events arrives with schema 73 and may not exist yet.
    if (stepReady('phoneSystem')) await CallEvent.destroy({ where, transaction });
    // A stuck leg may still hold a concurrency slot.
    await CallConcurrency.destroy({ where, transaction });
    await Call.update({
      callerId: null,
      calledId: null,
      metadata: {},
      options: null,
      streamUrl: null,
      recordingId: null,
      encryptionKey: null,
      live: false,
      redactedAt: now,
      redactedBy: actorId,
    }, { where: { id: { [Op.in]: callIds } }, transaction, hooks: false });
  });

  const recordingErrors = [];
  for (const { callId: legId, objectName } of recordings) {
    try {
      // eslint-disable-next-line no-await-in-loop
      await deleteRecordingObject(objectName);
    } catch (err) {
      recordingErrors.push({ callId: legId, objectName });
      log?.error?.({ err: err?.message, callId: legId, objectName }, 'call redaction: recording object not deleted, remove it by hand');
    }
  }
  log?.info?.({ callId, legs: callIds.length, recordings: recordings.length, recordingErrors: recordingErrors.length, actorId }, 'call redacted');
  return { outcome: 'redacted', callIds, recordingErrors };
}
