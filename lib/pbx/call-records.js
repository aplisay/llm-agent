/**
 * Call records for calls the phone system carries. Written by call control,
 * which sends each write in the background and may send it again: every write
 * here can be repeated without harm.
 *
 * A call is one `calls` row with no agent. A leg that was answered is a child
 * row. A phone that rang and was not answered is a `call_events` row.
 *
 * Ending a call or a leg writes its usage (lib/pbx/usage.js).
 */
import { Call, CallEvent, Organisation, TransactionLog } from '../database.js';
import { PbxError, assertPhoneSystemSchema } from './errors.js';
import { releasePlacesForEvents } from '../outbound-places.js';
import { notRedacted } from '../redacted-calls.js';
import { transcriptSpeakerReady, PHONE_SYSTEM_NOT_READY } from '../capabilities.js';

export const PBX_CALL_MODEL = 'telephony:pbx-call';
export const PBX_LEG_MODEL = 'telephony:pbx-leg';
export const PBX_PLATFORM = 'pbx';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EVENTS = 200;
const MAX_TEXTS = 200;
const MAX_TEXT_CHARS = 4000;

const isPbxCall = (call) => call?.platform === PBX_PLATFORM;
const dateOf = (value, field) => {
  if (value == null) return null;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new PbxError(400, 'bad_request', `${field} is not a time`);
  return date;
};

export const callView = (call) => ({
  id: call.id,
  parentId: call.parentId,
  organisationId: call.organisationId,
  index: call.index,
  callerId: call.callerId,
  calledId: call.calledId,
  platformCallId: call.platformCallId,
  outboundTrunkId: call.outboundTrunkId,
  modelName: call.modelName,
  metadata: call.metadata,
  startedAt: call.startedAt,
  endedAt: call.endedAt,
  duration: call.duration,
  status: call.status,
  live: call.live,
});

/**
 * Create a call or an answered leg, or update the one with this id.
 * @returns {Promise<{ call: object, created: boolean }>}
 */
export async function upsertCall(input = {}) {
  const { id, organisationId, parentId } = input;
  if (!UUID_RE.test(id ?? '')) throw new PbxError(400, 'bad_request', 'id must be a UUID chosen by the caller');
  if (!organisationId) throw new PbxError(400, 'bad_request', 'organisationId is required');

  const fields = {};
  for (const key of ['callerId', 'calledId', 'platformCallId', 'outboundTrunkId']) {
    if (input[key] !== undefined) fields[key] = input[key] === null ? null : String(input[key]);
  }
  const startedAt = dateOf(input.startedAt, 'startedAt');

  const existing = await Call.findByPk(id);
  if (existing) {
    if (!isPbxCall(existing) || existing.organisationId !== organisationId) {
      throw new PbxError(409, 'call_id_in_use', 'That call id belongs to another call');
    }
    // An ended call is never started again by a late write.
    if (existing.endedAt) return { call: existing, created: false };
    if (input.metadata && typeof input.metadata === 'object') {
      fields.metadata = { ...(existing.metadata || {}), pbx: { ...(existing.metadata?.pbx || {}), ...input.metadata } };
    }
    if (startedAt) fields.startedAt = startedAt;
    await existing.update(fields);
    return { call: existing, created: false };
  }

  if (!(await Organisation.findByPk(organisationId, { attributes: ['id'] }))) {
    throw new PbxError(404, 'not_found', 'Organisation not found');
  }
  if (parentId) {
    const parent = UUID_RE.test(parentId) ? await Call.findByPk(parentId) : null;
    if (!parent || !isPbxCall(parent) || parent.organisationId !== organisationId) {
      throw new PbxError(404, 'not_found', 'Parent call not found');
    }
  }
  const call = await Call.create({
    id,
    parentId: parentId || null,
    organisationId,
    platform: PBX_PLATFORM,
    modelName: parentId ? PBX_LEG_MODEL : PBX_CALL_MODEL,
    ...fields,
    metadata: { pbx: input.metadata && typeof input.metadata === 'object' ? input.metadata : {} },
    startedAt: startedAt || new Date(),
    live: true,
    status: 'in progress',
  });
  return { call, created: true };
}

async function pbxCall(callId) {
  const call = UUID_RE.test(callId ?? '') ? await Call.findByPk(callId) : null;
  if (!call || !isPbxCall(call)) throw new PbxError(404, 'not_found', 'Call not found');
  return call;
}

/**
 * Add events to a call. An event whose id is already stored is skipped.
 * @returns {Promise<{ stored: number, duplicates: number }>}
 */
