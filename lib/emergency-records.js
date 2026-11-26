/**
 * The state of each number's emergency address record, read and written by
 * the service that sends the records to the carrier (docs/emergency-records.md).
 * The rules are in lib/emergency-record-rules.js. This module applies them to
 * `phone_numbers` rows.
 *
 * A number has a record here when its trunk belongs to one of
 * RECORD_PROVIDERS and its organisation has the phone system.
 */
import { randomBytes } from 'node:crypto';
import { PhoneNumber as DefaultPhoneNumber, Organisation as DefaultOrganisation } from './database.js';
import { emergencyRecordsReady, phoneSystemReady } from './capabilities.js';
import { can } from './auth/permissions.js';
import { normalizeE164 } from './validation.js';
import { EMERGENCY_NUMBERS } from './pbx/numbers.js';
import {
  RECORD_STATES, RECORD_PROVIDERS, CLAIM_MS, MAX_REASON_CHARS,
  stateOf, recordView, recordStopsOutsideCalls, checkClaim, checkExpect, checkMove, badPatchField,
} from './emergency-record-rules.js';

export const DEFAULT_PAGE = 200;
export const MAX_PAGE = 500;

export const EMERGENCY_RECORDS_NOT_READY = {
  error: 'Emergency address records need a database upgrade. Run tools/agent-admin.js upgrade-db, then restart the API server.',
  code: 'emergency_records_not_ready',
};

/** A refusal of a record request: an HTTP status, a stable code and a plain sentence. */
export class EmergencyRecordError extends Error {
  constructor(status, code, message, field) {
    super(message);
    this.name = 'EmergencyRecordError';
    this.status = status;
    this.code = code;
    if (field !== undefined) this.field = field;
  }

  body() {
    return { error: this.message, code: this.code, ...(this.field !== undefined ? { field: this.field } : {}) };
  }
}

const notFound = () => new EmergencyRecordError(404, 'not_found', 'No record is kept here for that number.');

function assertReady() {
  if (!emergencyRecordsReady()) {
    throw new EmergencyRecordError(503, EMERGENCY_RECORDS_NOT_READY.code, EMERGENCY_RECORDS_NOT_READY.error);
  }
}

// One row for a number: the first created, should the number be on two such trunks.
const IN_SCOPE = `
  FROM phone_numbers p
  JOIN trunks t ON t.id = p.aplisay_id
  JOIN organisations o ON o.id = p.organisation_id
 WHERE t.flags->>'provider' IN (:providers)
   AND o.capabilities @> '["phoneSystem"]'::jsonb`;

const organisationOf = (row, { Organisation }, transaction) => Organisation.findByPk(row.organisationId, {
  attributes: ['id', 'address'],
  transaction,
});

/** The id of the row that holds the record of `number`, or null when the number is not in scope. */
async function recordRowId(number, { PhoneNumber }, transaction) {
  const digits = normalizeE164(String(number ?? '').trim());
  if (!digits) return null;
  const [found] = await PhoneNumber.sequelize.query(
    `SELECT p.id ${IN_SCOPE} AND p.number = :number ORDER BY p.created_at, p.id LIMIT 1`,
    { replacements: { providers: RECORD_PROVIDERS, number: digits }, type: PhoneNumber.sequelize.QueryTypes.SELECT, transaction },
  );
  return found?.id ?? null;
}

/**
 * A page of records, in number order.
 *
 * @param {object} query
 * @param {string[]} [query.states] only records in these states. All states when absent
 * @param {string} [query.after]    only numbers after this one. Paged by number, not by offset,
 *                                  because rows change state while a caller pages through them
 * @param {number} [query.limit]
 * @returns {Promise<{ items: object[], next: string|null }>}
 */
