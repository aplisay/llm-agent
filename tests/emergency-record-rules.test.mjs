/**
 * The rules for the state of an emergency address record
 * (lib/emergency-record-rules.js). No database.
 */
import {
  RECORD_STATES, SENDABLE_STATES, STOPPING_STATES, CLAIM_MS,
  stateOf, modeOf, addressInForce, recordVersion, recordView, recordStopsOutsideCalls,
  claimLive, checkClaim, checkExpect, checkMove, badPatchField,
} from '../lib/emergency-record-rules.js';
import { statementsFor, can, actorCanGrant, roles } from '../lib/auth/permissions.js';
import { emergencyRecordsReady } from '../lib/capabilities.js';
import { stepOff } from '../lib/schema-guards.js';

const NOW = new Date('2026-11-19T02:00:00Z');
const ORG_ADDRESS = { name: 'Acme Engineering Limited', thoroughfare: 'Brunel Road', postcode: 'RG7 4AB' };
const OWN_ADDRESS = { name: 'Acme Depot', thoroughfare: 'Mill Lane', postcode: 'LS1 4DY' };
const SENT = { name: 'Acme Engng Ltd', thoroughfare: 'Brunel Road', postcode: 'RG7 4AB' };
const organisation = { id: 'org-1', address: ORG_ADDRESS };

const row = (over = {}) => ({
  number: '442079460810',
  organisationId: 'org-1',
  emergencyAddressMode: null,
  emergencyAddress: null,
  emergencyRecordState: null,
  ...over,
});

describe('reading a row', () => {
  test('a row with no state is not entered, and with no mode uses the organisation\'s address', () => {
    expect(stateOf(row())).toBe('not_entered');
    expect(modeOf(row())).toBe('organisation');
    expect(modeOf(row({ emergencyAddressMode: 'nonsense' }))).toBe('organisation');
    expect(addressInForce(row(), organisation)).toEqual(ORG_ADDRESS);
  });

  test('the address in force is the number\'s own in mode own, and never the organisation\'s then', () => {
    expect(addressInForce(row({ emergencyAddressMode: 'own', emergencyAddress: OWN_ADDRESS }), organisation)).toEqual(OWN_ADDRESS);
    expect(addressInForce(row({ emergencyAddressMode: 'own' }), organisation)).toBeNull();
  });

  test('there is no address in force for a number kept at its owner\'s carrier, or with none entered', () => {
    expect(addressInForce(row({ emergencyAddressMode: 'carrier', emergencyAddress: OWN_ADDRESS }), organisation)).toBeNull();
    expect(addressInForce(row(), { id: 'org-1', address: null })).toBeNull();
    expect(addressInForce(row(), null)).toBeNull();
  });

  test('the view has the fields the sending service reads', () => {
    const view = recordView(row({
      emergencyRecordState: 'submitted', emergencyRecordSent: SENT, emergencyRecordSubmittedAt: new Date('2026-11-17T10:00:00Z'),
    }), organisation);
    expect(view).toEqual({
      number: '442079460810',
      organisationId: 'org-1',
      version: expect.stringMatching(/^[0-9a-f]{32}$/),
      mode: 'organisation',
      address: ORG_ADDRESS,
      sent: SENT,
      state: 'submitted',
      stateSince: null,
      code: null,
      reason: null,
      submittedAt: '2026-11-17T10:00:00.000Z',
      checkedAt: null,
      error: null,
      errorAt: null,
    });
  });
});

