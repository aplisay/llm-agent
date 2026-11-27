/**
 * The emergency address routes for an organisation's own users, through the
 * real routes, the real sign-in and the test database. The sending service's
 * routes are used beside them, to show what the service sees after a change.
 *
 * Nothing here reaches a carrier, and no test places a call. Emergency plans
 * are asked for, to show that a change does not touch them: a plan is an
 * answer from this server.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import {
  setupRealDatabase, teardownRealDatabase, Organisation, User, PhoneNumber, PhoneRegistration, AuthKey, Trunk,
} from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const tag = randomUUID().slice(0, 8);
const CARRIER = `address-carrier-${tag}`;
const OWN_TRUNK = `address-own-${tag}`;
const SHARED = `shared-${randomUUID()}`;
const CALLCTL = `callctl-${randomUUID()}`;
const REALM = 'sip.phones.test.example';
// Numbers of this run only: other suites share the database.
const PREFIX = `4420${String(Date.now()).slice(-5)}`;
const ddi = (n) => `${PREFIX}${String(n).padStart(3, '0')}`;

const ORG_ADDRESS = { name: 'Acme Engineering Limited', thoroughfare: 'Brunel Road', postcode: 'RG7 4AB' };
const OWN_ADDRESS = { name: 'Acme Depot', premises: 'Unit 4', thoroughfare: 'Canal Street', postcode: 'M1 3HE' };
const HOME_ADDRESS = { name: 'Priya Nair', thoroughfare: '12 Orchard Lane', locality: 'Theale, Berkshire', postcode: 'RG7 5AA' };
const AT = '2026-11-27T02:00:00.000Z';
const SENDABLE = ['not_entered', 'draft', 'invalid', 'accepted', 'rejected', 'mismatch'];
const STATE_ONLY = ['checkedAt', 'mode', 'number', 'state', 'stateSince', 'stopsCalls', 'submittedAt'];
const FULL = [...STATE_ONLY, 'address', 'addressSummary', 'code', 'error', 'errorAt', 'ownAddress', 'reason', 'sent'].sort();

const listen = async (app) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
};

const sorted = (value) => JSON.stringify(Object.fromEntries(Object.entries(value || {}).sort()));
/** What is waiting to go to the carrier, as the sending service works it out: the address in force against what was sent. */
const waiting = (row) => {
  if (row.mode === 'carrier' || !row.address) return 'none';
  if (!row.sent) return 'first';
  return sorted(row.address) === sorted(row.sent) ? 'none' : 'change';
};