export async function listRecords({ states, after = '', limit = DEFAULT_PAGE } = {}, models = {}) {
  const { PhoneNumber = DefaultPhoneNumber, Organisation = DefaultOrganisation } = models;
  assertReady();
  const wanted = states?.length ? states : RECORD_STATES;
  const bad = wanted.find((state) => !RECORD_STATES.includes(state));
  if (bad !== undefined) throw new EmergencyRecordError(400, 'invalid_request', `Unknown state: ${bad}`, 'states');
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    throw new EmergencyRecordError(400, 'invalid_request', `limit must be a whole number from 1 to ${MAX_PAGE}`, 'limit');
  }
  const { sequelize } = PhoneNumber;
  const found = await sequelize.query(
    `SELECT id, number FROM (
       SELECT DISTINCT ON (p.number COLLATE "C") p.id, p.number, p.emergency_record_state AS state ${IN_SCOPE}
          AND p.number COLLATE "C" > :after
        ORDER BY p.number COLLATE "C", p.created_at, p.id) r
      WHERE COALESCE(r.state, 'not_entered') IN (:states)
      ORDER BY r.number COLLATE "C" LIMIT :limit`,
    {
      replacements: { providers: RECORD_PROVIDERS, after: String(after ?? ''), states: wanted, limit: limit + 1 },
      type: sequelize.QueryTypes.SELECT,
    },
  );
  const ids = found.slice(0, limit).map((row) => row.id);
  const rows = ids.length ? await PhoneNumber.findAll({ where: { id: ids } }) : [];
  const byId = new Map(rows.map((row) => [row.id, row]));
  const organisationIds = [...new Set(rows.map((row) => row.organisationId))];
  const organisations = new Map(
    (organisationIds.length ? await Organisation.findAll({ where: { id: organisationIds }, attributes: ['id', 'address'] }) : [])
      .map((organisation) => [organisation.id, organisation]),
  );
  // A row deleted between the two reads is left out.
  const items = ids.map((id) => byId.get(id)).filter(Boolean)
    .map((row) => recordView(row, organisations.get(row.organisationId)));
  return { items, next: found.length > limit ? found[limit - 1].number : null };
}

/** One record as it is now. Throws 404 when the number is not in scope. */
export async function readRecord(number, models = {}) {
  const { PhoneNumber = DefaultPhoneNumber, Organisation = DefaultOrganisation } = models;
  assertReady();
  const id = await recordRowId(number, { PhoneNumber });
  const row = id && await PhoneNumber.findByPk(id);
  if (!row) throw notFound();
  return recordView(row, await organisationOf(row, { Organisation }));
}

function assertExpect(expect) {
  if (!expect || typeof expect !== 'object' || typeof expect.organisationId !== 'string' || typeof expect.version !== 'string') {
    throw new EmergencyRecordError(400, 'invalid_request', 'expect must name organisationId and version', 'expect');
  }
}

/**
 * Run `change(row, organisation, transaction)` on the record's row, with the
 * row locked. Two requests for one number run one after the other, so the
 * second sees what the first wrote.
 */
async function withRecord(number, { PhoneNumber, Organisation }, change) {
  return PhoneNumber.sequelize.transaction(async (transaction) => {
    const id = await recordRowId(number, { PhoneNumber }, transaction);
    const row = id && await PhoneNumber.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) throw notFound();
    return change(row, await organisationOf(row, { Organisation }, transaction), transaction);
  });
}

/**
 * Take a number for one send, so that two senders cannot both send it. The
 * claim lasts CLAIM_MS. The next write of the record ends it.
 *
 * @returns {Promise<object>} the record, with the version the holder must name in its write
 */
export async function claimRecord(number, expect, { now = new Date(), ...models } = {}) {
  const { PhoneNumber = DefaultPhoneNumber, Organisation = DefaultOrganisation } = models;
  assertReady();
  assertExpect(expect);
  return withRecord(number, { PhoneNumber, Organisation }, async (row, organisation, transaction) => {
    const checked = checkClaim(row, organisation, expect, now);
    if (!checked.ok) throw new EmergencyRecordError(409, checked.code, checked.message);
    const version = `c-${randomBytes(16).toString('hex')}`;
    await row.update({
      emergencyRecordClaimedUntil: new Date(now.valueOf() + CLAIM_MS),
      emergencyRecordClaimVersion: version,
      emergencyRecordUpdatedAt: now,
    }, { transaction });
    return recordView(row, organisation, version);
  });
}

