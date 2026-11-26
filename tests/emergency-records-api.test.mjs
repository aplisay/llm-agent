/**
 * The emergency address record routes, as the service that sends the records
 * uses them: through the real routes, the real sign-in, and the test database.
 * Also the outside-call rule that reads the state those routes write.
 *
 * Nothing here reaches a carrier, and no test places a call.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import {
  setupRealDatabase, teardownRealDatabase, Organisation, User, PhoneNumber, AuthKey, Trunk, Agent, Instance,
} from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const tag = randomUUID().slice(0, 8);
const CARRIER = `emergency-carrier-${tag}`;
const CARRIER_2 = `emergency-carrier-two-${tag}`;
const OWN_TRUNK = `emergency-own-${tag}`;
const SHARED = `shared-${randomUUID()}`;
const CALLCTL = `callctl-${randomUUID()}`;
// Numbers of this run only: other suites share the database.
const PREFIX = `4420${String(Date.now()).slice(-5)}`;
const ddi = (n) => `${PREFIX}${String(n).padStart(3, '0')}`;

const ORG_ADDRESS = { name: 'Acme Engineering Limited', thoroughfare: 'Brunel Road', postcode: 'RG7 4AB' };
const NEWER_ADDRESS = { name: 'Acme Engineering Limited', thoroughfare: 'Mill Lane', postcode: 'LS1 4DY' };
const OWN_ADDRESS = { name: 'Acme Depot', premises: 'Unit 4', thoroughfare: 'Canal Street', postcode: 'M1 3HE' };
const SENT = { name: 'Acme Engng Ltd', thoroughfare: 'Brunel Road', postcode: 'RG7 4AB' };
const AT = '2026-11-19T02:00:00.000Z';

const listen = async (app) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
};

/**
 * The calls the sending service makes: the same paths, bodies and reading of
 * status codes as its adaptor. 404 on a read is "no longer in scope". 409 on
 * a claim is "held, or changed". Any other refusal is thrown with its status.
 */
function createStore(call, page = 200) {
  const expectOf = (row) => ({ organisationId: row.organisationId, version: row.version });
  const pathOf = (row) => `/emergency-records/${encodeURIComponent(row.number)}`;
  return {
    async list(states) {
      const out = [];
      let after = '';
      for (let pages = 0; after != null && pages < 500; pages++) {
        const res = await call(`/emergency-records?states=${states.join(',')}&after=${encodeURIComponent(after)}&limit=${page}`);
        out.push(...(res?.items ?? []));
        after = res?.next ?? null;
      }
      return out;
    },
    async read(number) {
      try {
        return await call(`/emergency-records/${encodeURIComponent(number)}`);
      } catch (e) {
        if (e?.status === 404) return null;
        throw e;
      }
    },
    async claim(row) {
      try {
        return await call(`${pathOf(row)}/claim`, { method: 'POST', body: { expect: expectOf(row) } });
      } catch (e) {
        if (e?.status === 409) return null;
        throw e;
      }
    },
    async update(row, patch) {
      await call(pathOf(row), { method: 'PUT', body: { expect: expectOf(row), ...patch } });
    },
  };
}

const SENDABLE = ['not_entered', 'draft', 'invalid', 'accepted', 'rejected', 'mismatch'];
const ALL = [...SENDABLE, 'submitted', 'carrier'];