describe('the version', () => {
  const base = row({ emergencyRecordState: 'accepted', emergencyRecordSent: SENT });
  const version = recordVersion(base, organisation);

  test('is the same for the same record, whatever the order of an address\'s keys', () => {
    const reordered = { postcode: 'RG7 4AB', name: 'Acme Engineering Limited', thoroughfare: 'Brunel Road' };
    expect(recordVersion({ ...base }, { id: 'org-1', address: reordered })).toBe(version);
  });

  test.each([
    ['the number moves organisation', { organisationId: 'org-2' }, organisation],
    ['the mode changes', { emergencyAddressMode: 'own' }, organisation],
    ['the number\'s own address changes', { emergencyAddressMode: 'own', emergencyAddress: OWN_ADDRESS }, organisation],
    ['the organisation\'s address changes', {}, { id: 'org-1', address: { ...ORG_ADDRESS, thoroughfare: 'Mill Lane' } }],
    ['the organisation\'s address is removed', {}, { id: 'org-1', address: null }],
    ['the state changes', { emergencyRecordState: 'mismatch' }, organisation],
    ['the reason changes', { emergencyRecordReason: 'Postcode not valid' }, organisation],
    ['what was sent changes', { emergencyRecordSent: { ...SENT, premises: 'Unit 4' } }, organisation],
    ['the code changes', { emergencyRecordCode: 0 }, organisation],
    ['the status is read', { emergencyRecordCheckedAt: NOW }, organisation],
    ['an error is stored', { emergencyRecordError: 'Change not sent.', emergencyRecordErrorAt: NOW }, organisation],
    ['a claim is taken', { emergencyRecordClaimedUntil: NOW }, organisation],
    ['a write changes nothing else', { emergencyRecordUpdatedAt: NOW }, organisation],
  ])('changes when %s', (_what, over, org) => {
    expect(recordVersion({ ...base, ...over }, org)).not.toBe(version);
  });

  test('a number in mode own does not change when the organisation\'s address does', () => {
    const own = { ...base, emergencyAddressMode: 'own', emergencyAddress: OWN_ADDRESS };
    expect(recordVersion(own, { id: 'org-1', address: null })).toBe(recordVersion(own, organisation));
  });
});

describe('a claim', () => {
  const read = row({ emergencyRecordState: 'not_entered' });
  const expect0 = { organisationId: 'org-1', version: recordVersion(read, organisation) };
  const claimed = { ...read, emergencyRecordClaimVersion: 'c-held', emergencyRecordClaimedUntil: new Date(NOW.valueOf() + CLAIM_MS) };

  test('lasts ten minutes', () => {
    expect(CLAIM_MS).toBe(600000);
    expect(claimLive(read, NOW)).toBe(false);
    expect(claimLive(claimed, NOW)).toBe(true);
    expect(claimLive(claimed, new Date(NOW.valueOf() + CLAIM_MS - 1))).toBe(true);
    expect(claimLive(claimed, new Date(NOW.valueOf() + CLAIM_MS))).toBe(false);
  });

  test('is given for the row as it was read', () => {
    expect(checkClaim(read, organisation, expect0, NOW)).toEqual({ ok: true });
  });

  test('is refused when the row changed, moved organisation, or is held', () => {
    expect(checkClaim(read, organisation, { ...expect0, version: 'stale' }, NOW)).toMatchObject({ ok: false, code: 'changed' });
    expect(checkClaim({ ...read, organisationId: 'org-2' }, organisation, expect0, NOW)).toMatchObject({ ok: false, code: 'organisation_changed' });
    expect(checkClaim(read, organisation, undefined, NOW)).toMatchObject({ ok: false });
    // Held: refused whatever version is named, the holder's own too.
    for (const version of ['c-held', recordVersion(claimed, organisation), expect0.version]) {
      expect(checkClaim(claimed, organisation, { organisationId: 'org-1', version }, NOW)).toMatchObject({ ok: false, code: 'claimed' });
    }
  });

  test('may be taken again once its time has run out, on the row as it is then', () => {
    const later = new Date(NOW.valueOf() + CLAIM_MS + 1);
    expect(checkClaim(claimed, organisation, { organisationId: 'org-1', version: recordVersion(claimed, organisation) }, later)).toEqual({ ok: true });
    expect(checkClaim(claimed, organisation, { organisationId: 'org-1', version: 'c-held' }, later)).toMatchObject({ ok: false, code: 'changed' });
  });
});