export async function addEvents(callId, events) {
  assertPhoneSystemSchema();
  const call = await pbxCall(callId);
  if (!Array.isArray(events) || !events.length) throw new PbxError(400, 'bad_request', 'events must be a list with at least one event');
  if (events.length > MAX_EVENTS) throw new PbxError(413, 'too_many_events', `At most ${MAX_EVENTS} events in one request`);
  const rows = events.map((event, i) => {
    if (!UUID_RE.test(event?.id ?? '')) throw new PbxError(400, 'bad_request', `events[${i}].id must be a UUID chosen by the caller`);
    if (typeof event.type !== 'string' || !/^[a-z][a-z0-9_.]{0,31}$/.test(event.type)) {
      throw new PbxError(400, 'bad_request', `events[${i}].type must be a short lower-case name`);
    }
    return {
      id: event.id,
      organisationId: call.organisationId,
      callId: call.id,
      type: event.type,
      at: dateOf(event.at, `events[${i}].at`) || new Date(),
      data: event.data && typeof event.data === 'object' ? event.data : {},
    };
  });
  const known = new Set(
    (await CallEvent.findAll({ where: { id: rows.map((row) => row.id) }, attributes: ['id'] })).map((row) => row.id),
  );
  const fresh = rows.filter((row) => !known.has(row.id));
  // ignoreDuplicates covers the same event arriving twice at once.
  if (fresh.length) await CallEvent.bulkCreate(fresh, { ignoreDuplicates: true });
  await releasePlacesForEvents(call.organisationId, fresh);
  return { stored: fresh.length, duplicates: rows.length - fresh.length };
}

// A length that is not a whole number of milliseconds is dropped: the call still ends.
const msOf = (value) => {
  if (value == null) return undefined;
  const ms = Number(value);
  return Number.isInteger(ms) && ms >= 0 ? ms : undefined;
};

// Loaded on demand: usage loads rating, which call records do not otherwise need.
async function writeUsage(call, end) {
  const { writePbxCallUsage } = await import('./usage.js');
  await writePbxCallUsage(call, end);
}

/**
 * End a call or a leg, and write its usage. Ending it again changes nothing,
 * but writes any usage the first end did not.
 */
export async function endCall(callId, { endedAt, reason, answered, recordedMs, transcribedMs } = {}) {
  const usage = { recordedMs: msOf(recordedMs), transcribedMs: msOf(transcribedMs) };
  const call = await pbxCall(callId);
  if (call.endedAt) {
    await writeUsage(call, usage);
    return { call, ended: false };
  }
  const end = dateOf(endedAt, 'endedAt') || new Date();
  await call.update({
    endedAt: end,
    duration: call.startedAt ? Math.max(0, end.valueOf() - call.startedAt.valueOf()) : null,
    live: false,
    status: 'ended normally',
    metadata: {
      ...(call.metadata || {}),
      pbx: {
        ...(call.metadata?.pbx || {}),
        ...(reason !== undefined ? { endReason: String(reason).slice(0, 64) } : {}),
        ...(answered !== undefined ? { answered: Boolean(answered) } : {}),
      },
    },
  });
  await writeUsage(call, usage);
  return { call, ended: true };
}

const hasControl = (text) => [...text].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127);
const isRecordingKey = (value) => {
  if (typeof value !== 'string') return false;
  const bytes = Buffer.from(value, 'base64');
  return bytes.length === 32 && bytes.toString('base64') === value;
};

/**
 * Store the finished recording of a call: the object's name in the recording
 * store and the key it is encrypted with (lib/recording/CONTRACT.md). Only the
 * call itself takes one, never a leg, and only once.
 *
 * The caller deletes its file on any refusal, so nothing here refuses after
 * the row is written: the check and the write are one statement.
 *
 * @returns {Promise<{ outcome: 'stored'|'held'|'exists', recordingId: string }>}
 *   `held`: the call already had this same file. `exists`: it has another, named in `recordingId`.
 */
export async function setRecording(callId, { organisationId, recordingId, encryptionKey } = {}) {
  if (typeof organisationId !== 'string' || !organisationId) throw new PbxError(400, 'bad_request', 'organisationId is required');
  if (typeof recordingId !== 'string' || !recordingId || recordingId.length > 1024 || hasControl(recordingId)) {
    throw new PbxError(400, 'bad_request', 'recordingId must be an object name of 1 to 1024 characters', { field: 'recordingId' });
  }
  if (!isRecordingKey(encryptionKey)) {
    throw new PbxError(400, 'bad_request', 'encryptionKey must be 32 bytes in base64', { field: 'encryptionKey' });
  }
  if (!UUID_RE.test(callId ?? '')) throw new PbxError(404, 'not_found', 'Call not found');
  // The name carries the call id, so one call's file is never stored on another.
  if (!recordingId.toLowerCase().includes(callId.toLowerCase())) {
    throw new PbxError(400, 'bad_request', 'recordingId must contain the call id', { field: 'recordingId' });
  }
  const mine = { id: callId, organisationId, platform: PBX_PLATFORM, parentId: null, ...notRedacted() };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const [stored] = await Call.update({ recordingId, encryptionKey }, { where: { ...mine, recordingId: null } });
    if (stored) return { outcome: 'stored', recordingId };
    const call = await Call.findOne({ where: mine, attributes: ['id', 'recordingId'] });
    if (!call) throw new PbxError(404, 'not_found', 'Call not found');
    // The same request sent again must not be refused: the caller would delete the file kept here.
    if (call.recordingId === recordingId) return { outcome: 'held', recordingId };
    if (call.recordingId) return { outcome: 'exists', recordingId: call.recordingId };
    // The recording was removed between the two statements: write once more.
  }
  throw new Error(`recording of call ${callId} not stored: the row changed twice during the write`);
}

