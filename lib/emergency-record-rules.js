/**
 * Rules for the state of a number's emergency address record: the address the
 * carrier holds for the number and gives to the emergency services. A
 * separate service sends each record and reads its status. This platform
 * holds the state (docs/emergency-records.md).
 *
 * Pure: it reads no database, so anything may import it.
 * lib/emergency-records.js applies these rules to `phone_numbers` rows.
 */
import { createHash } from 'node:crypto';

export const RECORD_STATES = ['not_entered', 'draft', 'invalid', 'submitted', 'accepted', 'rejected', 'carrier', 'mismatch'];
// A record may be sent from any of these. `submitted` waits. `carrier` is not ours to send.
export const SENDABLE_STATES = ['not_entered', 'draft', 'invalid', 'accepted', 'rejected', 'mismatch'];
export const ADDRESS_MODES = ['organisation', 'own', 'carrier'];

/** How long a claim for one send lasts. */
export const CLAIM_MS = 10 * 60 * 1000;

/** The `flags.provider` values of the trunks whose numbers have a record kept here. */
export const RECORD_PROVIDERS = ['magrathea'];

/** A call out that would show a number whose record is in one of these states is stopped. */
export const STOPPING_STATES = ['rejected'];

export const MAX_REASON_CHARS = 2000;
const MAX_ADDRESS_FIELDS = 16;
const MAX_ADDRESS_VALUE_CHARS = 200;

/** The fields of an address, as an organisation's and a number's own are stored. */
export const ADDRESS_FIELDS = ['name', 'premises', 'thoroughfare', 'locality', 'postcode', 'businessSuffix'];

/** The address with only its known fields, or null when it is not an address. */
export function cleanAddress(address) {
  if (!address || typeof address !== 'object' || Array.isArray(address)) return null;
  const out = {};
  for (const field of ADDRESS_FIELDS) {
    if (address[field] == null) continue;
    if (typeof address[field] !== 'string') return null;
    const value = address[field].trim().slice(0, 120);
    if (value) out[field] = value;
  }
  // A named building with no street is a full address. A name and a postcode alone do not find a caller.
  return out.name && out.postcode && (out.thoroughfare || out.premises) ? out : null;
}

/** An address on one line, for a list. Null when there is none. */
export function addressSummary(address) {
  if (!address || typeof address !== 'object') return null;
  return ['name', 'premises', 'thoroughfare', 'postcode'].map((field) => address[field]).filter(Boolean).join(', ') || null;
}

export const stateOf = (row) => row?.emergencyRecordState || 'not_entered';
export const modeOf = (row) => (ADDRESS_MODES.includes(row?.emergencyAddressMode) ? row.emergencyAddressMode : 'organisation');

/** True when a call out that would show a number in this record state is stopped. Never asked for an emergency call. */
export function recordStopsOutsideCalls(state) {
  return STOPPING_STATES.includes(state);
}

/** The address a record should hold: the number's own, or the organisation's. Null when there is none. */
export function addressInForce(row, organisation) {
  const mode = modeOf(row);
  if (mode === 'carrier') return null;
  const address = mode === 'own' ? row?.emergencyAddress : organisation?.address;
  return address && typeof address === 'object' && !Array.isArray(address) ? address : null;
}

const iso = (value) => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
};

// Keys in a fixed order, so the same address always gives the same text.
const canonical = (value) => {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
};

/**
 * The version of a record: a hash of everything a writer may depend on. It
 * changes when the number moves organisation, when its mode or the address in
 * force changes (so also when the organisation's address changes), and on
 * every write of the record. A counter on the row would miss a change of the
 * organisation's address.
 */