describe('emergency addresses for an organisation\'s own users', () => {
  let server;
  let db;
  const saved = {};
  const orgs = {};
  const keys = {};
  const userIds = [];

  /** One request. Throws for a refusal, with its status and code. */
  const callWith = (headers) => async (path, init = {}) => {
    let req = request(server)[(init.method || 'GET').toLowerCase()](`/api${path}`).set('accept', 'application/json');
    for (const [name, value] of Object.entries(headers || {})) req = req.set(name, value);
    const res = init.body === undefined ? await req : await req.send(init.body);
    if (res.status < 200 || res.status >= 300) {
      throw Object.assign(new Error(res.body?.error || res.body?.message || `HTTP ${res.status}`), { status: res.status, code: res.body?.code, body: res.body });
    }
    return res.body;
  };
  const as = (name) => callWith({ authorization: `Bearer ${keys[name]}` });
  const refusedWith = (status, code) => expect.objectContaining(code ? { status, code } : { status });
  const put = (name, number, body, query = '') => as(name)(`/emergency-addresses/${number}${query}`, { method: 'PUT', body });

  /** The sending service's side: its own routes, with its own key. */
  const service = (path, init) => as('service')(path, init);
  const expectOf = (row) => ({ organisationId: row.organisationId, version: row.version });
  const serviceRead = (number) => service(`/emergency-records/${number}`);
  const serviceClaim = (row) => service(`/emergency-records/${row.number}/claim`, { method: 'POST', body: { expect: expectOf(row) } });
  const serviceWrite = (row, patch) => service(`/emergency-records/${row.number}`, { method: 'PUT', body: { expect: expectOf(row), ...patch } });
  /** The service sends the address in force and the carrier takes it as it is. */
  const send = async (number) => {
    const claimed = await serviceClaim(await serviceRead(number));
    return serviceWrite(claimed, { state: 'submitted', code: null, reason: null, sent: claimed.address, error: null, errorAt: null, submittedAt: AT });
  };
  const carrierSays = async (number, patch) => serviceWrite(await serviceRead(number), { checkedAt: AT, ...patch });
  /** The numbers the sending job would send on its next run. */
  const queue = async () => (await service(`/emergency-records?states=${SENDABLE.join(',')}&limit=500`)).items
    .filter((row) => row.number.startsWith(PREFIX) && waiting(row) !== 'none').map((row) => row.number);

  let next = 100;
  async function newNumber(fields = {}) {
    const number = ddi(next++);
    await PhoneNumber.create({ number, handler: 'livekit', organisationId: orgs.on, aplisayId: CARRIER, ...fields });
    return number;
  }
  /** A number whose record the carrier has accepted, holding the organisation's address. */
  async function acceptedNumber() {
    const number = await newNumber();
    await send(number);
    await carrierSays(number, { state: 'accepted', code: 0 });
    return number;
  }

  beforeAll(async () => {
    for (const name of ['SHARED_API_TOKEN', 'CALLCTL_SHARED_TOKEN', 'BETTER_AUTH_ENABLED', 'APLISAY_OUTBOUND_TRUNK_ID', 'PBX_REGISTRAR_DOMAIN', 'PBX_RELEASE']) saved[name] = process.env[name];
    process.env.SHARED_API_TOKEN = SHARED;
    process.env.CALLCTL_SHARED_TOKEN = CALLCTL;
    process.env.BETTER_AUTH_ENABLED = 'false';
    process.env.PBX_REGISTRAR_DOMAIN = REALM;
    delete process.env.APLISAY_OUTBOUND_TRUNK_ID;
    delete process.env.PBX_RELEASE;
    await setupRealDatabase();
    db = await import('../lib/database.js');

    const newOrg = async (name, fields = {}) => {
      const id = randomUUID();
      await Organisation.create({ id, name, ...fields });
      return id;
    };
    orgs.on = await newOrg('Address test, phone system', { capabilities: ['phoneSystem'], address: ORG_ADDRESS });
    orgs.second = await newOrg('Address test, a second organisation', { capabilities: ['phoneSystem'], address: HOME_ADDRESS });
    orgs.off = await newOrg('Address test, switched off', { address: ORG_ADDRESS });

    const newKey = async (name, role, organisationId, roleRestriction = null) => {
      const user = await User.create({
        id: randomUUID(), name, email: `${name}-${tag}@example.com`, emailVerified: true, phone: '', phoneVerified: false,
        picture: '', status: 'active', role, organisationId,
      });
      userIds.push(user.id);
      keys[name] = `test-${name}-${randomUUID()}`;
      await AuthKey.create({ key: keys[name], userId: user.id, roleRestriction, expires: new Date('2099-01-01T00:00:00Z') });
      return user.id;
    };
    await newKey('owner', 'owner', orgs.on);
    await newKey('orgAdmin', 'orgAdmin', orgs.on);
    await newKey('member', 'member', orgs.on);
    await newKey('ownerSecond', 'owner', orgs.second);
    await newKey('ownerOff', 'owner', orgs.off);
    await newKey('support', 'support', null);
    await newKey('operator', 'superAdmin', null);
    await newKey('service', 'emergencyService', null, 'emergencyService');
    await newKey('knowledge', 'knowledgeService', null, 'knowledgeService');
    await newKey('billing', 'billingService', null, 'billingService');

    await Trunk.create({ id: CARRIER, name: 'Carrier trunk', outbound: true, flags: { provider: 'magrathea' } });
    await Trunk.create({ id: OWN_TRUNK, name: 'A customer\'s own trunk', outbound: true });

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.log = log; next(); });
    const { default: initAuth } = await import('../middleware/auth.js');
    initAuth(app, log);
    // express-openapi imports every route file at once, which jest's module
    // loader cannot do for files that share imports. Load them one by one first.
    const routeFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) return routeFiles(path);
      return item.name.endsWith('.js') ? [path] : [];
    });
    const tops = ['emergency-addresses', 'emergency-records', 'directory', 'phones', 'phone-endpoints', 'organisations', 'agent-db/pbx'];
    for (const top of tops) {
      const files = [...(fs.existsSync(`./api/paths/${top}.js`) ? [`./api/paths/${top}.js`] : []), ...routeFiles(`./api/paths/${top}`)];
      for (const file of files) await import(`.${file}`);
    }
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: `{${tops.join(',')}}{.js,/**/*.js}`,
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    server = await listen(app);
  }, 120000);

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    const ids = Object.values(orgs);
    const where = { organisationId: ids };
    // Foreign keys between these tables do not cascade, so clear them in order.
    for (const model of ['CallEvent', 'Line', 'PhoneChange', 'PhonePerson', 'PhoneRule', 'Phone', 'Device', 'ExtensionMember']) {
      await db[model].destroy({ where });
    }
    await PhoneNumber.destroy({ where: { aplisayId: [CARRIER, OWN_TRUNK] } });
    await PhoneRegistration.destroy({ where });
    await db.Extension.destroy({ where });
    await db.DirectoryEntry.destroy({ where });
    await db.UsageRecord.destroy({ where });
    await db.Call.destroy({ where });
    await AuthKey.destroy({ where: { userId: userIds } });
    await User.destroy({ where: { id: userIds } });
    await Trunk.destroy({ where: { id: [CARRIER, OWN_TRUNK] } });
    await Organisation.destroy({ where: { id: ids } });
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await teardownRealDatabase();
  }, 60000);

  describe('who gets what', () => {
    let number;
    beforeAll(async () => {
      number = await newNumber({ emergencyAddressMode: 'own', emergencyAddress: HOME_ADDRESS });
      await send(number);
      await carrierSays(number, { state: 'rejected', code: 8, reason: 'Postcode RG7 5AA not found for 12 Orchard Lane' });
    });
    const private_ = ['Orchard', 'RG7 5AA', 'Priya', 'Brunel'];

    test('an owner and an organisation admin read the record with its addresses', async () => {
      for (const name of ['owner', 'orgAdmin']) {
        const one = await as(name)(`/emergency-addresses/${number}`);
        expect(Object.keys(one).sort()).toEqual(FULL);
        expect(one).toMatchObject({
          number, mode: 'own', state: 'rejected', stopsCalls: true, code: 8, reason: 'Postcode RG7 5AA not found for 12 Orchard Lane',
          address: HOME_ADDRESS, ownAddress: HOME_ADDRESS, sent: HOME_ADDRESS, addressSummary: 'Priya Nair, 12 Orchard Lane, RG7 5AA',
          submittedAt: AT, checkedAt: AT, error: null,
        });
        expect((await as(name)('/emergency-addresses')).items.find((row) => row.number === number)).toEqual(one);
        expect(await as(name)(`/emergency-addresses/%2B${number}`)).toEqual(one);
      }
    });

    test('a member reads the state, and no address or carrier words', async () => {
      const one = await as('member')(`/emergency-addresses/${number}`);
      expect(Object.keys(one).sort()).toEqual(STATE_ONLY);
      expect(one).toMatchObject({ number, mode: 'own', state: 'rejected', stopsCalls: true, submittedAt: AT });
      const listed = (await as('member')('/emergency-addresses')).items;
      expect(listed.find((row) => row.number === number)).toEqual(one);
      for (const text of private_) expect(JSON.stringify(listed)).not.toContain(text);
    });

    test('only an owner, an organisation admin or an operator may set it', async () => {
      const change = { mode: 'organisation' };
      await expect(put('member', number, change)).rejects.toEqual(refusedWith(403));
      await expect(put('support', number, change, `?organisationId=${orgs.on}`)).rejects.toEqual(refusedWith(403));
      for (const name of ['owner', 'orgAdmin']) {
        expect(await put(name, number, { mode: 'own' })).toMatchObject({ number, mode: 'own' });
      }
      expect(await put('operator', number, { mode: 'own' }, `?organisationId=${orgs.on}`)).toMatchObject({ number, mode: 'own' });
    });

    test('support and an operator read another organisation by naming it, and nobody else can', async () => {
      for (const name of ['support', 'operator']) {
        await expect(as(name)('/emergency-addresses')).rejects.toEqual(refusedWith(403, 'organisation_required'));
        const listed = (await as(name)(`/emergency-addresses?organisationId=${orgs.on}`)).items;
        expect(Object.keys(listed.find((row) => row.number === number)).sort()).toEqual(FULL);
        await expect(as(name)(`/emergency-addresses?organisationId=${randomUUID()}`)).rejects.toEqual(refusedWith(404, 'not_found'));
      }
      for (const name of ['ownerSecond', 'member']) {
        await expect(as(name)(`/emergency-addresses?organisationId=${name === 'member' ? orgs.second : orgs.on}`)).rejects.toEqual(refusedWith(404, 'not_found'));
      }
    });

    test('another organisation sees none of it', async () => {
      const theirs = await newNumber({ organisationId: orgs.second });
      expect((await as('ownerSecond')('/emergency-addresses')).items.map((row) => row.number)).toEqual([theirs]);
      await expect(as('ownerSecond')(`/emergency-addresses/${number}`)).rejects.toEqual(refusedWith(404, 'not_found'));
      await expect(put('ownerSecond', number, { mode: 'organisation' })).rejects.toEqual(refusedWith(404, 'not_found'));
      expect(await as('owner')(`/emergency-addresses/${number}`)).toMatchObject({ mode: 'own', address: HOME_ADDRESS });
      expect((await as('owner')('/emergency-addresses')).items.map((row) => row.number)).not.toContain(theirs);
    });

    test('a service key, the workers\' token, the call control token and no key are refused', async () => {
      const callers = [
        ...['service', 'knowledge', 'billing'].map((name) => [name, { authorization: `Bearer ${keys[name]}` }, 403]),
        ['workers', { 'x-shared-token': SHARED }, 403],
        ['call control', { 'x-callctl-token': CALLCTL }, 403],
        ['no key', {}, 401],
      ];
      for (const [who, headers, status] of callers) {
        for (const [method, path, body] of [
          ['GET', `/emergency-addresses?organisationId=${orgs.on}`],
          ['GET', `/emergency-addresses/${number}?organisationId=${orgs.on}`],
          ['PUT', `/emergency-addresses/${number}?organisationId=${orgs.on}`, { mode: 'organisation' }],
        ]) {
          const refused = await callWith(headers)(path, { method, body }).then(() => 200, (err) => err.status);
          expect({ who, method, path, refused }).toEqual({ who, method, path, refused: status });
        }
      }
      expect(await as('owner')(`/emergency-addresses/${number}`)).toMatchObject({ mode: 'own' });
    });

    test('an organisation without the phone system is refused with the phone system\'s code', async () => {
      await PhoneNumber.create({ number: ddi(900), handler: 'livekit', organisationId: orgs.off, aplisayId: CARRIER });
      await expect(as('ownerOff')('/emergency-addresses')).rejects.toEqual(refusedWith(403, 'phone_system_disabled'));
      await expect(put('ownerOff', ddi(900), { mode: 'organisation' })).rejects.toEqual(refusedWith(403, 'phone_system_disabled'));
    });
  });

  describe('the list', () => {
    test('has the organisation\'s numbers that have a record, in number order', async () => {
      const first = await newNumber();
      const own = await newNumber({ emergencyAddressMode: 'own', emergencyAddress: OWN_ADDRESS });
      const ownTrunk = await newNumber({ aplisayId: OWN_TRUNK });
      const listed = (await as('owner')('/emergency-addresses')).items;
      const numbers = listed.map((row) => row.number);
      expect(numbers).toEqual([...numbers].sort());
      expect(numbers).toEqual(expect.arrayContaining([first, own]));
      // A number on a customer's own trunk has its record at that customer's carrier.
      expect(numbers).not.toContain(ownTrunk);
      await expect(as('owner')(`/emergency-addresses/${ownTrunk}`)).rejects.toEqual(refusedWith(404, 'not_found'));

      expect(listed.find((row) => row.number === first)).toEqual({
        number: first, mode: 'organisation', state: 'not_entered', stateSince: null, submittedAt: null, checkedAt: null, stopsCalls: false,
        address: ORG_ADDRESS, addressSummary: 'Acme Engineering Limited, Brunel Road, RG7 4AB', ownAddress: null,
        sent: null, code: null, reason: null, error: null, errorAt: null,
      });
      expect(listed.find((row) => row.number === own)).toMatchObject({
        mode: 'own', address: OWN_ADDRESS, ownAddress: OWN_ADDRESS, addressSummary: 'Acme Depot, Unit 4, Canal Street, M1 3HE',
      });
      // The same numbers the sending service is given for this organisation.
      const forService = (await service(`/emergency-records?limit=500`)).items.filter((row) => row.organisationId === orgs.on).map((row) => row.number);
      expect(numbers).toEqual(forService);
    });

    test('a number that is not digits is 400, and one with no record is 404', async () => {
      await expect(as('owner')('/emergency-addresses/not-a-number')).rejects.toEqual(refusedWith(400, 'invalid_request'));
      await expect(put('owner', '44 20 7946', { mode: 'organisation' })).rejects.toEqual(refusedWith(400, 'invalid_request'));
      await expect(as('owner')(`/emergency-addresses/${PREFIX}999`)).rejects.toEqual(refusedWith(404, 'not_found'));
      await expect(put('owner', `${PREFIX}999`, { mode: 'organisation' })).rejects.toEqual(refusedWith(404, 'not_found'));
    });
  });

  describe('a change', () => {
    test('puts the record back in the sending service\'s queue, with a new version and the same state', async () => {
      const number = await acceptedNumber();
      const before = await serviceRead(number);
      expect(before).toMatchObject({ state: 'accepted', mode: 'organisation', address: ORG_ADDRESS, sent: ORG_ADDRESS });
      expect(waiting(before)).toBe('none');
      expect(await queue()).not.toContain(number);

      const set = await put('owner', number, { mode: 'own', address: OWN_ADDRESS });
      expect(set).toMatchObject({ number, mode: 'own', address: OWN_ADDRESS, ownAddress: OWN_ADDRESS, sent: ORG_ADDRESS, state: 'accepted', stopsCalls: false });

      const after = await serviceRead(number);
      expect(after).toMatchObject({ state: 'accepted', stateSince: before.stateSince, mode: 'own', address: OWN_ADDRESS, sent: ORG_ADDRESS, code: 0, submittedAt: AT });
      expect(after.version).not.toBe(before.version);
      expect(waiting(after)).toBe('change');
      expect(await queue()).toContain(number);

      // A send that read the record before the change cannot go on with the old address.
      await expect(serviceClaim(before)).rejects.toEqual(refusedWith(409, 'changed'));
      await send(number);
      const sent = await serviceRead(number);
      expect(sent).toMatchObject({ state: 'submitted', sent: OWN_ADDRESS });
      expect(waiting(sent)).toBe('none');
      expect(await as('owner')(`/emergency-addresses/${number}`)).toMatchObject({ state: 'submitted', sent: OWN_ADDRESS, address: OWN_ADDRESS });
    });

    test('of mode alone keeps the number\'s own address, and the same change twice is one change', async () => {
      const number = await acceptedNumber();
      await put('orgAdmin', number, { mode: 'own', address: OWN_ADDRESS });
      const own = await serviceRead(number);
      expect((await put('orgAdmin', number, { mode: 'own', address: OWN_ADDRESS })).mode).toBe('own');
      expect((await serviceRead(number)).version).toBe(own.version);

      const back = await put('orgAdmin', number, { mode: 'organisation' });
      expect(back).toMatchObject({ mode: 'organisation', address: ORG_ADDRESS, ownAddress: OWN_ADDRESS });
      expect(waiting(await serviceRead(number))).toBe('none');
      expect(await put('orgAdmin', number, { mode: 'own' })).toMatchObject({ mode: 'own', address: OWN_ADDRESS });
      expect(await put('orgAdmin', number, { mode: 'organisation', address: null })).toMatchObject({ mode: 'organisation', ownAddress: null });
    });

    test('keeps only the fields of an address, trimmed', async () => {
      const number = await newNumber();
      const set = await put('owner', number, {
        mode: 'own', address: { ...OWN_ADDRESS, name: '  Acme Depot  ', locality: '', title: 'Dr', businessSuffix: 'Ltd', extra: { a: 1 } },
      });
      expect(set.ownAddress).toEqual({ ...OWN_ADDRESS, businessSuffix: 'Ltd' });
    });

    test('is refused when it is not a mode and an address the record can hold', async () => {
      const number = await newNumber();
      const refusals = [
        [{}, 'invalid_request'],
        [null, undefined],
        [{ state: 'accepted' }, 'invalid_request'],
        [{ mode: 'own', sent: OWN_ADDRESS }, 'invalid_request'],
        [{ mode: 'carrier' }, 'mode_not_allowed'],
        [{ mode: 'theirs' }, 'invalid_request'],
        [{ mode: 'own' }, 'address_required'],
        [{ mode: 'own', address: null }, 'address_required'],
        // Refused by the request check before the route, so with no code.
        [{ address: 'Canal Street' }, undefined],
        [{ address: { ...OWN_ADDRESS, name: 42 } }, undefined],
        [{ address: { name: 'Acme Depot', thoroughfare: 'Canal Street' } }, 'invalid_address'],
        [{ address: { name: 'Acme Depot', postcode: 'M1 3HE' } }, 'invalid_address'],
      ];
      for (const [body, code] of refusals) {
        const refused = await put('owner', number, body).then(() => null, (err) => ({ status: err.status, code: err.code }));
        expect({ body, refused }).toEqual({ body, refused: { status: 400, code } });
      }
      expect(await serviceRead(number)).toMatchObject({ mode: 'organisation', address: ORG_ADDRESS, state: 'not_entered' });

      // A number in mode own cannot lose its address.
      await put('owner', number, { mode: 'own', address: OWN_ADDRESS });
      await expect(put('owner', number, { address: null })).rejects.toEqual(refusedWith(400, 'address_required'));
      expect(await serviceRead(number)).toMatchObject({ mode: 'own', address: OWN_ADDRESS });
    });

    test('does not move a rejected record, and calls out stay stopped until the service sends it again', async () => {
      const oa = await import('../lib/outbound-authorisation.js');
      const decide = (number) => oa.authoriseOutboundDestination(
        { calledId: '+442079460123', organisationId: orgs.on, aplisayId: CARRIER, presentNumber: `+${number}` }, { env: {} },
      );
      const number = await newNumber();
      await send(number);
      await carrierSays(number, { state: 'rejected', code: 8, reason: 'Postcode not valid' });
      expect(await decide(number)).toMatchObject({ allowed: false, code: 'emergency_record_rejected' });

      const set = await put('owner', number, { mode: 'own', address: OWN_ADDRESS });
      expect(set).toMatchObject({ state: 'rejected', stopsCalls: true, reason: 'Postcode not valid', address: OWN_ADDRESS, sent: ORG_ADDRESS });
      expect(await decide(number)).toMatchObject({ allowed: false, code: 'emergency_record_rejected' });
      expect(await queue()).toContain(number);

      await send(number);
      expect(await as('owner')(`/emergency-addresses/${number}`)).toMatchObject({ state: 'submitted', stopsCalls: false, sent: OWN_ADDRESS });
      expect(await decide(number)).toMatchObject({ allowed: true });
    });

    test('made while a send holds the number is kept, and so is the send', async () => {
      const number = await newNumber();
      const claimed = await serviceClaim(await serviceRead(number));
      await put('owner', number, { mode: 'own', address: OWN_ADDRESS });
      // The carrier has taken the address the send read. The newer one waits.
      await serviceWrite(claimed, { state: 'submitted', code: null, reason: null, sent: ORG_ADDRESS, error: null, errorAt: null, submittedAt: AT });
      expect(await as('owner')(`/emergency-addresses/${number}`)).toMatchObject({ state: 'submitted', mode: 'own', address: OWN_ADDRESS, sent: ORG_ADDRESS });
      await carrierSays(number, { state: 'accepted', code: 0 });
      expect(await queue()).toContain(number);
    });

    test('is logged with no address', async () => {
      const number = await newNumber();
      const lines = [];
      const info = log.info;
      log.info = (...args) => { lines.push(args); };
      try {
        await put('owner', number, { mode: 'own', address: HOME_ADDRESS });
      } finally {
        log.info = info;
      }
      const audit = lines.filter(([fields]) => fields?.audit === 'emergency-address-set');
      expect(audit).toHaveLength(1);
      expect(audit[0][0]).toMatchObject({ number, organisationId: orgs.on, mode: 'own', fields: ['mode', 'address'] });
      for (const text of ['Orchard', 'RG7', 'Priya']) expect(JSON.stringify(lines)).not.toContain(text);
    });

    test('of the organisation\'s address shows on every number that uses it, and on no other', async () => {
      const uses = await acceptedNumber();
      const own = await newNumber({ emergencyAddressMode: 'own', emergencyAddress: OWN_ADDRESS });
      const moved = { ...ORG_ADDRESS, thoroughfare: 'Mill Lane' };
      await as('orgAdmin')(`/organisations/${orgs.on}/phone-system`, { method: 'PUT', body: { address: moved } });
      try {
        expect(await as('owner')(`/emergency-addresses/${uses}`)).toMatchObject({ address: moved, sent: ORG_ADDRESS, state: 'accepted' });
        expect(await as('owner')(`/emergency-addresses/${own}`)).toMatchObject({ address: OWN_ADDRESS });
        expect(await queue()).toContain(uses);
      } finally {
        await as('orgAdmin')(`/organisations/${orgs.on}/phone-system`, { method: 'PUT', body: { address: ORG_ADDRESS } });
      }
    });
  });

  describe('an emergency plan', () => {
    let username;
    let number;
    const plan = async (digits) => {
      const { planId, ...rest } = await callWith({ 'x-callctl-token': CALLCTL })(
        '/agent-db/pbx/resolve', { method: 'POST', body: { request: { kind: 'dialled', fromEndpoint: username, digits } } },
      );
      expect(planId).toEqual(expect.any(String));
      return rest;
    };

    beforeAll(async () => {
      number = await newNumber();
      const owner = as('owner');
      const { entry } = await owner('/directory/entries', { method: 'POST', body: { kind: 'person', name: 'Priya Nair' } });
      const { extension } = await owner('/directory/extensions', { method: 'POST', body: { number: '201', type: 'ring_all', entryId: entry.id } });
      const { phone } = await owner('/phones', {
        method: 'POST', body: { kind: 'deskphone', mac: `000413${String(Date.now()).slice(-6)}`, model: '710', label: 'Priya desk', people: [entry.id] },
      });
      await owner(`/phone-endpoints/${number}`, { method: 'PUT', body: { extensionId: extension.id } });
      const line = await db.Line.findByPk(phone.lines[0].id);
      username = (await PhoneRegistration.findByPk(line.endpointId)).username;
    }, 60000);

    test('for 999 and 112 is the same before and after every kind of change, in every state of the record', async () => {
      const row = () => PhoneNumber.findOne({ where: { number, aplisayId: CARRIER } });
      for (const state of ['not_entered', 'draft', 'invalid', 'submitted', 'accepted', 'rejected', 'mismatch']) {
        await (await row()).update({ emergencyRecordState: state, emergencyAddressMode: 'organisation', emergencyAddress: null });
        const before = { 999: await plan('999'), 112: await plan('112') };
        expect(before[999]).toMatchObject({
          action: 'emergency', organisationId: orgs.on, emergency: { number: '999', presentNumber: `+${number}`, addressState: state },
        });
        expect(before[112]).toMatchObject({ action: 'emergency', emergency: { number: '112', presentNumber: `+${number}`, addressState: state } });

        for (const change of [
          { mode: 'own', address: HOME_ADDRESS },
          { address: OWN_ADDRESS },
          { mode: 'organisation' },
          { mode: 'own' },
          { mode: 'organisation', address: null },
        ]) {
          await put('owner', number, change);
          for (const digits of ['999', '112']) {
            expect({ state, change, digits, plan: await plan(digits) }).toEqual({ state, change, digits, plan: before[digits] });
          }
        }
        expect((await row()).emergencyRecordState).toBe(state);
      }
    });
  });
});