describe('the expect check of a write', () => {
  const read = row({ emergencyRecordState: 'not_entered' });
  const current = { organisationId: 'org-1', version: recordVersion(read, organisation) };
  const claimed = { ...read, emergencyRecordClaimVersion: 'c-held', emergencyRecordClaimedUntil: new Date(NOW.valueOf() + CLAIM_MS) };
  const holder = { organisationId: 'org-1', version: 'c-held' };

  test('with no claim: the row must be as it was read', () => {
    expect(checkExpect(read, organisation, current, NOW)).toEqual({ ok: true });
    expect(checkExpect(read, organisation, { ...current, version: 'stale' }, NOW)).toMatchObject({ ok: false, code: 'changed' });
    expect(checkExpect(read, { id: 'org-1', address: OWN_ADDRESS }, current, NOW)).toMatchObject({ ok: false, code: 'changed' });
    expect(checkExpect({ ...read, organisationId: 'org-2' }, organisation, current, NOW)).toMatchObject({ ok: false, code: 'organisation_changed' });
    expect(checkExpect(read, organisation, undefined, NOW)).toMatchObject({ ok: false });
  });

  test('under a claim: the holder is taken, whatever happened to the address since', () => {
    expect(checkExpect(claimed, organisation, holder, NOW)).toEqual({ ok: true });
    expect(checkExpect(claimed, { id: 'org-1', address: OWN_ADDRESS }, holder, NOW)).toEqual({ ok: true });
    expect(checkExpect(claimed, { id: 'org-1', address: null }, holder, NOW)).toEqual({ ok: true });
  });

  test('under a claim: a number that moved organisation is refused, the holder too', () => {
    expect(checkExpect({ ...claimed, organisationId: 'org-2' }, organisation, holder, NOW)).toMatchObject({ ok: false, code: 'organisation_changed' });
  });

  test('under a claim: nobody else may write, even naming the row as it is now', () => {
    const asRead = { organisationId: 'org-1', version: recordVersion(claimed, organisation) };
    expect(checkExpect(claimed, organisation, asRead, NOW)).toMatchObject({ ok: false, code: 'claimed' });
    expect(checkExpect(claimed, organisation, current, NOW)).toMatchObject({ ok: false, code: 'claimed' });
  });

  test('after the claim\'s time: the holder is still taken until another claim or write replaces it', () => {
    const later = new Date(NOW.valueOf() + CLAIM_MS + 60000);
    expect(checkExpect(claimed, organisation, holder, later)).toEqual({ ok: true });
    // Another claim since: the first holder's version is no longer the claim's.
    const retaken = { ...claimed, emergencyRecordClaimVersion: 'c-other', emergencyRecordClaimedUntil: new Date(later.valueOf() + CLAIM_MS) };
    expect(checkExpect(retaken, organisation, holder, later)).toMatchObject({ ok: false, code: 'claimed' });
    // A write since: the claim is gone from the row.
    const written = { ...read, emergencyRecordError: 'Change not sent.' };
    expect(checkExpect(written, organisation, holder, later)).toMatchObject({ ok: false, code: 'changed' });
  });

  test('after the claim\'s time: anyone may write the row as it is now', () => {
    const later = new Date(NOW.valueOf() + CLAIM_MS + 60000);
    expect(checkExpect(claimed, organisation, { organisationId: 'org-1', version: recordVersion(claimed, organisation) }, later)).toEqual({ ok: true });
  });
});

describe('the form of a write', () => {
  test('takes the fields the sending service writes', () => {
    expect(badPatchField({
      state: 'submitted', code: null, reason: null, sent: SENT, submittedAt: NOW.toISOString(), checkedAt: NOW.toISOString(), error: null, errorAt: null,
    })).toBeNull();
    expect(badPatchField({ error: 'Change not sent.', errorAt: NOW.toISOString() })).toBeNull();
    expect(badPatchField({})).toBeNull();
  });

  test.each([
    ['state', { state: 'approved' }],
    ['code', { code: '0' }],
    ['code', { code: 1.5 }],
    ['reason', { reason: 7 }],
    ['sent', { sent: 'an address' }],
    ['sent', { sent: {} }],
    ['sent', { sent: { name: 7 } }],
    ['sent', { sent: { name: 'x'.repeat(201) } }],
    ['sent', { sent: [SENT] }],
    ['submittedAt', { submittedAt: null }],
    ['submittedAt', { submittedAt: 'yesterday' }],
    ['checkedAt', { checkedAt: 12 }],
    ['errorAt', { errorAt: 'soon' }],
    ['version', { version: 'x' }],
    ['organisationId', { organisationId: 'org-2' }],
    ['mode', { mode: 'carrier' }],
    ['address', { address: SENT }],
    ['claimedUntil', { claimedUntil: NOW.toISOString() }],
    ['stateSince', { stateSince: NOW.toISOString() }],
  ])('refuses a bad or unknown %s', (field, patch) => {
    expect(badPatchField(patch)).toBe(field);
  });

  test('refuses a body that is not an object', () => {
    for (const body of [null, undefined, 'x', [], 3]) expect(badPatchField(body)).toBe('body');
  });
});