export function recordVersion(row, organisation) {
  const parts = canonical({
    organisationId: row.organisationId ?? null,
    mode: modeOf(row),
    address: addressInForce(row, organisation),
    state: stateOf(row),
    reason: row.emergencyRecordReason ?? null,
    sent: row.emergencyRecordSent ?? null,
    code: row.emergencyRecordCode ?? null,
    submittedAt: iso(row.emergencyRecordSubmittedAt),
    checkedAt: iso(row.emergencyRecordCheckedAt),
    error: row.emergencyRecordError ?? null,
    errorAt: iso(row.emergencyRecordErrorAt),
    claimedUntil: iso(row.emergencyRecordClaimedUntil),
    updatedAt: iso(row.emergencyRecordUpdatedAt),
  });
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

/** One record as the routes give it. `version` may be given: a claim answers with its own. */
export function recordView(row, organisation, version = recordVersion(row, organisation)) {
  return {
    number: row.number,
    organisationId: row.organisationId,
    version,
    mode: modeOf(row),
    address: addressInForce(row, organisation),
    sent: row.emergencyRecordSent ?? null,
    state: stateOf(row),
    stateSince: iso(row.emergencyRecordStateSince),
    code: row.emergencyRecordCode ?? null,
    reason: row.emergencyRecordReason ?? null,
    submittedAt: iso(row.emergencyRecordSubmittedAt),
    checkedAt: iso(row.emergencyRecordCheckedAt),
    error: row.emergencyRecordError ?? null,
    errorAt: iso(row.emergencyRecordErrorAt),
  };
}

/** True while a claim for one send is live on the row. */
export function claimLive(row, now = new Date()) {
  if (!row?.emergencyRecordClaimVersion || !row.emergencyRecordClaimedUntil) return false;
  return new Date(row.emergencyRecordClaimedUntil).valueOf() > now.valueOf();
}

/**
 * Is a request that names `expect` about the row as it is now?
 *
 * A claim's holder names the version the claim gave. Its write is taken
 * whatever happened to the address in force meanwhile: the carrier already
 * has the record, and a refusal would lose the note of it. That holds after
 * the claim's time too, until another claim or write replaces it. A number
 * that moved organisation is refused even then. While a claim is live nobody
 * else may write.
 *
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function checkExpect(row, organisation, expect, now = new Date()) {
  if (!expect || expect.organisationId !== row.organisationId) {
    return { ok: false, code: 'organisation_changed', message: 'The number belongs to another organisation now.' };
  }
  if (row.emergencyRecordClaimVersion && expect.version === row.emergencyRecordClaimVersion) return { ok: true };
  if (claimLive(row, now)) return { ok: false, code: 'claimed', message: 'Another send holds this number.' };
  if (expect.version !== recordVersion(row, organisation)) {
    return { ok: false, code: 'changed', message: 'The record changed since it was read.' };
  }
  return { ok: true };
}

/**
 * May a claim be taken by a request that names `expect`? Not while another
 * claim is live, and only on the row as it was read.
 *
 * @returns {{ ok: true } | { ok: false, code: string, message: string }}
 */
export function checkClaim(row, organisation, expect, now = new Date()) {
  if (!expect || expect.organisationId !== row.organisationId) {
    return { ok: false, code: 'organisation_changed', message: 'The number belongs to another organisation now.' };
  }
  if (claimLive(row, now)) return { ok: false, code: 'claimed', message: 'Another send holds this number.' };
  if (expect.version !== recordVersion(row, organisation)) {
    return { ok: false, code: 'changed', message: 'The record changed since it was read.' };
  }
  return { ok: true };
}

const isAddress = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.length <= MAX_ADDRESS_FIELDS
    && entries.every(([, v]) => typeof v === 'string' && v.length <= MAX_ADDRESS_VALUE_CHARS);
};
const isTime = (value) => typeof value === 'string' && !Number.isNaN(new Date(value).valueOf());
const isText = (value) => typeof value === 'string';

const PATCH_FIELDS = {
  state: (v) => RECORD_STATES.includes(v),
  code: (v) => v === null || Number.isInteger(v),
  reason: (v) => v === null || isText(v),
  sent: (v) => v === null || isAddress(v),
  submittedAt: isTime,
  checkedAt: isTime,
  error: (v) => v === null || isText(v),
  errorAt: (v) => v === null || isTime(v),
};

