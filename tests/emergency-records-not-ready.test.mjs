import { jest } from '@jest/globals';

/**
 * A database that has not had the emergency records upgrade.
 * lib/database.js finds this at boot and switches the step off. The four
 * routes then answer 503 and read nothing. The rule for calls out needs only
 * the phone system step, which has the state column.
 */
const reads = [];
let state = 'rejected';

jest.unstable_mockModule('../lib/database.js', () => ({
  PhoneNumber: {
    sequelize: { query: async () => { reads.push('query'); return []; }, transaction: async () => { reads.push('transaction'); } },
    findOne: async (options) => { reads.push(options.where); return { number: options.where.number, emergencyRecordState: state }; },
    findByPk: async () => { reads.push('findByPk'); return null; },
  },
  Organisation: { findByPk: async () => { reads.push('organisation'); return null; } },
}));

const { stepOff } = await import('../lib/schema-guards.js');
const { shownNumberStopped } = await import('../lib/emergency-records.js');
const { default: listRoute } = await import('../api/paths/emergency-records.js');
const { default: recordRoute } = await import('../api/paths/emergency-records/{number}.js');
const { default: claimRoute } = await import('../api/paths/emergency-records/{number}/claim.js');

const logger = { info() {}, error() {}, debug() {}, warn() {} };
const service = { id: 'u-service', role: 'emergencyService', organisationId: null };
const expectAs = { organisationId: 'org-1', version: 'v' };

async function call(handler, { user = service, params = {}, query = {}, body = {} } = {}) {
  const res = { locals: { user }, statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = res.send;
  await handler({ params, query, body, log: logger }, res);
  return res;
}

describe('with the emergency records step off', () => {
  beforeAll(() => stepOff('emergencyRecords'));
  beforeEach(() => { reads.length = 0; state = 'rejected'; });

  test('the four routes answer 503 emergency_records_not_ready, and read nothing', async () => {
    const params = { number: '442079460810' };
    for (const res of [
      await call(listRoute(logger).GET, { query: { states: 'submitted', after: '', limit: 200 } }),
      await call(recordRoute(logger).GET, { params }),
      await call(claimRoute(logger).POST, { params, body: { expect: expectAs } }),
      await call(recordRoute(logger).PUT, { params, body: { expect: expectAs, error: 'x', errorAt: '2026-11-19T02:00:00.000Z' } }),
    ]) {
      expect(res.statusCode).toBe(503);
      expect(res.body.code).toBe('emergency_records_not_ready');
    }
    expect(reads).toEqual([]);
  });

  test('another key is refused before that, so the step\'s state is not shown to it', async () => {
    for (const user of [{ id: 'u-owner', role: 'owner', organisationId: 'org-1' }, { id: 'system', isSystem: true }, null]) {
      const res = await call(listRoute(logger).GET, { user });
      expect(res.statusCode).toBe(403);
    }
  });

  test('the rule for calls out still reads the state', async () => {
    const asked = { organisationId: 'org-1', presentNumber: '+442079460810', calledId: '+442079460123' };
    expect(await shownNumberStopped(asked)).toEqual({ number: '442079460810', state: 'rejected' });
    expect(reads).toEqual([{ organisationId: 'org-1', number: '442079460810' }]);
    state = 'accepted';
    expect(await shownNumberStopped(asked)).toBeNull();
  });

  test('the rule reads nothing for an emergency number, or with no number or organisation named', async () => {
    for (const asked of [
      { organisationId: 'org-1', presentNumber: '+442079460810', calledId: '999' },
      { organisationId: 'org-1', presentNumber: '+442079460810', calledId: '112' },
      { organisationId: 'org-1', presentNumber: null, calledId: '+442079460123' },
      { organisationId: null, presentNumber: '+442079460810', calledId: '+442079460123' },
    ]) expect(await shownNumberStopped(asked)).toBeNull();
    expect(reads).toEqual([]);
  });

  test('the rule is off with the phone system step off: there is no state column to read', async () => {
    stepOff('phoneSystem');
    expect(await shownNumberStopped({ organisationId: 'org-1', presentNumber: '+442079460810', calledId: '+442079460123' })).toBeNull();
    expect(reads).toEqual([]);
  });
});
