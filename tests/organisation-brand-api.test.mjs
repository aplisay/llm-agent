/**
 * Brands on organisations through the real routes and the test database: the
 * defaults a new organisation takes, a brand's service key and what it can
 * reach, and the owner's access to its own phone system settings.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import {
  setupRealDatabase,
  teardownRealDatabase,
  Organisation,
  User,
} from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

const listen = async (app) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
};

describe('brands on organisations', () => {
  let app;
  let server;
  let db;
  const stamp = String(Date.now()).slice(-6);
  const ACME = `acme-${stamp}`;
  const OTHER = `other-${stamp}`;
  const PLAIN = `plain-${stamp}`;
  const orgs = {};
  const created = [];
  const users = {};

  const call = (method) => (user, path, body) => {
    const req = request(server)[method](`/api${path}`).set('x-test-user', user);
    return body === undefined ? req : req.send(body);
  };
  const get = call('get');
  const post = call('post');
  const put = call('put');
  const patch = call('patch');

  const ok = async (pending, status = 200) => {
    const res = await pending;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  const createOrg = async (user, body, status = 201) => {
    const org = await ok(post(user, '/organisations', body), status);
    created.push(org.id);
    return org;
  };

  beforeAll(async () => {
    await setupRealDatabase();
    db = await import('../lib/database.js');

    Object.assign(users, {
      operator: { id: `operator-${stamp}`, organisationId: null, role: 'superAdmin' },
      acmeKey: { id: `acme-svc-${stamp}`, organisationId: null, role: 'brandService', _brand: ACME },
      onboarding: { id: `onboarding-${stamp}`, organisationId: null, role: 'onboardingService' },
    });

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.log = log;
      res.locals.user = users[req.headers['x-test-user']];
      next();
    });
    const routeFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) return routeFiles(path);
      return item.name.endsWith('.js') ? [path] : [];
    });
    for (const top of ['organisations', 'brands']) {
      for (const file of [`./api/paths/${top}.js`, ...routeFiles(`./api/paths/${top}`)]) await import(`.${file}`);
    }
    await import('../api/paths/me.js');
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{organisations,brands,me}{.js,/**/*.js}',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    server = await listen(app);
  }, 60000);

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    const ids = [...created, ...Object.values(orgs)];
    await User.destroy({ where: { organisationId: ids } });
    await db.AuthKey.destroy({ where: { userId: [`key-user-${stamp}`] } });
    await User.destroy({ where: { id: [`key-user-${stamp}`] } });
    await Organisation.destroy({ where: { id: ids } });
    await db.Brand.destroy({ where: { id: [ACME, OTHER, PLAIN] } });
    await teardownRealDatabase();
  }, 60000);

  describe('a platform operator', () => {
    test('creates brands with their defaults', async () => {
      expect(await ok(put('operator', `/brands/${ACME}`, { name: 'Acme', defaultCapabilities: ['phoneSystem'] }), 201))
        .toMatchObject({ id: ACME, name: 'Acme', defaultCapabilities: ['phoneSystem'] });
      await ok(put('operator', `/brands/${OTHER}`, { defaultCapabilities: ['phoneSystem'] }), 201);
      await ok(put('operator', `/brands/${PLAIN}`, {}), 201);
      expect((await put('operator', `/brands/${PLAIN}`, { defaultCapabilities: ['teleport'] })).body)
        .toMatchObject({ code: 'unknown_capability', field: 'defaultCapabilities' });
      expect((await put('operator', '/brands/Not%20A%20Slug', {})).body.code).toBe('invalid_brand');
      const listed = await ok(get('operator', '/brands'));
      expect(listed.brands.map((b) => b.id)).toEqual(expect.arrayContaining([ACME, OTHER, PLAIN]));
    });

    test('creates an organisation of a brand, which starts with its defaults', async () => {
      const acme = await createOrg('operator', { name: 'Acme customer', brand: ACME });
      expect(acme).toMatchObject({ brand: ACME, capabilities: ['phoneSystem'] });
      const plain = await createOrg('operator', { name: 'Plain customer', brand: PLAIN });
      expect(plain).toMatchObject({ brand: PLAIN, capabilities: [] });
      const none = await createOrg('operator', { name: 'No brand' });
      expect(none).toMatchObject({ brand: null, capabilities: [] });
      expect((await post('operator', '/organisations', { name: 'X', brand: 'no-such-brand' })).body.code).toBe('unknown_brand');
      Object.assign(orgs, { acmeByOperator: acme.id, plain: plain.id, none: none.id });
    });

    test('a change to the defaults leaves existing organisations alone', async () => {
      await ok(put('operator', `/brands/${PLAIN}`, { defaultCapabilities: ['phoneSystem'] }));
      expect((await Organisation.findByPk(orgs.plain)).capabilities).toEqual([]);
      const later = await createOrg('operator', { name: 'Plain later', brand: PLAIN });
      expect(later.capabilities).toEqual(['phoneSystem']);
      await ok(put('operator', `/brands/${PLAIN}`, { defaultCapabilities: [] }));
    });

    test('gives a brand to an organisation that has none, once', async () => {
      const set = await ok(patch('operator', `/organisations/${orgs.none}`, { brand: OTHER }));
      expect(set.brand).toBe(OTHER);
      // The capabilities are not changed by it.
      expect(set.capabilities).toEqual([]);
      expect((await patch('operator', `/organisations/${orgs.none}`, { brand: ACME })).body.code).toBe('brand_already_set');
      expect((await patch('operator', `/organisations/${orgs.plain}`, { brand: 'no-such-brand' })).body.code).toBe('brand_already_set');
      orgs.other = orgs.none;
      delete orgs.none;
    });
  });

  describe("a brand's service key", () => {
    test('creates organisations of its own brand only', async () => {
      const mine = await createOrg('acmeKey', { name: 'Acme signup' });
      expect(mine).toMatchObject({ brand: ACME, capabilities: ['phoneSystem'] });
      orgs.acmeByKey = mine.id;
      const same = await createOrg('acmeKey', { name: 'Acme named', brand: ACME });
      expect(same.brand).toBe(ACME);
      const refused = await post('acmeKey', '/organisations', { name: 'Elsewhere', brand: OTHER });
      expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 403, code: 'brand_not_allowed' });
    });

    test('lists and reads the organisations of its brand and no other', async () => {
      const listed = await ok(get('acmeKey', '/organisations'));
      expect(listed.organisations.every((o) => o.brand === ACME)).toBe(true);
      expect(listed.organisations.map((o) => o.id)).toEqual(expect.arrayContaining([orgs.acmeByKey, orgs.acmeByOperator]));
      // Asking for another brand still shows its own.
      const asked = await ok(get('acmeKey', `/organisations?brand=${OTHER}`));
      expect(asked.organisations.every((o) => o.brand === ACME)).toBe(true);
      expect((await get('acmeKey', `/organisations/${orgs.acmeByOperator}`)).status).toBe(200);
      for (const id of [orgs.other, orgs.plain]) expect((await get('acmeKey', `/organisations/${id}`)).status).toBe(404);
    });

    test('sets the capabilities of its own organisations only', async () => {
      expect(await ok(put('acmeKey', `/organisations/${orgs.acmeByKey}/capabilities`, { capabilities: [] }))).toEqual({ capabilities: [] });
      expect(await ok(put('acmeKey', `/organisations/${orgs.acmeByKey}/capabilities`, { capabilities: ['phoneSystem'] })))
        .toEqual({ capabilities: ['phoneSystem'] });
      for (const id of [orgs.other, orgs.plain]) {
        expect((await put('acmeKey', `/organisations/${id}/capabilities`, { capabilities: ['phoneSystem'] })).status).toBe(404);
      }
      expect((await Organisation.findByPk(orgs.plain)).capabilities).toEqual([]);
    });

    test('reads its own brand and cannot change any brand', async () => {
      expect((await ok(get('acmeKey', '/brands'))).brands.map((b) => b.id)).toEqual([ACME]);
      expect((await get('acmeKey', `/brands/${OTHER}`)).status).toBe(404);
      expect((await put('acmeKey', `/brands/${ACME}`, { defaultCapabilities: [] })).status).toBe(403);
      expect((await patch('acmeKey', `/organisations/${orgs.acmeByKey}`, { name: 'Renamed' })).status).toBe(403);
    });

    test('carries its brand from the key itself', async () => {
      const userId = `key-user-${stamp}`;
      const key = `bsvc_test_${stamp}`;
      await User.create({ id: userId, name: 'Brand service', email: `${userId}@example.invalid`, role: 'brandService', status: 'active' });
      await db.AuthKey.create({ key, userId, roleRestriction: 'brandService', brand: ACME });
      const { user } = await db.AuthKey.verify(key);
      expect(user._brand).toBe(ACME);
      expect(user._roleRestriction).toBe('brandService');
    });
  });

  describe('the onboarding service', () => {
    test('creates organisations with no brand, and cannot name one', async () => {
      const org = await createOrg('onboarding', { name: 'Signup' });
      expect(org).toMatchObject({ brand: null, capabilities: [] });
      expect((await post('onboarding', '/organisations', { name: 'Signup', brand: ACME })).body.code).toBe('brand_not_allowed');
    });
  });

  describe('an owner', () => {
    beforeAll(() => {
      users.ownerAcme = { id: `owner-acme-${stamp}`, organisationId: orgs.acmeByKey, role: 'owner' };
      users.ownerPlain = { id: `owner-plain-${stamp}`, organisationId: orgs.plain, role: 'owner' };
    });

    test('reads and changes the phone system settings of its own organisation', async () => {
      const before = await ok(get('ownerAcme', `/organisations/${orgs.acmeByKey}/phone-system`));
      expect(before).toMatchObject({ capabilities: ['phoneSystem'], busyStatusVisible: true });
      const after = await ok(put('ownerAcme', `/organisations/${orgs.acmeByKey}/phone-system`, { busyStatusVisible: false }));
      expect(after.busyStatusVisible).toBe(false);
    });

    test('is refused another organisation, and the settings without the capability', async () => {
      expect((await get('ownerAcme', `/organisations/${orgs.plain}/phone-system`)).status).toBe(404);
      expect((await put('ownerAcme', `/organisations/${orgs.plain}/phone-system`, { busyStatusVisible: false })).status).toBe(404);
      const off = await put('ownerPlain', `/organisations/${orgs.plain}/phone-system`, { busyStatusVisible: false });
      expect({ status: off.status, code: off.body.code }).toEqual({ status: 403, code: 'phone_system_disabled' });
    });

    test('cannot change the status, brand or capabilities of its organisation', async () => {
      expect((await patch('ownerAcme', `/organisations/${orgs.acmeByKey}`, { status: 'deactivated' })).status).toBe(403);
      expect((await patch('ownerPlain', `/organisations/${orgs.plain}`, { brand: OTHER })).status).toBe(403);
      expect((await put('ownerPlain', `/organisations/${orgs.plain}/capabilities`, { capabilities: ['phoneSystem'] })).status).toBe(403);
      expect((await Organisation.findByPk(orgs.acmeByKey)).status).toBe('active');
    });
  });
});