/** The field of a patch that has the wrong form, or null. Unknown fields are refused. */
export function badPatchField(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'body';
  for (const [field, value] of Object.entries(patch)) {
    if (!(field in PATCH_FIELDS) || value === undefined || !PATCH_FIELDS[field](value)) return field;
  }
  return null;
}

const refusal = (code, message) => ({ ok: false, code, message });

/**
 * May the service key make this write? It must not be able to choose a state
 * freely: `accepted` is reached only from `submitted` with the carrier's code
 * 0. Anything not listed here is refused.
 *
 * | From | To | Only with |
 * |---|---|---|
 * | a sendable state | `submitted` | `sent`, `submittedAt` |
 * | a sendable state | `invalid` | `sent` |
 * | a sendable state | `mismatch` | |
 * | `submitted` | `accepted`, `mismatch` | `code: 0` |
 * | `submitted` | `rejected` | `code: 8` |
 * | `submitted` | `draft` | `code: 1` and `sent: null` |
 * | `submitted` | `not_entered` | `code: 9` and `sent: null` |
 * | `submitted` | `submitted` | `code` 2, 3, 6 or null |
 *
 * A write with no `state` may carry `checkedAt`, `error` and `errorAt` only.
 *
 * No move needs a claim. The claim is what stops two sends at once. A sender
 * whose claim was lost must still be able to note that the carrier took its
 * record, or the next run would submit it again.
 *
 * @param {string} from   the record's state now
 * @param {object} patch  already checked by badPatchField
 */
export function checkMove(from, patch) {
  const has = (field) => patch[field] !== undefined;
  const to = patch.state;
  if (to === undefined) {
    const extra = ['code', 'reason', 'sent', 'submittedAt'].find(has);
    return extra ? refusal('state_required', `${extra} is written only together with a state.`) : { ok: true };
  }
  if (to === 'carrier' || from === 'carrier') {
    return refusal('move_not_allowed', 'A record kept at the carrier of the number\'s owner is not changed here.');
  }
  const code = patch.code ?? null;
  if (has('submittedAt') && to !== 'submitted') return refusal('move_not_allowed', 'submittedAt is written only with the state submitted.');

  if (from === 'submitted') {
    if ((to === 'draft' && code === 1) || (to === 'not_entered' && code === 9)) {
      return patch.sent === null ? { ok: true } : refusal('move_not_allowed', `A move to ${to} must also clear what was sent.`);
    }
    if (patch.sent === null) return refusal('move_not_allowed', 'What was sent is cleared only with code 1 or 9.');
    const allowed = (to === 'accepted' && code === 0)
      || (to === 'mismatch' && code === 0)
      || (to === 'rejected' && code === 8)
      || (to === 'submitted' && [2, 3, 6, null].includes(code));
    if (!allowed) return refusal('move_not_allowed', `A submitted record does not move to ${to} with code ${code}.`);
    if (has('sent') && to !== 'submitted') return refusal('move_not_allowed', 'What was sent is written only with a send.');
    return { ok: true };
  }

  if (!SENDABLE_STATES.includes(from)) return refusal('move_not_allowed', `A record does not move from ${from} to ${to}.`);
  if (patch.sent === null) return refusal('move_not_allowed', 'What was sent is cleared only with code 1 or 9.');
  if (code !== null) return refusal('move_not_allowed', 'A send carries no status code.');

  if (to === 'mismatch') {
    return has('sent') ? refusal('move_not_allowed', 'What was sent is written only with a send.') : { ok: true };
  }
  if (to === 'submitted' || to === 'invalid') {
    if (!patch.sent) return refusal('move_not_allowed', `A move to ${to} needs what was sent.`);
    if (to === 'submitted' && !has('submittedAt')) return refusal('move_not_allowed', 'A move to submitted needs submittedAt.');
    return { ok: true };
  }
  return refusal('move_not_allowed', `A record does not move from ${from} to ${to}.`);
}
