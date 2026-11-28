/**
 * A key's roleRestriction narrows the key whoever owns it, a bootstrap
 * super-admin (ADMIN_USER_IDS) too. Through the real auth middleware, real
 * keys and real routes, against the test database.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import {
  setupRealDatabase, teardownRealDatabase, Organisation, User, AuthKey,
} from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const PHONE_AND_DIRECTORY = { phone: ['read'], directory: ['read', 'lookup', 'readAll'] };
const ADMIN_ROUTES = ['/organisations', '/rates', '/trunks', '/users'];

describe('a restricted key of a bootstrap super-admin', () => {
  const stamp = `${Date.now()}`.slice(-6);
  const saved = {};
  const userIds = [];
  const orgs = {};
  const keys = {};
  const ids = {
    boot: `kr-boot-${stamp}`,
    bootInOrg: `kr-boot-org-${stamp}`,
  };
  let server;
  let statementsFor;

  const as = (key) => (path) => request(server).get(`/api${path}`).set('Authorization', `Bearer ${key}`);
  const me = async (key) => {
    const res = await as(key)('/me');
    expect(res.status).toBe(200);
    return res.body;
  };

  beforeAll(async () => {
    for (const name of ['ADMIN_USER_IDS', 'SHARED_API_TOKEN']) saved[name] = process.env[name];
    // lib/admin-gate.js reads the allowlist when it is first imported, below.
    process.env.ADMIN_USER_IDS = `${ids.boot},${ids.bootInOrg}`;
    process.env.SHARED_API_TOKEN = `kr-shared-${randomUUID()}`;
    await setupRealDatabase();
    ({ statementsFor } = await import('../lib/auth/permissions.js'));

    const newOrg = async (name, fields = {}) => {
      const id = randomUUID();
      await Organisation.create({ id, name, status: 'active', ...fields });
      return id;
    };
    orgs.target = await newOrg(`Key restriction target ${stamp}`, { capabilities: ['phoneSystem'] });
    orgs.home = await newOrg(`Key restriction home ${stamp}`, { capabilities: ['phoneSystem'] });

    const newUser = async (id, role, organisationId = null) => {
      await User.create({
        id, name: id, email: `${id}@key-restriction.example.com`, emailVerified: true, phone: '', phoneVerified: false,
        picture: '', status: 'active', role, organisationId,
      });
      userIds.push(id);
      return id;
    };
    const newKey = async (userId, roleRestriction) => {
      const key = `kr-${randomUUID()}`;
      await AuthKey.create({ key, userId, roleRestriction, expires: new Date('2099-01-01T00:00:00Z') });
      return key;
    };
    // An owner by stored role: the allowlist, not the role, makes these super-admins.
    await newUser(ids.boot, 'owner');
    await newUser(ids.bootInOrg, 'owner', orgs.home);
    const bySuperRole = await newUser(`kr-super-${stamp}`, 'superAdmin');

    keys.bootFull = await newKey(ids.boot, null);
    keys.bootNarrow = await newKey(ids.boot, PHONE_AND_DIRECTORY);
    keys.bootNamedRole = await newKey(ids.boot, 'knowledgeService');
    keys.bootLegacy = await newKey(ids.boot, { join: true });
    keys.bootInOrgFull = await newKey(ids.bootInOrg, null);
    keys.bootInOrgNarrow = await newKey(ids.bootInOrg, PHONE_AND_DIRECTORY);
    keys.superNarrow = await newKey(bySuperRole, PHONE_AND_DIRECTORY);
    keys.bootEmpty = await newKey(ids.boot, {});
    keys.superEmpty = await newKey(bySuperRole, {});
    keys.superFull = await newKey(bySuperRole, null);

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.log = log; next(); });
    const { default: initAuth } = await import('../middleware/auth.js');
    initAuth(app, log);
    // One at a time: express-openapi's own import of them all at once fails under jest.
    for (const file of [
      '../api/paths/organisations.js',
      '../api/paths/rates.js',
      '../api/paths/trunks.js',
      '../api/paths/users.js',
      '../api/paths/me.js',
      '../api/paths/directory/entries.js',
    ]) await import(file);
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{organisations.js,rates.js,trunks.js,users.js,me.js,directory/entries.js}',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
  }, 60000);

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await AuthKey.destroy({ where: { userId: userIds } });
    await User.destroy({ where: { id: userIds } });
    await Organisation.destroy({ where: { id: Object.values(orgs) } });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await teardownRealDatabase();
  }, 60000);

  test('an unrestricted key of a bootstrap super-admin has the whole super-admin role', async () => {
    for (const path of ADMIN_ROUTES) expect([path, (await as(keys.bootFull)(path)).status]).toEqual([path, 200]);
    const body = await me(keys.bootFull);
    expect(body.permissions).toEqual(statementsFor('superAdmin'));
    expect(body).toMatchObject({ isAdmin: true, isSuperAdmin: true, allowedModels: null });
  });

  test('a key restricted to phone and directory reads none of the admin routes', async () => {
    for (const path of ADMIN_ROUTES) expect([path, (await as(keys.bootNarrow)(path)).status]).toEqual([path, 403]);
    const body = await me(keys.bootNarrow);
    expect(body.permissions).toEqual(PHONE_AND_DIRECTORY);
    expect(body).toMatchObject({ isAdmin: false, isSuperAdmin: false, allowedModels: null });
  });

  test('the restricted key keeps what its restriction names, across organisations', async () => {
    expect((await as(keys.bootNarrow)(`/directory/entries?organisationId=${orgs.target}`)).status).toBe(200);
  });

  test('a key restricted to a named role has that role, within the super-admin role', async () => {
    expect((await as(keys.bootNamedRole)('/organisations')).status).toBe(403);
    expect((await me(keys.bootNamedRole)).permissions).toEqual({ directory: ['read', 'update', 'lookup', 'readAll'] });
  });

  test('an empty restriction gives a key no permissions, whoever owns it', async () => {
    for (const key of [keys.bootEmpty, keys.superEmpty]) {
      for (const path of ADMIN_ROUTES) expect([path, (await as(key)(path)).status]).toEqual([path, 403]);
      const body = await me(key);
      expect(body.permissions).toEqual({});
      expect(body).toMatchObject({ isAdmin: false, isSuperAdmin: false });
    }
  });

  test('a key with no restriction keeps its owner\'s whole role', async () => {
    for (const path of ADMIN_ROUTES) expect([path, (await as(keys.superFull)(path)).status]).toEqual([path, 200]);
    expect((await me(keys.superFull)).permissions).toEqual(statementsFor('superAdmin'));
  });

  test('a legacy restriction is still no restriction', async () => {
    expect((await as(keys.bootLegacy)('/organisations')).status).toBe(200);
  });

  test('it is narrowed exactly as a restricted key of a super-admin by role', async () => {
    for (const path of ADMIN_ROUTES) expect([path, (await as(keys.superNarrow)(path)).status]).toEqual([path, 403]);
    expect((await me(keys.superNarrow)).permissions).toEqual((await me(keys.bootNarrow)).permissions);
  });

  test('without organisation:readAll, the owner\'s own organisation must be active', async () => {
    await Organisation.update({ status: 'deactivated' }, { where: { id: orgs.home } });
    try {
      const narrow = await as(keys.bootInOrgNarrow)('/me');
      expect(narrow.status).toBe(403);
      expect(narrow.body.message).toBe('organisation_inactive');
      expect((await as(keys.bootInOrgFull)('/me')).status).toBe(200);
    } finally {
      await Organisation.update({ status: 'active' }, { where: { id: orgs.home } });
    }
  });

  test('the shared token is unchanged', async () => {
    for (const path of ['/organisations', '/rates', '/trunks?scope=all', '/users']) {
      const res = await request(server).get(`/api${path}`).set('x-shared-token', process.env.SHARED_API_TOKEN);
      expect([path, res.status]).toEqual([path, 200]);
    }
  });
});
