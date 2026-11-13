/**
 * Call records for calls the phone system carries. Written by call control,
 * which sends each write in the background and may send it again: every write
 * here can be repeated without harm.
 *
 * A call is one `calls` row with no agent. A leg that was answered is a child
 * row. A phone that rang and was not answered is a `call_events` row.
 *
 * Nothing here writes usage: these calls are not charged yet.
 */
import { Call, CallEvent, Organisation } from '../database.js';
import { PbxError } from './errors.js';

export const PBX_CALL_MODEL = 'telephony:pbx-call';
export const PBX_LEG_MODEL = 'telephony:pbx-leg';
export const PBX_PLATFORM = 'pbx';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_EVENTS = 200;

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
  return { stored: fresh.length, duplicates: rows.length - fresh.length };
}

/** End a call or a leg. Ending it again changes nothing. */
export async function endCall(callId, { endedAt, reason, answered } = {}) {
  const call = await pbxCall(callId);
  if (call.endedAt) return { call, ended: false };
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
  return { call, ended: true };
}

export async function listEvents(callId) {
  const rows = await CallEvent.findAll({ where: { callId }, order: [['at', 'ASC'], ['createdAt', 'ASC']] });
  return rows.map((row) => ({ id: row.id, type: row.type, at: row.at, data: row.data }));
}