const COLUMN_OF = {
  state: 'emergencyRecordState',
  code: 'emergencyRecordCode',
  reason: 'emergencyRecordReason',
  sent: 'emergencyRecordSent',
  submittedAt: 'emergencyRecordSubmittedAt',
  checkedAt: 'emergencyRecordCheckedAt',
  error: 'emergencyRecordError',
  errorAt: 'emergencyRecordErrorAt',
};
const TIME_FIELDS = new Set(['submittedAt', 'checkedAt', 'errorAt']);
const TEXT_FIELDS = new Set(['reason', 'error']);

/**
 * Write the result of a send or of a status read. 409 when `expect` is not
 * the row as it is now, 422 when the move is not one the service key may make.
 *
 * @returns {Promise<object>} the record after the write
 */
export async function writeRecord(number, expect, patch, { now = new Date(), ...models } = {}) {
  const { PhoneNumber = DefaultPhoneNumber, Organisation = DefaultOrganisation } = models;
  assertReady();
  assertExpect(expect);
  const field = badPatchField(patch);
  if (field) throw new EmergencyRecordError(400, 'invalid_request', `${field} is not valid`, field);
  return withRecord(number, { PhoneNumber, Organisation }, async (row, organisation, transaction) => {
    const checked = checkExpect(row, organisation, expect, now);
    if (!checked.ok) throw new EmergencyRecordError(409, checked.code, checked.message);
    const from = stateOf(row);
    const move = checkMove(from, patch);
    if (!move.ok) throw new EmergencyRecordError(422, move.code, move.message);

    const fields = {};
    for (const [name, value] of Object.entries(patch)) {
      if (value !== null && TIME_FIELDS.has(name)) fields[COLUMN_OF[name]] = new Date(value);
      else if (value !== null && TEXT_FIELDS.has(name)) fields[COLUMN_OF[name]] = value.slice(0, MAX_REASON_CHARS);
      else fields[COLUMN_OF[name]] = value;
    }
    if (patch.state !== undefined && patch.state !== from) fields.emergencyRecordStateSince = now;
    await row.update({
      ...fields,
      emergencyRecordClaimedUntil: null,
      emergencyRecordClaimVersion: null,
      emergencyRecordUpdatedAt: now,
    }, { transaction });
    return recordView(row, organisation);
  });
}

/**
 * The outside-call rule: the number a call out would show, when its record
 * stops such calls. Null when the call may go on, as far as this rule goes.
 *
 * An emergency call is never stopped here. Call control does not ask for one,
 * and the check for 999 and 112 below keeps it so if anything ever does.
 */
export async function shownNumberStopped({ organisationId, presentNumber, calledId }, { PhoneNumber = DefaultPhoneNumber } = {}) {
  if (EMERGENCY_NUMBERS.includes(String(calledId ?? '').trim())) return null;
  const number = normalizeE164(String(presentNumber ?? '').trim());
  if (!organisationId || !number || !phoneSystemReady()) return null;
  const row = await PhoneNumber.findOne({
    where: { organisationId, number },
    attributes: ['number', 'emergencyRecordState'],
  });
  return row && recordStopsOutsideCalls(stateOf(row)) ? { number: row.number, state: stateOf(row) } : null;
}

/**
 * Route guard: only the service key of the emergencyService role may pass.
 * The workers' shared token passes every permission check, so it is refused
 * by name: these records are not the workers' to read or write.
 */
export function requireEmergencyService(res, action) {
  const user = res.locals.user;
  if (user && user.isSystem !== true && can(user, 'emergencyRecord', action)) return true;
  res.status(403).json({ message: 'forbidden', detail: `Requires emergencyRecord:${action}` });
  return false;
}

/** Send an EmergencyRecordError as its own status and body. Anything else is a 500. */
export function sendEmergencyRecordError(res, err, log, context = 'emergency record request failed') {
  if (err instanceof EmergencyRecordError) {
    res.status(err.status).send(err.body());
    return;
  }
  log?.error?.(err, context);
  res.status(500).send({ error: 'Internal server error' });
}