describe('the moves the key may make', () => {
  const at = NOW.toISOString();
  const send = { state: 'submitted', code: null, reason: null, sent: SENT, error: null, errorAt: null, submittedAt: at };
  const ok = { ok: true };
  const refused = (code = 'move_not_allowed') => expect.objectContaining({ ok: false, code });

  test.each(SENDABLE_STATES)('a send from %s: submitted, refused by the first check, or held', (from) => {
    expect(checkMove(from, send)).toEqual(ok);
    expect(checkMove(from, { state: 'invalid', code: null, reason: 'The carrier\'s first check refused the address.', sent: SENT, error: null, errorAt: null })).toEqual(ok);
    expect(checkMove(from, { state: 'mismatch', code: null, reason: 'Not submitted.', error: 'Not submitted.', errorAt: at })).toEqual(ok);
  });

  test('a send needs what was sent, and a submit its time', () => {
    const { sent, ...noSent } = send;
    const { submittedAt, ...noTime } = send;
    expect(checkMove('not_entered', noSent)).toEqual(refused());
    expect(checkMove('not_entered', noTime)).toEqual(refused());
    expect(checkMove('not_entered', { state: 'invalid', code: null })).toEqual(refused());
    expect(checkMove('not_entered', { ...send, sent: null })).toEqual(refused());
    expect(checkMove('not_entered', { ...send, code: 0 })).toEqual(refused());
  });

  test('a status read of a submitted record', () => {
    const read = (state, code, extra = {}) => checkMove('submitted', { state, code, reason: null, checkedAt: at, ...extra });
    expect(read('accepted', 0)).toEqual(ok);
    expect(read('mismatch', 0)).toEqual(ok);
    expect(read('rejected', 8)).toEqual(ok);
    expect(read('draft', 1, { sent: null })).toEqual(ok);
    expect(read('not_entered', 9, { sent: null })).toEqual(ok);
    for (const code of [2, 3, 6, null]) expect(read('submitted', code)).toEqual(ok);
  });

  test('accepted is reached only from submitted with code 0', () => {
    for (const from of RECORD_STATES.filter((state) => state !== 'submitted')) {
      expect(checkMove(from, { state: 'accepted', code: 0 })).toEqual(refused());
    }
    for (const code of [null, 1, 2, 3, 6, 8, 9, 4]) {
      expect(checkMove('submitted', { state: 'accepted', code })).toEqual(refused());
    }
    expect(checkMove('submitted', { state: 'accepted' })).toEqual(refused());
  });

  test('a status read with the wrong code for its state is refused', () => {
    expect(checkMove('submitted', { state: 'rejected', code: 0 })).toEqual(refused());
    expect(checkMove('submitted', { state: 'mismatch', code: 8 })).toEqual(refused());
    expect(checkMove('submitted', { state: 'draft', code: 9, sent: null })).toEqual(refused());
    expect(checkMove('submitted', { state: 'not_entered', code: 1, sent: null })).toEqual(refused());
    expect(checkMove('submitted', { state: 'submitted', code: 8 })).toEqual(refused());
    expect(checkMove('submitted', { state: 'submitted', code: 0 })).toEqual(refused());
    expect(checkMove('submitted', { state: 'invalid', code: null, sent: SENT })).toEqual(refused());
  });

  test('what was sent is cleared only with code 1 or 9, and must be cleared then', () => {
    expect(checkMove('submitted', { state: 'draft', code: 1 })).toEqual(refused());
    expect(checkMove('submitted', { state: 'not_entered', code: 9, sent: SENT })).toEqual(refused());
    expect(checkMove('submitted', { state: 'accepted', code: 0, sent: null })).toEqual(refused());
    expect(checkMove('submitted', { state: 'submitted', code: 2, sent: null })).toEqual(refused());
    expect(checkMove('accepted', { state: 'mismatch', sent: null })).toEqual(refused());
  });

  test('the audit moves an accepted record to mismatch, with no code', () => {
    expect(checkMove('accepted', { state: 'mismatch', reason: 'The carrier holds no record.' })).toEqual(ok);
    expect(checkMove('accepted', { state: 'mismatch', code: 0 })).toEqual(refused());
    expect(checkMove('accepted', { state: 'mismatch', sent: SENT })).toEqual(refused());
  });

  test('a submit that was noted late lands on a row another send has submitted', () => {
    expect(checkMove('submitted', send)).toEqual(ok);
  });

  test('the key never writes carrier and never moves a number out of it', () => {
    for (const from of RECORD_STATES) expect(checkMove(from, { state: 'carrier' })).toEqual(refused());
    for (const state of RECORD_STATES) expect(checkMove('carrier', { state, code: 0, sent: SENT, submittedAt: at })).toEqual(refused());
  });

  test('a sendable state does not move to itself or to a state only the carrier gives', () => {
    for (const from of SENDABLE_STATES) {
      for (const state of ['not_entered', 'draft', 'accepted', 'rejected']) {
        expect(checkMove(from, { state })).toEqual(refused());
      }
    }
  });

  test('a write with no state carries only the check time and the error', () => {
    for (const from of RECORD_STATES) {
      expect(checkMove(from, { error: 'Change not sent.', errorAt: at })).toEqual(ok);
      expect(checkMove(from, { checkedAt: at })).toEqual(ok);
      expect(checkMove(from, { error: null, errorAt: null })).toEqual(ok);
      expect(checkMove(from, {})).toEqual(ok);
    }
    for (const patch of [{ code: 0 }, { reason: 'x' }, { sent: SENT }, { sent: null }, { submittedAt: at }]) {
      expect(checkMove('submitted', patch)).toEqual(refused('state_required'));
    }
  });

  test('submittedAt goes only with the state submitted', () => {
    expect(checkMove('not_entered', { state: 'invalid', code: null, sent: SENT, submittedAt: at })).toEqual(refused());
    expect(checkMove('submitted', { state: 'accepted', code: 0, submittedAt: at })).toEqual(refused());
  });
});

