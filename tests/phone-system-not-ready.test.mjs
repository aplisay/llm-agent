import { jest } from '@jest/globals';

/**
 * A database without the phone system schema steps (72 and 73). lib/database.js
 * finds this at boot (lib/schema-guards.js) and switches the phone system off.
 * Its routes then answer 503 `phone_system_not_ready`, and a call to an agent
 * still resolves.
 */
const missingTable = async () => { throw new Error('relation does not exist'); };
const table = { findAll: missingTable, findOne: missingTable, findByPk: missingTable, count: missingTable, bulkCreate: missingTable };

jest.unstable_mockModule('../lib/database.js', () => ({
  Organisation: { findByPk: async (id) => ({ id, name: 'Acme', status: 'active', update: missingTable }) },
  PhoneNumber: { findOne: async () => ({ number: '442071234567', organisationId: 'o1', instanceId: 'i1' }), findAll: async () => [] },
  PhoneRegistration: { findOne: async () => null, findByPk: async () => null, findAll: async () => [] },
  Instance: { findByPk: async () => ({ id: 'i1', agentId: 'a1', type: 'pipecat', organisationId: 'o1', Agent: { id: 'a1' } }), findAll: async () => [] },
  Agent: {},
  Call: { findByPk: async () => ({ id: 'c1', organisationId: 'o1', modelName: 'telephony:pbx-call' }) },
  CallEvent: table,
  DirectoryEntry: table,
  Extension: table,
  ExtensionMember: table,
  Device: table,
  Phone: table,
  PhonePerson: table,
  PhoneRule: table,
  Line: table,
  OutboundEvent: table,
}));

const { stepOff } = await import('../lib/schema-guards.js');
const { phoneSystemReady, requirePhoneSystem } = await import('../lib/capabilities.js');
const { directoryContext } = await import('../lib/pbx/route-helpers.js');
const { resolveRequest } = await import('../lib/pbx/resolve.js');
const { addEvents } = await import('../lib/pbx/call-records.js');
const { default: capabilitiesRoute } = await import('../api/paths/organisations/{organisationId}/capabilities.js');
const { default: phoneSystemRoute } = await import('../api/paths/organisations/{organisationId}/phone-system.js');
const { default: addressesRoute } = await import('../api/paths/emergency-addresses.js');
const { default: addressRoute } = await import('../api/paths/emergency-addresses/{number}.js');

const logger = { info() {}, error() {}, debug() {}, warn() {} };
const operator = { id: 'u-op', role: 'superAdmin' };

function makeRes(user = operator) {
  const res = { locals: { user }, statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = res.send;
  return res;
}

async function call(handler, { params = {}, query = {}, body = {} } = {}) {
  const res = makeRes();
  await handler({ params, query, body, log: logger }, res);
  return res;
}

test('the phone system needs both the registrar HA1 step and its own', () => {
  expect(phoneSystemReady()).toBe(true);
  stepOff('registrarHA1');
  expect(phoneSystemReady()).toBe(false);
  stepOff('phoneSystem');
  expect(phoneSystemReady()).toBe(false);
});

describe('with the phone system off', () => {
  test('directory and phone routes answer 503 before reading anything', async () => {
    const res = makeRes();
    expect(await directoryContext({ query: {} }, res, 'directory', 'read')).toBeNull();
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('phone_system_not_ready');
  });

  test('the capability gate answers 503, not 403', () => {
    const res = makeRes();
    expect(requirePhoneSystem(res, { capabilities: ['phoneSystem'] })).toBe(false);
    expect(res.statusCode).toBe(503);
  });

  test('capabilities cannot be set, and the settings cannot be read', async () => {
    const set = await call(capabilitiesRoute(logger).PUT, { params: { organisationId: 'o1' }, body: { capabilities: ['phoneSystem'] } });
    expect(set.statusCode).toBe(503);
    expect(set.body.code).toBe('phone_system_not_ready');
    const read = await call(phoneSystemRoute(logger).GET, { params: { organisationId: 'o1' } });
    expect(read.statusCode).toBe(503);
  });

  test('the emergency address routes answer 503, not 403', async () => {
    const params = { number: '442071234567' };
    for (const res of [
      await call(addressesRoute(logger).GET),
      await call(addressRoute(logger).GET, { params }),
      await call(addressRoute(logger).PUT, { params, body: { mode: 'organisation' } }),
    ]) {
      expect({ status: res.statusCode, code: res.body.code }).toEqual({ status: 503, code: 'phone_system_not_ready' });
    }
  });

  test('call control: a number that rings an agent still resolves', async () => {
    const plan = await resolveRequest({ kind: 'number', calledNumber: '+442071234567', trunkId: 't1' });
    expect(plan).toMatchObject({ action: 'agent', organisationId: 'o1' });
  });

  test('call control: an extension, a line and call events answer 503', async () => {
    await expect(resolveRequest({ kind: 'extension', organisationId: 'o1', extensionId: 'e1' }))
      .rejects.toMatchObject({ status: 503, code: 'phone_system_not_ready' });
    await expect(resolveRequest({ kind: 'line', organisationId: 'o1', lineNumber: 1 }))
      .rejects.toMatchObject({ status: 503, code: 'phone_system_not_ready' });
    await expect(addEvents('c1', [{ id: '00000000-0000-4000-8000-000000000001', type: 'ringing', at: new Date().toISOString() }]))
      .rejects.toMatchObject({ status: 503, code: 'phone_system_not_ready' });
  });
});