/**
 * Add what was said on a call to its transcript. Each text names the row that
 * spoke: the call itself for the caller, or one of its answered legs. The rows
 * go on the call, never on a leg, so one read gives the whole call in order.
 * A text whose id is already stored is skipped. One bad text refuses them all.
 *
 * @param {object[]} texts `{ id, leg, text, at? }`: `id` is chosen by the caller, `at` is when the words began
 * @returns {Promise<{ stored: number, duplicates: number }>}
 */
export async function addTranscript(callId, texts) {
  assertPhoneSystemSchema();
  if (!transcriptSpeakerReady()) throw new PbxError(503, PHONE_SYSTEM_NOT_READY.code, PHONE_SYSTEM_NOT_READY.error);
  if (!Array.isArray(texts) || !texts.length) throw new PbxError(400, 'bad_request', 'texts must be a list with at least one text');
  if (texts.length > MAX_TEXTS) throw new PbxError(400, 'bad_request', `At most ${MAX_TEXTS} texts in one request`);
  const rows = new Map();
  texts.forEach((item, i) => {
    if (!UUID_RE.test(item?.id ?? '')) throw new PbxError(400, 'bad_request', `texts[${i}].id must be a UUID chosen by the caller`);
    if (!UUID_RE.test(item.leg ?? '')) throw new PbxError(400, 'bad_request', `texts[${i}].leg must be the id of the call or of one of its legs`);
    if (typeof item.text !== 'string' || !item.text.trim() || item.text.length > MAX_TEXT_CHARS) {
      throw new PbxError(400, 'bad_request', `texts[${i}].text must be 1 to ${MAX_TEXT_CHARS} characters`);
    }
    const sourceId = item.id.toLowerCase();
    if (rows.has(sourceId)) return;
    rows.set(sourceId, {
      sourceId,
      speaker: item.leg.toLowerCase(),
      data: item.text,
      createdAt: dateOf(item.at, `texts[${i}].at`) || new Date(),
    });
  });
  if (!UUID_RE.test(callId ?? '')) throw new PbxError(404, 'not_found', 'Call not found');

  return Call.sequelize.transaction(async (transaction) => {
    // The lock gives a call one writer at a time. An erasure takes the same lock
    // (lib/call-redaction.js), so no text lands on a call after it is erased.
    const call = await Call.findOne({
      where: { id: callId, platform: PBX_PLATFORM, parentId: null, ...notRedacted() },
      attributes: ['id', 'organisationId'],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!call) throw new PbxError(404, 'not_found', 'Call not found');
    const legIds = [...new Set([...rows.values()].map((row) => row.speaker))].filter((id) => id !== call.id);
    if (legIds.length) {
      const legs = await Call.count({ where: { id: legIds, parentId: call.id, platform: PBX_PLATFORM }, transaction });
      if (legs !== legIds.length) throw new PbxError(404, 'not_found', 'A leg is not this call or one of its legs');
    }
    const known = new Set((await TransactionLog.findAll({
      where: { callId: call.id, sourceId: [...rows.keys()] },
      attributes: ['sourceId'],
      transaction,
    })).map((row) => row.sourceId));
    const fresh = [...rows.values()].filter((row) => !known.has(row.sourceId));
    if (fresh.length) {
      await TransactionLog.bulkCreate(fresh.map((row) => ({
        ...row, callId: call.id, organisationId: call.organisationId, type: 'user', isFinal: true, updatedAt: row.createdAt,
      })), { transaction });
    }
    return { stored: fresh.length, duplicates: texts.length - fresh.length };
  });
}

export async function listEvents(callId) {
  assertPhoneSystemSchema();
  const rows = await CallEvent.findAll({ where: { callId }, order: [['at', 'ASC'], ['createdAt', 'ASC']] });
  return rows.map((row) => ({ id: row.id, type: row.type, at: row.at, data: row.data }));
}