describe('the outside-call rule', () => {
  test('a rejected record stops calls out, and no other state does', () => {
    expect(STOPPING_STATES).toEqual(['rejected']);
    expect(recordStopsOutsideCalls('rejected')).toBe(true);
    for (const state of RECORD_STATES.filter((s) => s !== 'rejected')) expect(recordStopsOutsideCalls(state)).toBe(false);
    expect(recordStopsOutsideCalls(undefined)).toBe(false);
  });
});

describe('the service key', () => {
  test('the emergencyService role holds the records and nothing else', () => {
    expect(statementsFor('emergencyService')).toEqual({ emergencyRecord: ['read', 'update'] });
    const key = { role: 'emergencyService' };
    expect(can(key, 'emergencyRecord', 'read')).toBe(true);
    expect(can(key, 'emergencyRecord', 'update')).toBe(true);
    for (const [resource, action] of [['phoneEndpoint', 'read'], ['organisation', 'read'], ['directory', 'read'], ['call', 'read'], ['agent', 'read']]) {
      expect(can(key, resource, action)).toBe(false);
    }
  });

  test('no other role holds the records', () => {
    for (const name of Object.keys(roles).filter((role) => role !== 'emergencyService')) {
      expect({ name, statements: statementsFor(name).emergencyRecord }).toEqual({ name, statements: undefined });
    }
  });

  test('a platform operator cannot give the role, or the permission, to a user', () => {
    const operator = { role: 'superAdmin' };
    expect(actorCanGrant(operator, { role: 'emergencyService' })).toBe(false);
    expect(actorCanGrant(operator, { permissions: { emergencyRecord: ['read'] } })).toBe(false);
  });
});

describe('the schema step', () => {
  test('records are off once the boot finds the step missing', () => {
    expect(emergencyRecordsReady()).toBe(true);
    stepOff('emergencyRecords');
    expect(emergencyRecordsReady()).toBe(false);
  });
});
