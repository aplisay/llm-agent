import { jest } from '@jest/globals';

/**
 * A database that has not had the brand upgrade (schema 74). lib/database.js
 * finds this at boot (lib/schema-guards.js) and switches brands off. The brand
 * routes then answer 503, and everything else must work without the brand
 * columns.
 */
const calls = { findAll: [], create: [] };

jest.unstable_mockModule('../lib/database.js', () => ({
  Organisation: {
    // As lib/database.js leaves it at boot: no `brand` attribute.
    getAttributes: () => Object.fromEntries(['id', 'name', 'status', 'role', 'permissions', 'allowedModels', 'capabilities',
      'agentLimit', 'chargeableNumberLimit', 'customVoiceLimit'].map((name) => [name, {}])),
    findAll: async (opts) => { calls.findAll.push(opts); return []; },
    create: async (values) => { calls.create.push(values); return { ...values }; },
    findByPk: async (id) => ({ id, name: 'Acme', status: 'active', save: async () => {} }),
  },
  Brand: {
    findAll: async () => { throw new Error('relation "brands" does not exist'); },
    findByPk: async () => { throw new Error('relation "brands" does not exist'); },
  },
}));
jest.unstable_mockModule('../lib/rates.js', () => ({ defaultRateHistoryEntry: async () => null }));

const { stepOff } = await import('../lib/schema-guards.js');
const { brandsReady } = await import('../lib/brands.js');
const { default: organisationsRoute } = await import('../api/paths/organisations.js');
const { default: organisationRoute } = await import('../api/paths/organisations/{organisationId}.js');
const { default: brandsRoute } = await import('../api/paths/brands.js');
const { default: brandRoute } = await import('../api/paths/brands/{brandId}.js');

const logger = { info() {}, error() {}, debug() {}, warn() {} };
const operator = { id: 'u-op', role: 'superAdmin' };

async function call(handler, { user = operator, params = {}, query = {}, body = {} } = {}) {
  const res = { locals: { user }, statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = res.send;
  await handler({ params, query, body, log: logger }, res);
  return res;
}

describe('with brands off', () => {
  test('brands are on until the boot finds the step missing', () => {
    expect(brandsReady()).toBe(true);
    stepOff('brands');
    expect(brandsReady()).toBe(false);
  });

  test('the brand routes answer 503 brands_not_ready', async () => {
    for (const res of [
      await call(brandsRoute(logger).GET),
      await call(brandRoute(logger).GET, { params: { brandId: 'acme' } }),
      await call(brandRoute(logger).PUT, { params: { brandId: 'acme' }, body: { name: 'Acme' } }),
    ]) {
      expect(res.statusCode).toBe(503);
      expect(res.body.code).toBe('brands_not_ready');
    }
  });

  test('an organisation is created without a brand, and naming one gives 503', async () => {
    calls.create.length = 0;
    const plain = await call(organisationsRoute(logger).POST, { body: { name: 'Plain' } });
    expect(plain.statusCode).toBe(201);
    expect(calls.create[0]).not.toHaveProperty('brand');
    expect(calls.create[0].capabilities).toEqual([]);

    const named = await call(organisationsRoute(logger).POST, { body: { name: 'Named', brand: 'acme' } });
    expect(named.statusCode).toBe(503);
    expect(calls.create).toHaveLength(1);
  });

  test('the organisation list leaves out the brand column, and a brand filter gives 503', async () => {
    calls.findAll.length = 0;
    const res = await call(organisationsRoute(logger).GET);
    expect(res.statusCode).toBe(200);
    expect(calls.findAll[0].attributes).not.toContain('brand');
    expect((await call(organisationsRoute(logger).GET, { query: { brand: 'acme' } })).statusCode).toBe(503);
  });

  test('an organisation can be changed, but not given a brand', async () => {
    const renamed = await call(organisationRoute(logger).PATCH, { params: { organisationId: 'o1' }, body: { name: 'New' } });
    expect(renamed.statusCode).toBe(200);
    const branded = await call(organisationRoute(logger).PATCH, { params: { organisationId: 'o1' }, body: { brand: 'acme' } });
    expect(branded.statusCode).toBe(503);
    expect(branded.body.code).toBe('brands_not_ready');
  });
});