describe('emergency address records', () => {
  let app;
  let server;
  let db;
  const saved = {};
  const orgs = {};
  const keys = {};
  const userIds = [];

  /** One request with a key. Throws for a refusal, as the service's client does. */
  const callWith = (token) => async (path, init = {}) => {
    let req = request(server)[(init.method || 'GET').toLowerCase()](`/api${path}`).set('accept', 'application/json');
    if (token) req = req.set('authorization', `Bearer ${token}`);
    for (const [name, value] of Object.entries(init.headers || {})) req = req.set(name, value);
    const res = init.body === undefined ? await req : await req.send(init.body);
    if (res.status < 200 || res.status >= 300) {
      throw Object.assign(new Error(res.body?.error || res.body?.message || `HTTP ${res.status}`), { status: res.status, code: res.body?.code, body: res.body });
    }
    return res.body;
  };
  let service;
  let store;
  const refusedWith = (status, code) => expect.objectContaining(code ? { status, code } : { status });

  const mine = (items) => items.filter((item) => item.number.startsWith(PREFIX));
  const rowOf = (number) => PhoneNumber.findOne({ where: { number, aplisayId: [CARRIER, CARRIER_2] } });
  const setRow = async (number, fields) => { await (await rowOf(number)).update(fields); };
  const setAddress = (organisationId, address) => Organisation.update({ address }, { where: { id: organisationId } });
  /** End a claim's time without waiting ten minutes. */
  const runOut = (number) => setRow(number, { emergencyRecordClaimedUntil: new Date(Date.now() - 1000) });

  let next = 100;
  /** A fresh number on the carrier's trunk, in the organisation with the phone system. */
  async function newNumber(fields = {}) {
    const number = ddi(next++);
    await PhoneNumber.create({ number, handler: 'livekit', organisationId: orgs.on, aplisayId: CARRIER, ...fields });
    return number;
  }
  const send = (extra = {}) => ({ state: 'submitted', code: null, reason: null, sent: SENT, error: null, errorAt: null, submittedAt: AT, ...extra });
  /** A number whose record was sent and is being checked by the carrier. */
  async function submittedNumber() {
    const number = await newNumber();
    await store.update(await store.claim(await store.read(number)), send());
    return number;
  }

  beforeAll(async () => {
    for (const name of ['SHARED_API_TOKEN', 'CALLCTL_SHARED_TOKEN', 'BETTER_AUTH_ENABLED', 'APLISAY_OUTBOUND_TRUNK_ID']) saved[name] = process.env[name];
    process.env.SHARED_API_TOKEN = SHARED;
    process.env.CALLCTL_SHARED_TOKEN = CALLCTL;
    process.env.BETTER_AUTH_ENABLED = 'false';
    delete process.env.APLISAY_OUTBOUND_TRUNK_ID;
    await setupRealDatabase();
    db = await import('../lib/database.js');

    const newOrg = async (name, fields = {}) => {
      const id = randomUUID();
      await Organisation.create({ id, name, ...fields });
      return id;
    };
    orgs.on = await newOrg('Emergency records, phone system', { capabilities: ['phoneSystem'], address: ORG_ADDRESS });
    orgs.second = await newOrg('Emergency records, a second organisation', { capabilities: ['phoneSystem'], address: NEWER_ADDRESS });
    orgs.bare = await newOrg('Emergency records, no address', { capabilities: ['phoneSystem'] });
    orgs.off = await newOrg('Emergency records, switched off', { address: ORG_ADDRESS });

    const newKey = async (name, role, organisationId, roleRestriction = null) => {
      const user = await User.create({
        id: randomUUID(), name, email: `${name}-${tag}@example.com`, emailVerified: true, phone: '', phoneVerified: false,
        picture: '', status: 'active', role, organisationId,
      });
      userIds.push(user.id);
      const key = `test-${name}-${randomUUID()}`;
      await AuthKey.create({ key, userId: user.id, roleRestriction, expires: new Date('2099-01-01T00:00:00Z') });
      return key;
    };
    // Minted as scripts/provision-emergency-service.mjs mints it.
    keys.service = await newKey('emergency-service', 'emergencyService', null, 'emergencyService');
    keys.owner = await newKey('owner', 'owner', orgs.on);
    keys.orgAdmin = await newKey('org-admin', 'orgAdmin', orgs.on);
    keys.operator = await newKey('operator', 'superAdmin', null);
    keys.support = await newKey('support', 'support', null);
    keys.knowledge = await newKey('knowledge', 'knowledgeService', null, 'knowledgeService');
    keys.billing = await newKey('billing', 'billingService', null, 'billingService');

    await Trunk.create({ id: CARRIER, name: 'Carrier trunk', outbound: true, flags: { provider: 'magrathea' } });
    await Trunk.create({ id: CARRIER_2, name: 'Carrier trunk, second', outbound: true, flags: { provider: 'magrathea' } });
    await Trunk.create({ id: OWN_TRUNK, name: 'A customer\'s own trunk', outbound: true });

    app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.log = log; next(); });
    const { default: initAuth } = await import('../middleware/auth.js');
    initAuth(app, log);
    // One at a time: express-openapi's own import of them all at once fails under jest.
    for (const file of [
      '../api/paths/emergency-records.js',
      '../api/paths/emergency-records/{number}.js',
      '../api/paths/emergency-records/{number}/claim.js',
      '../api/paths/agent-db/pbx/outbound-authorisation.js',
      '../api/paths/agent-db/phone-endpoints.js',
      '../api/paths/agent-db/phone-numbers.js',
      '../api/paths/phone-endpoints.js',
      '../api/paths/agents/{agentId}.js',
    ]) await import(file);
    // `agents/*.js` is agents/{agentId}.js: braces in the glob would be read as a choice.
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{emergency-records{.js,/**/*.js},agent-db/pbx/outbound-authorisation.js,agent-db/phone-endpoints.js,agent-db/phone-numbers.js,phone-endpoints.js,agents/*.js}',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    server = await listen(app);
    service = callWith(keys.service);
    store = createStore(service);
  }, 60000);

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    await db.UsageRecord.destroy({ where: { organisationId: Object.values(orgs) } });
    await db.Call.destroy({ where: { organisationId: Object.values(orgs) } });
    await PhoneNumber.destroy({ where: { aplisayId: [CARRIER, CARRIER_2, OWN_TRUNK] } });
    await AuthKey.destroy({ where: { userId: userIds } });
    await User.destroy({ where: { id: userIds } });
    await Trunk.destroy({ where: { id: [CARRIER, CARRIER_2, OWN_TRUNK] } });
    await Organisation.destroy({ where: { id: Object.values(orgs) } });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await teardownRealDatabase();
  }, 60000);

  describe('who may call', () => {
    let number;
    const routes = () => [
      ['GET', '/emergency-records?states=submitted&after=&limit=200'],
      ['GET', `/emergency-records/${number}`],
      ['POST', `/emergency-records/${number}/claim`, { expect: { organisationId: orgs.on, version: 'x' } }],
      ['PUT', `/emergency-records/${number}`, { expect: { organisationId: orgs.on, version: 'x' }, error: 'x', errorAt: AT }],
    ];
    beforeAll(async () => { number = await newNumber(); });

    test('the service key opens all four routes', async () => {
      const record = await service(`/emergency-records/${number}`);
      expect(record.number).toBe(number);
      await expect(service('/emergency-records?states=not_entered&after=&limit=200')).resolves.toHaveProperty('items');
      const claimed = await service(`/emergency-records/${number}/claim`, { method: 'POST', body: { expect: record } });
      await expect(service(`/emergency-records/${number}`, { method: 'PUT', body: { expect: claimed, error: 'Change not sent.', errorAt: AT } }))
        .resolves.toMatchObject({ number, error: 'Change not sent.' });
    });

    test.each(['owner', 'orgAdmin', 'operator', 'support', 'knowledge', 'billing'])('the %s key opens none of them', async (name) => {
      const before = await service(`/emergency-records/${number}`);
      for (const [method, path, body] of routes()) {
        await expect(callWith(keys[name])(path, { method, body })).rejects.toEqual(refusedWith(403));
      }
      expect(await service(`/emergency-records/${number}`)).toEqual(before);
    });

    test('the workers\' shared token and the call control token open none of them', async () => {
      for (const headers of [{ 'x-shared-token': SHARED }, { 'x-callctl-token': CALLCTL }]) {
        for (const [method, path, body] of routes()) {
          await expect(callWith(null)(path, { method, body, headers })).rejects.toEqual(refusedWith(403));
        }
      }
    });

    test('no key at all is refused', async () => {
      for (const [method, path, body] of routes()) {
        await expect(callWith(null)(path, { method, body })).rejects.toEqual(refusedWith(401));
      }
    });

    test('a number row sent whole by another route does not show the record', async () => {
      const shown = await newNumber({ emergencyAddressMode: 'own', emergencyAddress: OWN_ADDRESS });
      await store.update(await store.claim(await store.read(shown)), send());
      // Held, so the row has a claim's version on it as well.
      const held = await store.claim(await store.read(shown));
      const workers = callWith(null);
      const headers = { 'x-shared-token': SHARED };
      const single = (await workers(`/agent-db/phone-endpoints?type=e164-ddi&number=${shown}&trunkId=${CARRIER}`, { headers })).items[0];
      const listed = (await workers(`/agent-db/phone-numbers?number=${shown}`, { headers }))[0];
      const whole = JSON.parse(JSON.stringify(await rowOf(shown)));
      for (const row of [single, listed, whole]) {
        expect(row.number).toBe(shown);
        expect(Object.keys(row).filter((key) => /emergency/i.test(key))).toEqual([]);
        expect(JSON.stringify(row)).not.toContain(held.version);
        expect(JSON.stringify(row)).not.toContain(SENT.thoroughfare);
        expect(JSON.stringify(row)).not.toContain(OWN_ADDRESS.thoroughfare);
      }
      // The service still reads it all.
      expect(await store.read(shown)).toMatchObject({ state: 'submitted', sent: SENT, mode: 'own', address: OWN_ADDRESS });
    });

    test('an agent sent with its listeners gives a listener\'s number without the record, and logs ids only', async () => {
      const shown = await newNumber({ emergencyAddressMode: 'own', emergencyAddress: OWN_ADDRESS });
      await store.update(await store.claim(await store.read(shown)), send());
      await store.update(await store.read(shown), { state: 'rejected', code: 8, reason: 'Postcode not valid', checkedAt: AT });
      const held = await store.claim(await store.read(shown));
      const { userId } = await AuthKey.findOne({ where: { key: keys.owner } });
      const agent = await Agent.create({
        name: 'Front desk', description: 't', modelName: 'livekit:ultravox/ultravox-v0.7', prompt: 'You are a test agent.',
        options: {}, functions: {}, keys: [], userId, organisationId: orgs.on,
      });
      const listener = await Instance.create({ agentId: agent.id, type: 'livekit', key: 'k', userId, organisationId: orgs.on });
      await PhoneNumber.update({ instanceId: listener.id }, { where: { number: shown, aplisayId: CARRIER } });
      const lines = [];
      const info = log.info;
      log.info = (...args) => { lines.push(args); };
      try {
        const sent = await callWith(keys.owner)(`/agents/${agent.id}`);
        expect(sent.listeners.map((row) => row.id)).toEqual([listener.id]);
        expect(sent.listeners[0].number).toMatchObject({ number: shown, handler: 'livekit', instanceId: listener.id });
        expect(Object.keys(sent.listeners[0].number).sort())
          .toEqual(['aplisayId', 'callReceived', 'createdAt', 'handler', 'instanceId', 'number', 'outbound', 'provisioned']);
        const fetched = lines.filter((args) => args.includes('Agent fetched'));
        expect(fetched).toEqual([[{ id: agent.id, listeners: [listener.id] }, 'Agent fetched']]);
        for (const text of [JSON.stringify(sent), JSON.stringify(fetched)]) {
          for (const part of [held.version, SENT.thoroughfare, OWN_ADDRESS.thoroughfare, 'Postcode not valid']) expect(text).not.toContain(part);
        }
      } finally {
        log.info = info;
        await Agent.destroy({ where: { id: agent.id } });
      }
      // The service still reads it all.
      expect(await store.read(shown)).toMatchObject({ state: 'rejected', reason: 'Postcode not valid', mode: 'own', address: OWN_ADDRESS });
    });

    test('the service key opens nothing else', async () => {
      await expect(service('/phone-endpoints')).rejects.toEqual(refusedWith(403));
      const asCallControl = callWith(keys.service)('/agent-db/pbx/outbound-authorisation', { method: 'POST', body: { calledId: '+442079460123', organisationId: orgs.on } });
      await expect(asCallControl).rejects.toEqual(refusedWith(403));
    });
  });

  describe('listing', () => {
    const numbers = {};
    beforeAll(async () => {
      numbers.plain = await newNumber();
      numbers.own = await newNumber({ emergencyAddressMode: 'own', emergencyAddress: OWN_ADDRESS });
      numbers.ownNone = await newNumber({ emergencyAddressMode: 'own' });
      numbers.second = await newNumber({ organisationId: orgs.second });
      numbers.bare = await newNumber({ organisationId: orgs.bare });
      // Not in scope: no phone system, a customer's own trunk, and the unallocated pool.
      numbers.off = await newNumber({ organisationId: orgs.off });
      numbers.ownTrunk = await newNumber({ aplisayId: OWN_TRUNK });
      numbers.pool = await newNumber({ organisationId: null });
    });

    test('gives a number that has never had a record, in the form the service reads', async () => {
      const item = (await store.list(ALL)).find((row) => row.number === numbers.plain);
      expect(item).toEqual({
        number: numbers.plain,
        organisationId: orgs.on,
        version: expect.any(String),
        mode: 'organisation',
        address: ORG_ADDRESS,
        sent: null,
        state: 'not_entered',
        stateSince: null,
        code: null,
        reason: null,
        submittedAt: null,
        checkedAt: null,
        error: null,
        errorAt: null,
      });
    });

    test('the address in force is the number\'s own, or its organisation\'s, or none', async () => {
      const byNumber = new Map((await store.list(ALL)).map((row) => [row.number, row]));
      expect(byNumber.get(numbers.own)).toMatchObject({ mode: 'own', address: OWN_ADDRESS });
      expect(byNumber.get(numbers.ownNone)).toMatchObject({ mode: 'own', address: null });
      expect(byNumber.get(numbers.second)).toMatchObject({ organisationId: orgs.second, mode: 'organisation', address: NEWER_ADDRESS });
      expect(byNumber.get(numbers.bare)).toMatchObject({ organisationId: orgs.bare, address: null });
    });

    test('only the carrier\'s numbers, in organisations with the phone system', async () => {
      const listed = (await store.list(ALL)).map((row) => row.number);
      for (const name of ['plain', 'own', 'ownNone', 'second', 'bare']) expect(listed).toContain(numbers[name]);
      for (const name of ['off', 'ownTrunk', 'pool']) expect(listed).not.toContain(numbers[name]);
    });

    test('by state, with a number that has none read as not entered', async () => {
      const submitted = await submittedNumber();
      const inSubmitted = (await store.list(['submitted'])).map((row) => row.number);
      expect(inSubmitted).toContain(submitted);
      expect(inSubmitted).not.toContain(numbers.plain);
      const sendable = (await store.list(SENDABLE)).map((row) => row.number);
      expect(sendable).toContain(numbers.plain);
      expect(sendable).not.toContain(submitted);
      // With no states named, every state.
      const all = (await service('/emergency-records?limit=500')).items.map((row) => row.number);
      expect(all).toEqual(expect.arrayContaining([submitted, numbers.plain]));
    });

    test('pages by number: every number once, in order, whatever the page size', async () => {
      const whole = mine(await store.list(ALL));
      expect(whole.length).toBeGreaterThan(5);
      expect(whole.map((row) => row.number)).toEqual(whole.map((row) => row.number).sort());
      for (const page of [1, 2, 3, whole.length, whole.length + 1]) {
        expect(mine(await createStore(service, page).list(ALL)).map((row) => row.number)).toEqual(whole.map((row) => row.number));
      }
      const first = await service(`/emergency-records?states=${ALL.join(',')}&after=${PREFIX}&limit=2`);
      expect(first.items).toHaveLength(2);
      expect(first.next).toBe(first.items[1].number);
      const last = await service(`/emergency-records?states=${ALL.join(',')}&after=${whole[whole.length - 1].number}&limit=2`);
      expect(mine(last.items)).toEqual([]);
    });

    test('a row that changes state between two pages is neither skipped nor given twice', async () => {
      const whole = mine(await store.list(SENDABLE)).map((row) => row.number);
      const first = await service(`/emergency-records?states=${SENDABLE.join(',')}&after=${PREFIX}&limit=2`);
      // The first row of the first page leaves the list: an offset would now skip a row.
      const moved = first.items[0];
      await store.update(await store.claim(moved), send());
      const rest = mine(await createStore(async (path, init) => service(path.replace('after=', `after=${first.next}`), init)).list(SENDABLE));
      expect([...first.items, ...rest].map((row) => row.number)).toEqual(whole);
    });

    test('a row that leaves the states asked for while the list is being read is left out', async () => {
      const { listRecords } = await import('../lib/emergency-records.js');
      // The list finds its rows, then reads them. Between the two, the second row is accepted.
      const rows = [
        { id: 'a', number: '441', organisationId: 'o', emergencyRecordState: 'submitted' },
        { id: 'b', number: '442', organisationId: 'o', emergencyRecordState: 'accepted' },
      ];
      const models = {
        PhoneNumber: {
          sequelize: { QueryTypes: { SELECT: 'SELECT' }, query: async () => rows.map(({ id, number }) => ({ id, number })) },
          findAll: async () => rows,
        },
        Organisation: { findAll: async () => [{ id: 'o', address: ORG_ADDRESS }] },
      };
      const page = await listRecords({ states: ['submitted'] }, models);
      expect(page.items.map((item) => [item.number, item.state])).toEqual([['441', 'submitted']]);
      expect(page.next).toBeNull();
    });

    test('a number on two of the carrier\'s trunks is one record: the row made first', async () => {
      const number = await newNumber();
      const later = await PhoneNumber.create({ number, handler: 'livekit', organisationId: orgs.second, aplisayId: CARRIER_2 });
      // The two rows can be made in the same millisecond. Put the second one clearly after the first.
      await PhoneNumber.sequelize.query(
        `UPDATE phone_numbers SET created_at = created_at + interval '1 second' WHERE id = :id`, { replacements: { id: later.id } },
      );
      const listed = (await store.list(ALL)).filter((row) => row.number === number);
      expect(listed).toHaveLength(1);
      expect(listed[0].organisationId).toBe(orgs.on);
      expect((await store.read(number)).organisationId).toBe(orgs.on);
    });

    test('refuses a state it does not know and a page size out of range', async () => {
      await expect(service('/emergency-records?states=submitted,approved')).rejects.toEqual(refusedWith(400));
      for (const limit of ['0', '501', 'many']) {
        await expect(service(`/emergency-records?states=submitted&limit=${limit}`)).rejects.toEqual(refusedWith(400));
      }
    });
  });

  describe('reading one', () => {
    test('gives the record as it is now, with or without a plus sign', async () => {
      const number = await newNumber();
      const read = await store.read(number);
      expect(read).toMatchObject({ number, organisationId: orgs.on, state: 'not_entered', address: ORG_ADDRESS });
      expect(await store.read(`+${number}`)).toEqual(read);
    });

    test('404, read as "no longer in scope", for a number with no record here', async () => {
      const offTrunk = await newNumber({ aplisayId: OWN_TRUNK });
      const noPhoneSystem = await newNumber({ organisationId: orgs.off });
      for (const number of [offTrunk, noPhoneSystem, `${PREFIX}999`, 'not-a-number']) {
        await expect(service(`/emergency-records/${encodeURIComponent(number)}`)).rejects.toEqual(refusedWith(404, 'not_found'));
        expect(await store.read(number)).toBeNull();
      }
    });
  });

  describe('a claim', () => {
    test('gives the row with a new version, and changes nothing else', async () => {
      const number = await newNumber();
      const read = await store.read(number);
      const claimed = await store.claim(read);
      expect(claimed).toEqual({ ...read, version: expect.any(String) });
      expect(claimed.version).not.toBe(read.version);
      // What others read while it is held is not the holder's version.
      const seen = await store.read(number);
      expect(seen).toEqual({ ...read, version: expect.any(String) });
      expect([read.version, claimed.version]).not.toContain(seen.version);
    });

    test('409, read as busy, while another send holds the number', async () => {
      const number = await newNumber();
      const read = await store.read(number);
      const claimed = await store.claim(read);
      await expect(service(`/emergency-records/${number}/claim`, { method: 'POST', body: { expect: read } })).rejects.toEqual(refusedWith(409, 'claimed'));
      for (const row of [read, await store.read(number), claimed]) expect(await store.claim(row)).toBeNull();
    });

    test('409 when the row is no longer the one that was read', async () => {
      const number = await newNumber();
      const read = await store.read(number);
      await expect(service(`/emergency-records/${number}/claim`, { method: 'POST', body: { expect: { ...read, organisationId: orgs.second } } }))
        .rejects.toEqual(refusedWith(409, 'organisation_changed'));
      await setAddress(orgs.on, NEWER_ADDRESS);
      try {
        await expect(service(`/emergency-records/${number}/claim`, { method: 'POST', body: { expect: read } })).rejects.toEqual(refusedWith(409, 'changed'));
        expect(await store.claim(read)).toBeNull();
      } finally {
        await setAddress(orgs.on, ORG_ADDRESS);
      }
      // As read again, it is given.
      expect(await store.claim(await store.read(number))).not.toBeNull();
    });

    test('two claims of one number at the same instant: one is given', async () => {
      for (let round = 0; round < 12; round++) {
        const read = await store.read(await newNumber());
        const results = await Promise.all(Array.from({ length: round % 2 ? 5 : 2 }, () => store.claim(read)));
        expect(results.filter(Boolean)).toHaveLength(1);
      }
    });

    test('ends with the next write', async () => {
      const number = await newNumber();
      const claimed = await store.claim(await store.read(number));
      await store.update(claimed, { error: 'Change not sent. The carrier could not be reached.', errorAt: AT });
      const after = await store.read(number);
      expect(after).toMatchObject({ state: 'not_entered', error: 'Change not sent. The carrier could not be reached.', errorAt: AT });
      expect(await store.claim(after)).not.toBeNull();
    });

    test('ends with its time: the number can be claimed again', async () => {
      const number = await newNumber();
      const first = await store.claim(await store.read(number));
      expect(await store.claim(await store.read(number))).toBeNull();
      await runOut(number);
      const second = await store.claim(await store.read(number));
      expect(second).not.toBeNull();
      expect(second.version).not.toBe(first.version);
    });

    test('404 for a number with no record here, 400 with no expect', async () => {
      const read = await store.read(await newNumber());
      await expect(service(`/emergency-records/${PREFIX}998/claim`, { method: 'POST', body: { expect: read } })).rejects.toEqual(refusedWith(404, 'not_found'));
      await expect(service(`/emergency-records/${read.number}/claim`, { method: 'POST', body: {} })).rejects.toEqual(refusedWith(400));
      await expect(service(`/emergency-records/${read.number}/claim`, { method: 'POST', body: { expect: { organisationId: orgs.on } } })).rejects.toEqual(refusedWith(400));
    });
  });

  describe('a write', () => {
    test('a send, the carrier\'s answer, and the yearly check, in the service\'s own order', async () => {
      const number = await newNumber();
      const read = await store.read(number);
      await store.update(await store.claim(read), send());
      const submitted = await store.read(number);
      expect(submitted).toMatchObject({ state: 'submitted', sent: SENT, submittedAt: AT, code: null, error: null, address: ORG_ADDRESS });
      expect(submitted.stateSince).not.toBeNull();

      // A status read that finds it still being checked: the state has not changed.
      await store.update(submitted, { state: 'submitted', code: 2, reason: null, checkedAt: '2026-11-20T02:00:00.000Z' });
      const waiting = await store.read(number);
      expect(waiting).toMatchObject({ state: 'submitted', code: 2, checkedAt: '2026-11-20T02:00:00.000Z', stateSince: submitted.stateSince });

      await store.update(waiting, { state: 'accepted', code: 0, reason: null, checkedAt: '2026-11-21T02:00:00.000Z' });
      const accepted = await store.read(number);
      expect(accepted).toMatchObject({ state: 'accepted', code: 0, sent: SENT, submittedAt: AT });
      expect(new Date(accepted.stateSince).valueOf()).toBeGreaterThanOrEqual(new Date(submitted.stateSince).valueOf());

      await store.update(accepted, { state: 'mismatch', reason: 'The carrier holds no record.' });
      expect(await store.read(number)).toMatchObject({ state: 'mismatch', reason: 'The carrier holds no record.', sent: SENT });
    });

    test.each([
      ['rejected', 8, { reason: 'Postcode not valid' }, { state: 'rejected', reason: 'Postcode not valid', sent: SENT }],
      ['mismatch', 0, { reason: 'Accepted, but the carrier gave no record back.' }, { state: 'mismatch', sent: SENT }],
      ['draft', 1, { sent: null }, { state: 'draft', sent: null }],
      ['not_entered', 9, { sent: null }, { state: 'not_entered', sent: null, submittedAt: AT }],
    ])('a status read moves a submitted record to %s with code %i', async (state, code, extra, expected) => {
      const number = await submittedNumber();
      await store.update(await store.read(number), { state, code, reason: null, checkedAt: AT, ...extra });
      expect(await store.read(number)).toMatchObject({ ...expected, code, checkedAt: AT });
    });

    test('409 for a write that names a row that has since been written', async () => {
      const number = await newNumber();
      const read = await store.read(number);
      await store.update(read, { error: 'Change not sent. The address has no postcode.', errorAt: AT });
      await expect(store.update(read, { error: 'A second run, with what it read before.', errorAt: AT })).rejects.toEqual(refusedWith(409, 'changed'));
      expect((await store.read(number)).error).toBe('Change not sent. The address has no postcode.');
    });

    test('409 for a slow run that would write over an admin\'s newer address', async () => {
      const number = await submittedNumber();
      const read = await store.read(number);
      await setAddress(orgs.on, NEWER_ADDRESS);
      try {
        await expect(store.update(read, { state: 'accepted', code: 0, reason: null, checkedAt: AT })).rejects.toEqual(refusedWith(409, 'changed'));
        const fresh = await store.read(number);
        expect(fresh).toMatchObject({ state: 'submitted', address: NEWER_ADDRESS, sent: SENT });
        // Read again, the same write is taken.
        await store.update(fresh, { state: 'accepted', code: 0, reason: null, checkedAt: AT });
        expect((await store.read(number)).state).toBe('accepted');
      } finally {
        await setAddress(orgs.on, ORG_ADDRESS);
      }
    });

    test('two writes of one row at the same instant: one is taken', async () => {
      for (let round = 0; round < 8; round++) {
        const read = await store.read(await newNumber());
        const results = await Promise.allSettled([1, 2, 3].map((n) => store.update(read, { error: `Run ${n}`, errorAt: AT })));
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        for (const result of results.filter((r) => r.status === 'rejected')) expect(result.reason).toEqual(refusedWith(409));
      }
    });

    test('under a claim: taken although an admin saved a newer address during the send', async () => {
      const number = await newNumber();
      const claimed = await store.claim(await store.read(number));
      await setAddress(orgs.on, NEWER_ADDRESS);
      try {
        await store.update(claimed, send());
        // The submit is on the row, with what the carrier was sent, beside the newer address.
        expect(await store.read(number)).toMatchObject({ state: 'submitted', sent: SENT, address: NEWER_ADDRESS, submittedAt: AT });
      } finally {
        await setAddress(orgs.on, ORG_ADDRESS);
      }
    });

    test('under a claim: 409 when the number has moved to another organisation, and the record is the new holder\'s to start', async () => {
      const number = await newNumber();
      const read = await store.read(number);
      const claimed = await store.claim(read);
      await setRow(number, { organisationId: orgs.second });
      await expect(store.update(claimed, send())).rejects.toEqual(refusedWith(409, 'organisation_changed'));
      // What the service then does: read again, see another organisation, and stop.
      const fresh = await store.read(number);
      expect(fresh).toMatchObject({ organisationId: orgs.second, state: 'not_entered', sent: null, address: NEWER_ADDRESS });
      expect(await store.claim(read)).toBeNull();
    });

    test('while a claim is live nobody else may write, even naming the row as it is', async () => {
      const number = await newNumber();
      const before = await store.read(number);
      const claimed = await store.claim(before);
      const seen = await store.read(number);
      for (const row of [before, seen]) {
        await expect(store.update(row, { error: 'Another run.', errorAt: AT })).rejects.toEqual(refusedWith(409, 'claimed'));
      }
      await store.update(claimed, send());
      expect((await store.read(number)).state).toBe('submitted');
    });

    test('the holder\'s write is still taken after its ten minutes, if nothing came between', async () => {
      const number = await newNumber();
      const claimed = await store.claim(await store.read(number));
      await runOut(number);
      await store.update(claimed, send());
      expect(await store.read(number)).toMatchObject({ state: 'submitted', sent: SENT });
    });

    test('a holder whose claim was taken over is refused, and again while the other is live', async () => {
      const number = await newNumber();
      const first = await store.claim(await store.read(number));
      await runOut(number);
      const second = await store.claim(await store.read(number));
      await expect(store.update(first, send())).rejects.toEqual(refusedWith(409, 'claimed'));
      // The service's second try, on the row as it reads now.
      await expect(store.update(await store.read(number), send())).rejects.toEqual(refusedWith(409, 'claimed'));
      await store.update(second, send({ submittedAt: '2026-11-19T02:05:00.000Z' }));
      expect((await store.read(number)).submittedAt).toBe('2026-11-19T02:05:00.000Z');
    });

    test('a submit the carrier took is noted on the row as it is now, after a refusal', async () => {
      // The send outlived its claim, and another run wrote the row meanwhile.
      const number = await newNumber();
      const claimed = await store.claim(await store.read(number));
      await runOut(number);
      await store.update(await store.read(number), { error: 'Change not sent. The address has no postcode.', errorAt: AT });
      await expect(store.update(claimed, send())).rejects.toEqual(refusedWith(409, 'changed'));
      const fresh = await store.read(number);
      expect(fresh.organisationId).toBe(claimed.organisationId);
      await store.update(fresh, send());
      expect(await store.read(number)).toMatchObject({ state: 'submitted', sent: SENT, submittedAt: AT, error: null });
    });

    test('a held send and a failed send keep what the carrier last took', async () => {
      const number = await submittedNumber();
      await store.update(await store.read(number), { state: 'accepted', code: 0, reason: null, checkedAt: AT });
      const held = 'Not sent. The carrier holds a value this address leaves empty, and it cannot be cleared: premises.';
      await store.update(await store.claim(await store.read(number)), { state: 'mismatch', code: null, reason: held, error: held, errorAt: AT });
      expect(await store.read(number)).toMatchObject({ state: 'mismatch', reason: held, error: held, sent: SENT, code: null });
      const failed = 'Change not sent. The carrier could not be reached.';
      await store.update(await store.claim(await store.read(number)), { error: failed, errorAt: '2026-11-20T02:00:00.000Z' });
      expect(await store.read(number)).toMatchObject({ state: 'mismatch', error: failed, errorAt: '2026-11-20T02:00:00.000Z', sent: SENT });
    });

    test.each([
      ['accepted, from a number never sent', 'new', { state: 'accepted', code: 0 }],
      ['accepted, with no code', 'submitted', { state: 'accepted' }],
      ['accepted, with the code of a rejection', 'submitted', { state: 'accepted', code: 8 }],
      ['rejected, with the code of an acceptance', 'submitted', { state: 'rejected', code: 0 }],
      ['submitted, with nothing sent', 'new', { state: 'submitted', code: null, submittedAt: AT }],
      ['submitted, with no time', 'new', { state: 'submitted', code: null, sent: SENT }],
      ['what was sent cleared, with no code 1 or 9', 'submitted', { state: 'submitted', code: 2, sent: null }],
      ['draft, with what was sent kept', 'submitted', { state: 'draft', code: 1 }],
      ['a code with no state', 'submitted', { code: 0 }],
      ['what was sent with no state', 'new', { sent: SENT }],
    ])('422, and nothing written: %s', async (_what, start, patch) => {
      const number = start === 'new' ? await newNumber() : await submittedNumber();
      const read = await store.read(number);
      await expect(store.update(read, patch)).rejects.toEqual(refusedWith(422));
      expect(await store.read(number)).toEqual(read);
    });

    test('the key cannot mark a number as kept at its owner\'s carrier, nor move one out of it', async () => {
      const number = await newNumber();
      const read = await store.read(number);
      await expect(store.update(read, { state: 'carrier' })).rejects.toEqual(refusedWith(400));
      await setRow(number, { emergencyRecordState: 'carrier', emergencyAddressMode: 'carrier' });
      const kept = await store.read(number);
      expect(kept).toMatchObject({ state: 'carrier', mode: 'carrier', address: null });
      await expect(store.update(await store.claim(kept), send())).rejects.toEqual(refusedWith(422, 'move_not_allowed'));
      expect((await store.read(number)).state).toBe('carrier');
    });

    test('400 for a field the key may not write, and for a body of the wrong form', async () => {
      const number = await newNumber();
      const read = await store.read(number);
      for (const patch of [
        { mode: 'own' }, { address: OWN_ADDRESS }, { organisationId: orgs.second }, { stateSince: AT }, { claimedUntil: AT },
        { sent: 'an address' }, { sent: {} }, { code: 'zero' }, { state: 'approved' }, { checkedAt: 'yesterday' },
      ]) {
        await expect(store.update(read, patch)).rejects.toEqual(refusedWith(400));
      }
      await expect(service(`/emergency-records/${number}`, { method: 'PUT', body: { error: 'no expect' } })).rejects.toEqual(refusedWith(400));
      expect(await store.read(number)).toEqual(read);
    });

    test('404 for a number with no record here', async () => {
      const read = await store.read(await newNumber());
      await expect(store.update({ ...read, number: `${PREFIX}997` }, { error: 'x', errorAt: AT })).rejects.toEqual(refusedWith(404, 'not_found'));
    });

    test('a long reason is cut, not refused', async () => {
      const number = await submittedNumber();
      await store.update(await store.read(number), { state: 'rejected', code: 8, reason: 'x'.repeat(5000), checkedAt: AT });
      expect((await store.read(number)).reason).toHaveLength(2000);
    });
  });

  describe('a number that changes hands', () => {
    test('starts again: no state, nothing sent, and not the last holder\'s own address', async () => {
      const number = await newNumber({ emergencyAddressMode: 'own', emergencyAddress: OWN_ADDRESS });
      await store.update(await store.claim(await store.read(number)), send());
      await store.update(await store.read(number), { state: 'rejected', code: 8, reason: 'Postcode not valid', checkedAt: AT });
      expect(await store.read(number)).toMatchObject({ organisationId: orgs.on, state: 'rejected', mode: 'own', address: OWN_ADDRESS });

      await setRow(number, { organisationId: orgs.second });
      expect(await store.read(number)).toEqual({
        number,
        organisationId: orgs.second,
        version: expect.any(String),
        mode: 'organisation',
        address: NEWER_ADDRESS,
        sent: null,
        state: 'not_entered',
        stateSince: null,
        code: null,
        reason: null,
        submittedAt: null,
        checkedAt: null,
        error: null,
        errorAt: null,
      });
    });

    test('a change that does not move it leaves the record alone', async () => {
      const number = await submittedNumber();
      const before = await store.read(number);
      await setRow(number, { outbound: true });
      expect(await store.read(number)).toEqual(before);
    });
  });

  describe('the record of an emergency call that call control writes late', () => {
    test('keeps its start time and its fields, and its leg row follows', async () => {
      const { upsertCall, endCall } = await import('../lib/pbx/call-records.js');
      const startedAt = new Date(Date.now() - 15 * 60 * 1000);
      const id = randomUUID();
      const metadata = {
        direction: 'emergency', presentNumber: `+${ddi(1)}`, addressState: 'rejected', numberFrom: 'kept', sourceAddress: '192.0.2.10:5060',
      };
      const first = await upsertCall({ id, organisationId: orgs.on, callerId: '100', calledId: '999', startedAt: startedAt.toISOString(), metadata });
      expect(first.created).toBe(true);
      expect(first.call.startedAt).toEqual(startedAt);
      expect(first.call.metadata.pbx).toEqual(metadata);

      const answeredAt = new Date(startedAt.valueOf() + 4000);
      const leg = await upsertCall({ id: randomUUID(), parentId: id, organisationId: orgs.on, calledId: '999', startedAt: answeredAt.toISOString(), metadata: { kind: 'emergency' } });
      expect(leg.call).toMatchObject({ parentId: id, startedAt: answeredAt });

      // The same write sent again is one row.
      const again = await upsertCall({ id, organisationId: orgs.on, startedAt: startedAt.toISOString(), metadata: { answered: true } });
      expect(again.created).toBe(false);
      expect(again.call.metadata.pbx).toEqual({ ...metadata, answered: true });

      const ended = await endCall(id, { endedAt: new Date(startedAt.valueOf() + 60000).toISOString(), answered: true });
      expect(ended.call).toMatchObject({ duration: 60000, live: false });
    });
  });

  describe('the outside-call rule', () => {
    const DESTINATION = '+442079460123';
    let oa;
    let number;
    const decide = (extra = {}) => oa.authoriseOutboundDestination(
      { calledId: DESTINATION, organisationId: orgs.on, aplisayId: CARRIER, ...extra }, { env: {} },
    );
    const callControl = (body) => callWith(null)('/agent-db/pbx/outbound-authorisation', { method: 'POST', body, headers: { 'x-callctl-token': CALLCTL } });
    const reject = async (which) => {
      await store.update(await store.claim(await store.read(which)), send());
      await store.update(await store.read(which), { state: 'rejected', code: 8, reason: 'Postcode not valid', checkedAt: AT });
    };

    beforeAll(async () => {
      oa = await import('../lib/outbound-authorisation.js');
      number = await newNumber();
    });

    test('a call that would show a number with a rejected record is stopped, and goes again once it is sent again', async () => {
      const allowed = await decide({ presentNumber: `+${number}` });
      expect(allowed).toMatchObject({ allowed: true, code: 'ok' });

      await reject(number);
      const stopped = await decide({ presentNumber: `+${number}` });
      expect(stopped).toMatchObject({ allowed: false, code: 'emergency_record_rejected' });
      expect(stopped.reason).toContain(number);
      expect(await decide({ presentNumber: number })).toMatchObject({ allowed: false, code: 'emergency_record_rejected' });
      expect(await callControl({ calledId: DESTINATION, organisationId: orgs.on, presentNumber: `+${number}` }))
        .toMatchObject({ allowed: false, code: 'emergency_record_rejected' });

      // Corrected and sent again: calls start again at once, before the carrier has answered.
      await store.update(await store.claim(await store.read(number)), send());
      expect(await decide({ presentNumber: `+${number}` })).toEqual(allowed);
      expect(await callControl({ calledId: DESTINATION, organisationId: orgs.on, presentNumber: `+${number}` })).toMatchObject({ allowed: true });
    });

    test('no other state of the record stops a call', async () => {
      const shown = await newNumber();
      const allowed = await decide({ presentNumber: `+${shown}` });
      expect(allowed.allowed).toBe(true);
      for (const state of [null, 'not_entered', 'draft', 'invalid', 'submitted', 'accepted', 'carrier', 'mismatch']) {
        await setRow(shown, { emergencyRecordState: state });
        expect({ state, decision: await decide({ presentNumber: `+${shown}` }) }).toEqual({ state, decision: allowed });
      }
      await setRow(shown, { emergencyRecordState: 'rejected' });
      expect((await decide({ presentNumber: `+${shown}` })).code).toBe('emergency_record_rejected');
    });

    test('only the number the call shows counts, and only the organisation\'s own row for it', async () => {
      const rejected = await newNumber();
      const other = await newNumber();
      await reject(rejected);
      // Another of the organisation's numbers is shown: not stopped.
      expect(await decide({ presentNumber: `+${other}` })).toMatchObject({ allowed: true });
      // No number named: the rule does not apply.
      expect(await decide()).toMatchObject({ allowed: true });
      // The same digits asked about for another organisation.
      expect(await decide({ organisationId: orgs.second, presentNumber: `+${rejected}` })).toMatchObject({ allowed: true });
      expect(await decide({ presentNumber: `+${rejected}` })).toMatchObject({ allowed: false, code: 'emergency_record_rejected' });
    });

    test('an emergency number is never answered by this rule', async () => {
      const rejected = await newNumber();
      const clean = await newNumber();
      await reject(rejected);
      for (const calledId of ['999', '112', ' 999 ']) {
        const untouched = await decide({ calledId, presentNumber: `+${clean}` });
        const withRejected = await decide({ calledId, presentNumber: `+${rejected}` });
        expect({ calledId, decision: withRejected }).toEqual({ calledId, decision: untouched });
        expect(withRejected.code).not.toBe('emergency_record_rejected');
      }
    });

    test('what call control reads for an emergency plan is the state, and nothing is refused by it', async () => {
      const { loadSnapshot } = await import('../lib/pbx/store.js');
      const rejected = await newNumber();
      await reject(rejected);
      const snapshot = await loadSnapshot(orgs.on);
      expect(snapshot.numbers.find((row) => row.number === `+${rejected}`)).toMatchObject({ emergencyRecordState: 'rejected' });
    });
  });
});
