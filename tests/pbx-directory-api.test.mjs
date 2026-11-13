/**
 * The directory, phones, worked-out lines and number routing of the phone
 * system, through the real routes and the test database.
 */
import { randomUUID, createHash } from 'node:crypto';
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
  Agent,
  Instance,
  PhoneNumber,
  PhoneRegistration,
} from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const REALM = 'sip.phones.test.example';
const TRUNK = `pbx-test-trunk-${randomUUID().slice(0, 8)}`;

// One server for the whole suite, bound to 127.0.0.1. Left to itself supertest
// opens a server on a wildcard port for each request, and on macOS a request
// can then land on another jest worker's server that holds the same port
// number on 127.0.0.1.
const listen = async (app) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
};

describe('phone system directory API', () => {
  let app;
  let server;
  let db;
  let savedEnv;
  const users = {};
  const orgs = {};
  // Numbers unique to this run, so a re-run on a kept database cannot clash.
  const stamp = String(Date.now()).slice(-6);
  const ddi = (n) => `4420794${stamp.slice(0, 2)}${String(n).padStart(3, '0')}`;
  const mac = (n) => `000413${stamp.slice(-4)}${String(n).padStart(2, '0')}`;

  const call = (method) => (user, path, body) => {
    const req = request(server)[method](`/api${path}`).set('x-test-user', user);
    return body === undefined ? req : req.send(body);
  };
  const get = call('get');
  const post = call('post');
  const put = call('put');
  const patch = call('patch');
  const del = call('delete');

  const ok = async (pending, status = 200) => {
    const res = await pending;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };

  async function newOrg(name, capabilities = []) {
    const id = randomUUID();
    await Organisation.create({ id, name, capabilities });
    return id;
  }

  const person = async (user, name, number) => {
    const { entry } = await ok(post(user, '/directory/entries', { kind: 'person', name }), 201);
    if (!number) return { entry };
    const { extension } = await ok(post(user, '/directory/extensions', { number, type: 'ring_all', entryId: entry.id }), 201);
    return { entry, extension };
  };
  const team = async (user, name, number, members = []) => {
    const { entry } = await ok(post(user, '/directory/entries', { kind: 'team', name }), 201);
    const { extension } = await ok(post(user, '/directory/extensions', { number, type: 'ring_all', entryId: entry.id, members }), 201);
    return { entry, extension };
  };
  const deskphone = async (user, n, label, people) => (await ok(post(user, '/phones', {
    kind: 'deskphone', mac: mac(n), model: '710', label, people,
  }), 201)).phone;
  const keys = (phone) => phone.lines.map((line) => (line.kind === 'other' ? `other(${line.covers.length})` : line.number));

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.PBX_REGISTRAR_DOMAIN = REALM;
    delete process.env.PBX_RELEASE;
    await setupRealDatabase();
    db = await import('../lib/database.js');

    orgs.a = await newOrg('Phone system test A', ['phoneSystem']);
    orgs.b = await newOrg('Phone system test B', ['phoneSystem']);
    orgs.off = await newOrg('Phone system test, switched off');
    Object.assign(users, {
      ownerA: { id: `owner-a-${stamp}`, organisationId: orgs.a, role: 'owner' },
      memberA: { id: `member-a-${stamp}`, organisationId: orgs.a, role: 'member' },
      ownerB: { id: `owner-b-${stamp}`, organisationId: orgs.b, role: 'owner' },
      ownerOff: { id: `owner-off-${stamp}`, organisationId: orgs.off, role: 'owner' },
      // Organisation settings need an organisation admin.
      adminA: { id: `admin-a-${stamp}`, organisationId: orgs.a, role: 'orgAdmin' },
      adminB: { id: `admin-b-${stamp}`, organisationId: orgs.b, role: 'orgAdmin' },
      adminOff: { id: `admin-off-${stamp}`, organisationId: orgs.off, role: 'orgAdmin' },
      operator: { id: `operator-${stamp}`, organisationId: null, role: 'superAdmin' },
    });
    await db.Trunk.create({ id: TRUNK, name: 'Phone system test trunk', handler: 'livekit' });
    for (const n of [1, 2, 3, 4, 5]) {
      await PhoneNumber.create({ number: ddi(n), handler: 'livekit', organisationId: orgs.a, aplisayId: TRUNK });
    }
    await PhoneNumber.create({ number: ddi(9), handler: 'livekit', organisationId: orgs.off, aplisayId: TRUNK });

    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.log = log;
      res.locals.user = users[req.headers['x-test-user']];
      next();
    });
    // express-openapi imports every route file at once, which jest's module
    // loader cannot do for files that share imports. Load them one by one first.
    const routeFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) return routeFiles(path);
      return item.name.endsWith('.js') ? [path] : [];
    });
    for (const top of ['directory', 'phones', 'phone-endpoints', 'organisations', 'agent-db/pbx']) {
      const files = [...(fs.existsSync(`./api/paths/${top}.js`) ? [`./api/paths/${top}.js`] : []), ...routeFiles(`./api/paths/${top}`)];
      for (const file of files) await import(`.${file}`);
    }
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{directory,phones,phone-endpoints,organisations,agent-db/pbx}{.js,/**/*.js}',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    server = await listen(app);
  }, 60000);

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    const ids = Object.values(orgs);
    const where = { organisationId: ids };
    // Foreign keys between these tables do not cascade, so clear them in order.
    for (const model of ['CallEvent', 'Line', 'PhoneChange', 'PhonePerson', 'PhoneRule', 'Phone', 'Device', 'ExtensionMember']) {
      await db[model].destroy({ where });
    }
    await PhoneNumber.destroy({ where });
    await PhoneRegistration.destroy({ where });
    await db.Extension.destroy({ where });
    await db.DirectoryEntry.destroy({ where });
    await db.Call.destroy({ where });
    await Instance.destroy({ where });
    await Agent.destroy({ where });
    await User.destroy({ where });
    await db.Trunk.destroy({ where: { id: TRUNK } });
    await Organisation.destroy({ where: { id: ids } });
    process.env = savedEnv;
    await teardownRealDatabase();
  }, 60000);

  describe('an organisation without the phone system', () => {
    test('keeps the directory and extensions on its own phone system', async () => {
      const { entry } = await ok(post('ownerOff', '/directory/entries', { kind: 'person', name: '  Dana   Price ', extension: '310', mobile: '07700 900310' }), 201);
      expect(entry).toMatchObject({ name: 'Dana Price', extension: '310', extensionType: 'connection', mobile: '+447700900310' });
      expect(entry.onPhoneSystem).toBeUndefined();
      const listed = await ok(get('ownerOff', '/directory/entries'));
      expect(listed.entries.map((e) => e.name)).toEqual(['Dana Price']);
      const renumbered = await ok(patch('ownerOff', `/directory/entries/${entry.id}`, { extension: '311', department: 'Sales' }));
      expect(renumbered.entry).toMatchObject({ extension: '311', department: 'Sales' });
      expect((await ok(get('ownerOff', '/directory/extensions'))).extensions).toHaveLength(1);
    });

    test('is refused every phone system request with one stable code', async () => {
      const { entry } = await ok(post('ownerOff', '/directory/entries', { kind: 'team', name: 'Front desk' }), 201);
      const refused = [
        await post('ownerOff', '/directory/extensions', { number: '200', type: 'ring_all', entryId: entry.id }),
        await post('ownerOff', '/directory/entries', { kind: 'person', name: 'Sam', extension: '104', extensionType: 'ring_all' }),
        await get('ownerOff', '/phones'),
        await post('ownerOff', '/phones', { kind: 'deskphone', mac: mac(90), model: '710', label: 'Desk', people: [] }),
        await put('ownerOff', `/directory/entries/${entry.id}/key-order`, { extensionIds: [] }),
        await put('ownerOff', `/phone-endpoints/${ddi(9)}`, { extensionId: randomUUID() }),
        await put('adminOff', `/organisations/${orgs.off}/phone-system`, { busyStatusVisible: false }),
      ];
      for (const res of refused) {
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'phone_system_disabled' });
      }
      expect(refused[0].body.field).toBe('type');
      // A refused create leaves nothing behind.
      expect((await ok(get('ownerOff', '/directory/entries'))).entries.map((e) => e.name)).not.toContain('Sam');
    });

    test('only a platform operator can switch it on', async () => {
      expect((await put('ownerOff', `/organisations/${orgs.off}/capabilities`, { capabilities: ['phoneSystem'] })).status).toBe(403);
      expect((await put('operator', `/organisations/${orgs.off}/capabilities`, { capabilities: ['teleport'] })).status).toBe(400);
      expect((await get('ownerOff', `/organisations/${orgs.off}/phone-system`)).status).toBe(403);
      const before = await ok(get('adminOff', `/organisations/${orgs.off}/phone-system`));
      expect(before.capabilities).toEqual([]);
      await ok(put('operator', `/organisations/${orgs.off}/capabilities`, { capabilities: ['phoneSystem'] }));
      // The switch takes effect on the next request.
      expect((await get('ownerOff', '/phones')).status).toBe(200);
      await ok(put('operator', `/organisations/${orgs.off}/capabilities`, { capabilities: [] }));
      expect((await get('ownerOff', '/phones')).status).toBe(403);
    });
  });

  describe('two users who both belong to Sales', () => {
    const made = {};

    beforeAll(async () => {
      made.rob = await person('ownerA', 'Rob Parkinson', '100');
      made.priya = await person('ownerA', 'Priya Nair', '101');
      made.sales = await team('ownerA', 'Sales', '200', [made.rob.entry.id, made.priya.entry.id]);
      made.robDesk = await deskphone('ownerA', 1, 'Rob desk', [made.rob.entry.id]);
      made.priyaDesk = await deskphone('ownerA', 2, 'Priya desk', [made.priya.entry.id]);
      await ok(put('ownerA', `/phone-endpoints/${ddi(1)}`, { extensionId: made.rob.extension.id }));
      await ok(put('ownerA', `/phone-endpoints/${ddi(2)}`, { extensionId: made.priya.extension.id }));
      await ok(put('ownerA', `/phone-endpoints/${ddi(3)}`, { extensionId: made.sales.extension.id }));
    }, 60000);

    const resolve = async (body) => ok(post('ownerA', '/agent-db/pbx/resolve', { callId: randomUUID(), request: body }));
    const lineOn = (phone, number) => phone.lines.find((line) => line.number === number);
    const usernameOf = async (line) => (await PhoneRegistration.findByPk((await db.Line.findByPk(line.id)).endpointId)).username;

    test('each phone gets its own extension on key 1 and Sales on key 2', async () => {
      expect(keys(made.robDesk)).toEqual(['100', '200']);
      expect(keys(made.priyaDesk)).toEqual(['101', '200']);
      expect(made.robDesk.lines.map((line) => line.label)).toEqual(['Rob P. 100', 'Sales']);
      expect(made.robDesk).toMatchObject({ capacity: 4, maxPeople: 3, roomForPerson: true });
      const numbers = [...made.robDesk.lines, ...made.priyaDesk.lines].map((line) => line.lineNumber);
      expect(new Set(numbers).size).toBe(4);
      expect(Math.min(...numbers)).toBeGreaterThanOrEqual(100000);
      // A line read never shows its SIP account.
      expect(JSON.stringify(made.robDesk)).not.toMatch(/username|password|ha1/);
      const rob = await ok(get('ownerA', `/directory/entries/${made.rob.entry.id}`));
      expect(rob).toMatchObject({ onPhoneSystem: true, extensionType: 'ring_all' });
      expect(rob.memberships.map((m) => m.number)).toEqual(['200']);
      expect(rob.phones.map((p) => p.label)).toEqual(['Rob desk']);
    });

    test('each line has a SIP account of its own that only its phone shows', async () => {
      const lines = await db.Line.findAll({ where: { phoneId: made.robDesk.id } });
      const accounts = await PhoneRegistration.findAll({ where: { id: lines.map((line) => line.endpointId) } });
      expect(accounts).toHaveLength(2);
      for (const account of accounts) {
        expect(account).toMatchObject({ mode: 'registrar', kind: 'device', handler: 'pbx', registrar: REALM, status: 'active', organisationId: orgs.a });
        expect(account.username).toMatch(/^l[a-z2-7]{15}$/);
        expect(account.password).toHaveLength(32);
        expect(account.ha1).toBe(createHash('md5').update(`${account.username}:${REALM}:${account.password}`).digest('hex'));
      }
      // Not in the phone-endpoint lists, and not reachable by id there.
      for (const path of ['/phone-endpoints', '/phone-endpoints?type=phone-registration']) {
        const listed = await ok(get('ownerA', path));
        expect(listed.items.filter((item) => item.id && accounts.some((account) => account.id === item.id))).toEqual([]);
      }
      expect((await get('ownerA', `/phone-endpoints/${accounts[0].id}`)).status).toBe(404);
      expect((await put('ownerA', `/phone-endpoints/${accounts[0].id}`, { name: 'mine now' })).status).toBe(404);
      expect((await del('ownerA', `/phone-endpoints/${accounts[0].id}`)).status).toBe(404);
      expect((await post('ownerA', '/phone-endpoints', { type: 'phone-registration', mode: 'registrar', kind: 'device', name: 'x' })).status).toBe(400);

      const line = lineOn(made.robDesk, '200');
      const shown = await ok(get('ownerA', `/phones/${made.robDesk.id}/lines/${line.id}/credentials`));
      const account = accounts.find((a) => a.username === shown.username);
      expect(shown).toMatchObject({ lineNumber: line.lineNumber, registrar: REALM, transport: 'tls', password: account.password, ha1: account.ha1 });
      expect((await get('memberA', `/phones/${made.robDesk.id}/lines/${line.id}/credentials`)).status).toBe(403);
      expect((await get('ownerB', `/phones/${made.robDesk.id}/lines/${line.id}/credentials`)).status).toBe(404);
    });

    test('a number routed to an extension takes the pbx handler and says what it rings', async () => {
      const read = await ok(get('ownerA', `/phone-endpoints/${ddi(3)}`));
      expect(read).toMatchObject({ handler: 'pbx', extensionId: made.sales.extension.id, extensionNumber: '200', extensionName: 'Sales' });
      const sales = await ok(get('ownerA', `/directory/extensions/${made.sales.extension.id}`));
      expect(sales).toMatchObject({ numbers: [`+${ddi(3)}`], shownNumber: `+${ddi(3)}`, shownNumberSource: 'only', phoneCount: 2, personal: false });
      expect(sales.members.map((member) => member.name)).toEqual(['Rob Parkinson', 'Priya Nair']);
      expect((await put('ownerA', `/phone-endpoints/${ddi(3)}`, { handler: 'livekit' })).status).toBe(409);
    });

    test("a call to a user's number rings that user's phone on their own key", async () => {
      const plan = await resolve({ kind: 'number', calledNumber: `+${ddi(1)}`, trunkId: TRUNK, callerId: '+447700900123' });
      expect(plan).toMatchObject({ action: 'ring', organisationId: orgs.a, noAnswer: { kind: 'release' } });
      expect(plan.target).toMatchObject({ number: '100', name: 'Rob Parkinson', personal: true });
      expect(plan.caller).toEqual({ number: '+447700900123', display: '+44 7700 900123', internal: false });
      const legs = plan.ring.steps[0].legs;
      expect(legs.map((leg) => [leg.phoneLabel, leg.key])).toEqual([['Rob desk', 1]]);
      expect(legs[0].endpoint).toEqual({ username: await usernameOf(lineOn(made.robDesk, '100')), registrar: REALM });
      expect(plan.ring).toMatchObject({ strategy: 'ring_all', ringSeconds: 30 });
    });

    test('a call to the sales number rings both phones on the sales key', async () => {
      const plan = await resolve({ kind: 'number', calledNumber: ddi(3), trunkId: TRUNK, callerId: '+447700900123' });
      const legs = plan.ring.steps[0].legs;
      expect(legs.map((leg) => [leg.phoneLabel, leg.key, leg.display.name, leg.display.number]))
        .toEqual([['Rob desk', 2, 'Sales', '200'], ['Priya desk', 2, 'Sales', '200']]);
      expect(legs.map((leg) => leg.lineNumber)).toEqual([lineOn(made.robDesk, '200').lineNumber, lineOn(made.priyaDesk, '200').lineNumber]);
      expect(legs.every((leg) => leg.registeredHint === false)).toBe(true);
    });

    test('one phone can call the other by extension number', async () => {
      const plan = await resolve({ kind: 'dialled', fromEndpoint: await usernameOf(lineOn(made.robDesk, '100')), digits: '101' });
      expect(plan.action).toBe('ring');
      expect(plan.caller).toEqual({ number: '100', display: 'Rob P. 100', internal: true });
      expect(plan.ring.steps[0].legs.map((leg) => [leg.phoneLabel, leg.key])).toEqual([['Priya desk', 1]]);
      expect(plan.from).toMatchObject({ phoneId: made.robDesk.id, extensionNumber: '100' });
    });

    test('a call out from the sales key shows the sales number', async () => {
      const fromSales = await resolve({ kind: 'dialled', fromEndpoint: await usernameOf(lineOn(made.robDesk, '200')), digits: '02079460999' });
      expect(fromSales).toMatchObject({ action: 'outside', outside: { number: '+442079460999', presentNumber: `+${ddi(3)}` } });
      const fromOwn = await resolve({ kind: 'dialled', fromEndpoint: await usernameOf(lineOn(made.robDesk, '100')), digits: '02079460999' });
      expect(fromOwn.outside.presentNumber).toBe(`+${ddi(1)}`);
      const emergency = await resolve({ kind: 'dialled', fromEndpoint: await usernameOf(lineOn(made.robDesk, '200')), digits: '999' });
      expect(emergency).toMatchObject({ action: 'emergency', emergency: { number: '999', presentNumber: `+${ddi(3)}` } });
    });

    test('a call that cannot be routed is refused with a reason, not an error', async () => {
      expect(await resolve({ kind: 'number', calledNumber: '+442079469999', trunkId: TRUNK })).toMatchObject({ action: 'refuse', reason: 'number_not_found' });
      expect(await resolve({ kind: 'number', calledNumber: ddi(4), trunkId: TRUNK })).toMatchObject({ action: 'refuse', reason: 'number_not_routed' });
      expect(await resolve({ kind: 'number', calledNumber: ddi(1), trunkId: 'another-trunk' })).toMatchObject({ action: 'refuse', reason: 'number_not_found' });
      expect(await resolve({ kind: 'dialled', fromEndpoint: 'lnobodyhasthisname', digits: '101' })).toMatchObject({ action: 'refuse', reason: 'line_not_found' });
      expect((await post('ownerA', '/agent-db/pbx/resolve', { request: { kind: 'teleport' } })).status).toBe(400);
    });

    test('a dry run changes nothing and reports what the real write then does', async () => {
      const count = async () => ({
        lines: await db.Line.count(),
        accounts: await PhoneRegistration.count({ where: { kind: 'device' } }),
        members: await db.ExtensionMember.count(),
        changes: await db.PhoneChange.count(),
        entries: await db.DirectoryEntry.count(),
      });
      const support = await team('ownerA', 'Support', '210');
      const before = await count();
      const dry = await ok(post('ownerA', `/directory/extensions/${support.extension.id}/members?dryRun=true`, { entryId: made.rob.entry.id }));
      expect(dry.dryRun).toBe(true);
      expect(await count()).toEqual(before);
      expect(dry.effect).toMatchObject({ phonesAffected: 1, linesAdded: 1, linesRemoved: 0, keysMoved: 0, summary: 'Adds 1 line on 1 phone.' });
      expect(dry.effect.phones[0]).toMatchObject({ phoneId: made.robDesk.id, sipAccounts: { create: 1, remove: 0 } });
      expect(dry.effect.phones[0].after.map((key) => [key.key, key.label, key.lineNumber === null]))
        .toEqual([[1, 'Rob P. 100', false], [2, 'Sales', false], [3, 'Support', true]]);
      expect(dry.effect.affectedUsers).toEqual([{ entryId: made.rob.entry.id, name: 'Rob Parkinson' }]);

      const real = await ok(post('ownerA', `/directory/extensions/${support.extension.id}/members`, { entryId: made.rob.entry.id }), 201);
      expect(real.member).toMatchObject({ entryId: made.rob.entry.id, keyPosition: 2, owner: false });
      const strip = (effect) => JSON.parse(JSON.stringify(effect, (key, value) => (key === 'lineNumber' ? undefined : value)));
      expect(strip(real.effect)).toEqual(strip(dry.effect));
      expect(real.effect.phones[0].after[2].lineNumber).toBeGreaterThanOrEqual(100000);
      const after = await count();
      expect({ lines: after.lines - before.lines, accounts: after.accounts - before.accounts, changes: after.changes - before.changes })
        .toEqual({ lines: 1, accounts: 1, changes: 1 });
      made.support = support;
    });

    test('a key that moves keeps its line, its number and its SIP account', async () => {
      const before = await ok(get('ownerA', `/phones/${made.robDesk.id}`));
      expect(keys(before)).toEqual(['100', '200', '210']);
      const endpointsBefore = Object.fromEntries((await db.Line.findAll({ where: { phoneId: made.robDesk.id } })).map((line) => [line.id, line.endpointId]));

      const moved = await ok(put('ownerA', `/directory/entries/${made.rob.entry.id}/key-order`, { extensionIds: [made.support.extension.id, made.sales.extension.id] }));
      expect(moved.memberships.map((m) => m.number)).toEqual(['210', '200']);
      expect(moved.effect).toMatchObject({ phonesAffected: 1, linesAdded: 0, linesRemoved: 0, keysMoved: 2, summary: 'Moves 2 keys on 1 phone.' });

      const after = await ok(get('ownerA', `/phones/${made.robDesk.id}`));
      expect(keys(after)).toEqual(['100', '210', '200']);
      for (const line of before.lines) {
        const same = after.lines.find((candidate) => candidate.id === line.id);
        expect(same).toMatchObject({ number: line.number, lineNumber: line.lineNumber });
      }
      const endpointsAfter = Object.fromEntries((await db.Line.findAll({ where: { phoneId: made.robDesk.id } })).map((line) => [line.id, line.endpointId]));
      expect(endpointsAfter).toEqual(endpointsBefore);
      // Priya's phone is untouched: the order belongs to Rob.
      expect(keys(await ok(get('ownerA', `/phones/${made.priyaDesk.id}`)))).toEqual(['101', '200']);

      const { changes } = await ok(get('ownerA', `/phones/${made.robDesk.id}/changes`));
      expect(changes[0]).toMatchObject({ cause: { kind: 'key_order', entryId: made.rob.entry.id }, actorKind: 'user', resync: 'none' });
      expect(changes[0].before.map((key) => key.label)).toEqual(['Rob P. 100', 'Sales', 'Support']);
      expect(changes[0].after.map((key) => key.label)).toEqual(['Rob P. 100', 'Support', 'Sales']);

      expect((await put('ownerA', `/directory/entries/${made.rob.entry.id}/key-order`, { extensionIds: [made.sales.extension.id] })).body.code).toBe('key_order_mismatch');
    });

    test('the same write again changes no phone and records nothing', async () => {
      const before = await db.PhoneChange.count();
      const again = await ok(put('ownerA', `/directory/entries/${made.rob.entry.id}/key-order`, { extensionIds: [made.support.extension.id, made.sales.extension.id] }));
      expect(again.effect).toMatchObject({ phonesAffected: 0, summary: 'No phone changes.' });
      await ok(patch('ownerA', `/directory/extensions/${made.sales.extension.id}`, { params: { ringSeconds: 45 } }));
      expect(await db.PhoneChange.count()).toBe(before);
      const plan = await resolve({ kind: 'extension', organisationId: orgs.a, extensionId: made.sales.extension.id, callerId: '+447700900123' });
      expect(plan.ring).toMatchObject({ ringSeconds: 45 });
      expect(plan.ring.steps[0].seconds).toBe(45);
    });

    test('a rename changes the label and is recorded, with no line changed', async () => {
      const lines = await db.Line.count();
      const renamed = await ok(patch('ownerA', `/directory/entries/${made.sales.entry.id}`, { name: 'Sales team' }));
      expect(renamed.effect).toMatchObject({ phonesAffected: 2, linesAdded: 0, linesRemoved: 0, keysMoved: 0 });
      expect(await db.Line.count()).toBe(lines);
      const { changes } = await ok(get('ownerA', `/phones/${made.priyaDesk.id}/changes`));
      expect(changes[0].cause.kind).toBe('labels');
      expect((await ok(get('ownerA', `/phones/${made.priyaDesk.id}`))).lines.map((line) => line.label)).toEqual(['Priya N. 101', 'Sales team']);
      await ok(patch('ownerA', `/directory/entries/${made.sales.entry.id}`, { name: 'Sales' }));
    });

    test('more extensions than keys puts the rest on one overflow key', async () => {
      // The phone carries 4 lines. Rob has 100, Support and Sales. Two more make 5.
      const returns = await team('ownerA', 'Returns', '240');
      const deliveries = await team('ownerA', 'Deliveries', '250');
      await ok(post('ownerA', `/directory/extensions/${returns.extension.id}/members`, { entryId: made.rob.entry.id }), 201);
      expect(keys(await ok(get('ownerA', `/phones/${made.robDesk.id}`)))).toEqual(['100', '210', '200', '240']);
      const returnsLine = await db.Line.findOne({ where: { phoneId: made.robDesk.id, extensionId: returns.extension.id } });

      const overflow = await ok(post('ownerA', `/directory/extensions/${deliveries.extension.id}/members`, { entryId: made.rob.entry.id }), 201);
      expect(overflow.effect).toMatchObject({ linesAdded: 1, linesRemoved: 1, keysMoved: 0 });
      expect(overflow.effect.phones[0].sipAccounts).toEqual({ create: 1, remove: 1 });
      const phone = await ok(get('ownerA', `/phones/${made.robDesk.id}`));
      expect(keys(phone)).toEqual(['100', '210', '200', 'other(2)']);
      expect(phone.lines[3]).toMatchObject({ kind: 'other', label: 'Other', covers: [returns.extension.id, deliveries.extension.id] });
      // The key that became the overflow key has a new line and a new account.
      expect(await db.Line.findByPk(returnsLine.id)).toBeNull();
      expect(await PhoneRegistration.findByPk(returnsLine.endpointId)).toBeNull();
      expect(phone.lines[3].lineNumber).not.toBe(returnsLine.lineNumber);

      const plan = await resolve({ kind: 'extension', organisationId: orgs.a, extensionId: deliveries.extension.id, callerId: '+447700900123' });
      expect(plan.ring.steps[0].legs.map((leg) => [leg.key, leg.lineKind, leg.display.name])).toEqual([[4, 'other', 'Deliveries']]);
      // A call out from the overflow key shows the first user's own number.
      const out = await resolve({ kind: 'dialled', fromEndpoint: await usernameOf(phone.lines[3]), digits: '+442079460999' });
      expect(out.outside.presentNumber).toBe(`+${ddi(1)}`);

      // Leaving one of the two gives the other its own key back.
      const left = await ok(del('ownerA', `/directory/extensions/${deliveries.extension.id}/members/${made.rob.entry.id}`));
      expect(left.effect).toMatchObject({ linesAdded: 1, linesRemoved: 1 });
      expect(keys(await ok(get('ownerA', `/phones/${made.robDesk.id}`)))).toEqual(['100', '210', '200', '240']);
      await ok(del('ownerA', `/directory/extensions/${returns.extension.id}/members/${made.rob.entry.id}`));
      await ok(del('ownerA', `/directory/extensions/${deliveries.extension.id}`));
      await ok(del('ownerA', `/directory/extensions/${returns.extension.id}`));
    });

    test('two member changes sent at once give the same lines as one after the other', async () => {
      const a = await person('ownerA', 'Sam Reed', '103');
      const b = await person('ownerA', 'Mo Hassan', '104');
      const shared = await deskphone('ownerA', 3, 'Warehouse', [a.entry.id, b.entry.id]);
      expect(keys(shared)).toEqual(['103', '104']);
      const [first, second] = await Promise.all([
        post('ownerA', `/directory/extensions/${made.sales.extension.id}/members`, { entryId: a.entry.id }),
        post('ownerA', `/directory/extensions/${made.support.extension.id}/members`, { entryId: b.entry.id }),
      ]);
      expect([first.status, second.status]).toEqual([201, 201]);
      // Sam is first on the phone, so his shared key comes before Mo's.
      expect(keys(await ok(get('ownerA', `/phones/${shared.id}`)))).toEqual(['103', '104', '200', '210']);
      const sales = await ok(get('ownerA', `/directory/extensions/${made.sales.extension.id}/members`));
      expect(sales.members.map((member) => member.huntPosition)).toEqual([1, 2, 3]);
      // A call to Sales rings the shared phone once.
      const plan = await resolve({ kind: 'extension', organisationId: orgs.a, extensionId: made.sales.extension.id });
      expect(plan.ring.steps[0].legs.filter((leg) => leg.phoneId === shared.id)).toHaveLength(1);
      made.sam = a;
      made.mo = b;
      made.warehouse = shared;
    });

    test('the people on a phone can be put in another order', async () => {
      const reordered = await ok(put('ownerA', `/phones/${made.warehouse.id}/people`, { entryIds: [made.mo.entry.id, made.sam.entry.id] }));
      expect(reordered.people.map((p) => p.name)).toEqual(['Mo Hassan', 'Sam Reed']);
      expect(reordered.effect.keysMoved).toBe(4);
      expect(keys(await ok(get('ownerA', `/phones/${made.warehouse.id}`)))).toEqual(['104', '103', '210', '200']);
      const { changes } = await ok(get('ownerA', `/phones/${made.warehouse.id}/changes`));
      expect(changes[0].cause.kind).toBe('people_order');
    });

    test('a phone takes one person fewer than it has lines', async () => {
      const c = await person('ownerA', 'Ellie Brook', '105');
      const d = await person('ownerA', 'Tom Okafor', '106');
      await ok(post('ownerA', `/phones/${made.warehouse.id}/people`, { entryId: c.entry.id }), 201);
      const full = await ok(get('ownerA', `/phones/${made.warehouse.id}`));
      expect(full).toMatchObject({ maxPeople: 3, roomForPerson: false });
      const refused = await post('ownerA', `/phones/${made.warehouse.id}/people`, { entryId: d.entry.id });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'phone_too_small', detail: { lines: 4, maxPeople: 3, wanted: 4 } });
      expect((await put('ownerA', `/phones/${made.warehouse.id}/people`, { entryIds: [made.sales.entry.id] })).body.code).toBe('phone_person_not_person');
      const fewer = await ok(del('ownerA', `/phones/${made.warehouse.id}/people/${c.entry.id}`));
      expect(fewer.people).toHaveLength(2);
      made.tom = d;
    });

    test('an outside number rings for one person, for their own extension only', async () => {
      const mobile = (await ok(post('ownerA', '/phones', {
        kind: 'external', label: 'Rob mobile', number: '07700 900310', ringDelay: 15, people: [made.rob.entry.id],
      }), 201)).phone;
      expect(mobile).toMatchObject({ kind: 'external', number: '+447700900310', ringDelay: 15, shows: 'caller', keyToAnswer: true, lines: [], capacity: 0 });
      const own = await resolve({ kind: 'number', calledNumber: ddi(1), trunkId: TRUNK, callerId: '+447700900123' });
      const leg = own.ring.steps[0].legs.find((candidate) => candidate.kind === 'external');
      expect(leg).toMatchObject({ number: '+447700900310', delaySeconds: 15, presentNumber: '+447700900123', fallbackPresentNumber: `+${ddi(1)}`, keyToAnswer: true, outside: true });
      const shared = await resolve({ kind: 'number', calledNumber: ddi(3), trunkId: TRUNK });
      expect(shared.ring.steps[0].legs.some((candidate) => candidate.kind === 'external')).toBe(false);
      expect(shared.skipped).toContainEqual({ entryId: made.rob.entry.id, phoneId: mobile.id, reason: 'mobile_not_for_shared' });

      const late = await ok(patch('ownerA', `/phones/${mobile.id}`, { ringDelay: 45 }));
      expect(late.effect.warnings[0].code).toBe('ring_delay_not_less_than_ring_time');
      const codes = [
        (await post('ownerA', '/phones', { kind: 'external', label: 'Two', number: '07700900311', people: [made.rob.entry.id, made.priya.entry.id] })).body.code,
        (await post('ownerA', '/phones', { kind: 'external', label: 'Ours', number: `+${ddi(5)}`, people: [made.priya.entry.id] })).body.code,
        (await post('ownerA', '/phones', { kind: 'external', label: 'None', people: [made.priya.entry.id] })).body.code,
        (await post('ownerA', '/phones', { kind: 'browser', label: 'Browser', people: [] })).body.code,
      ];
      expect(codes).toEqual(['external_one_person', 'external_number_is_ours', 'external_number_required', 'phone_kind_not_available']);
      await ok(del('ownerA', `/phones/${mobile.id}`));
    });

    test('a desk phone is known by its MAC address', async () => {
      const bad = [
        (await post('ownerA', '/phones', { kind: 'deskphone', mac: '00:11:22:33:44:55', model: '710', label: 'Other maker', people: [] })).body.code,
        (await post('ownerA', '/phones', { kind: 'deskphone', mac: mac(20), model: 'D9999', label: 'Unknown', people: [] })).body.code,
        (await post('ownerA', '/phones', { kind: 'deskphone', mac: mac(1), model: '710', label: 'Again', people: [] })).body.code,
        (await post('ownerB', '/phones', { kind: 'deskphone', mac: mac(1).toUpperCase().replace(/(..)(?=.)/g, '$1:'), model: '710', label: 'Theirs', people: [] })).body.code,
        (await post('ownerA', '/phones', { kind: 'deskphone', mac: mac(21), model: '710', people: [] })).body.code,
      ];
      expect(bad).toEqual(['not_a_snom_mac', 'model_not_supported', 'phone_in_directory', 'phone_held_elsewhere', 'label_required']);

      const spare = await deskphone('ownerA', 22, 'Spare', [made.tom.entry.id]);
      const accounts = (await db.Line.findAll({ where: { phoneId: spare.id } })).map((line) => line.endpointId);
      const removed = await ok(del('ownerA', `/phones/${spare.id}`));
      expect(removed.effect).toMatchObject({ phonesAffected: 1, linesRemoved: 1 });
      expect(await db.Line.count({ where: { phoneId: spare.id } })).toBe(0);
      expect(await PhoneRegistration.count({ where: { id: accounts } })).toBe(0);
      expect((await get('ownerA', `/phones/${spare.id}`)).status).toBe(404);
      // Another organisation still cannot take it. The same one can add it again.
      expect((await post('ownerB', '/phones', { kind: 'deskphone', mac: mac(22), model: '710', label: 'Theirs', people: [] })).body.code).toBe('phone_held_elsewhere');
      const back = await deskphone('ownerA', 22, 'Spare again', [made.tom.entry.id]);
      expect(back.device.id).toBe(spare.device.id);
      expect(keys(back)).toEqual(['106']);
      expect((await patch('ownerA', `/phones/${back.id}`, { model: 'D717', label: 'Spare D717' })).status).toBe(200);
      expect((await ok(get('ownerA', `/phones/${back.id}`))).capacity).toBe(6);
      await db.Device.update({ reportedModel: 'D717' }, { where: { id: back.device.id } });
      expect((await patch('ownerA', `/phones/${back.id}`, { model: '710' })).body.code).toBe('phone_model_reported');
    });

    test('the rules for extensions and members are refused with their codes', async () => {
      const spare = await ok(post('ownerA', '/directory/entries', { kind: 'person', name: 'Jane Andrews' }), 201);
      const group = await ok(post('ownerA', '/directory/entries', { kind: 'service', name: 'Out of hours' }), 201);
      const ext = (body) => post('ownerA', '/directory/extensions', body);
      const cases = [
        [await ext({ number: '100', type: 'ring_all', entryId: spare.entry.id }), 409, 'extension_number_taken'],
        [await ext({ number: '9991', type: 'ring_all', entryId: spare.entry.id }), 400, 'extension_number_reserved'],
        [await ext({ number: '12a', type: 'ring_all', entryId: spare.entry.id }), 400, 'invalid_extension'],
        [await ext({ number: '120', type: 'ring_all', entryId: made.rob.entry.id }), 409, 'entry_has_extension'],
        [await ext({ number: '120', type: 'hunt', entryId: spare.entry.id }), 409, 'extension_type_not_available'],
        [await ext({ number: '120', type: 'ring_all' }), 400, 'extension_entry_required'],
        [await ext({ number: '120', type: 'ring_all', entryId: spare.entry.id, params: { ringSeconds: 2 } }), 400, 'invalid_params'],
        [await ext({ number: '120', type: 'ring_all', entryId: spare.entry.id, params: { volume: 11 } }), 400, 'invalid_params'],
        [await ext({ number: '120', type: 'ring_all', entryId: spare.entry.id, params: { noAnswer: { kind: 'external', number: '+442079460999' } } }), 409, 'destination_not_available'],
        [await ext({ number: '120', type: 'ring_all', entryId: spare.entry.id, outboundNumber: `+${ddi(4)}` }), 400, 'outbound_number_not_routed'],
        [await ext({ number: '120', type: 'connection', entryId: spare.entry.id, connectionId: randomUUID() }), 400, 'connection_not_found'],
        [await ext({ number: '120', type: 'ring_all', entryId: randomUUID() }), 404, 'not_found'],
        [await post('ownerA', `/directory/extensions/${made.sales.extension.id}/members`, { entryId: group.entry.id }), 400, 'member_not_person'],
        [await post('ownerA', `/directory/extensions/${made.sales.extension.id}/members`, { entryId: made.rob.entry.id }), 409, 'already_member'],
        [await post('ownerA', `/directory/extensions/${made.rob.extension.id}/members`, { entryId: made.rob.entry.id }), 409, 'already_member'],
        [await del('ownerA', `/directory/extensions/${made.rob.extension.id}/members/${made.rob.entry.id}`), 409, 'owner_not_removable'],
        [await del('ownerA', `/directory/extensions/${made.sales.extension.id}`), 409, 'extension_has_numbers'],
        [await patch('ownerA', `/directory/extensions/${made.sales.extension.id}`, { type: 'connection' }), 409, 'extension_has_members'],
        [await patch('ownerA', `/directory/entries/${made.rob.entry.id}`, { kind: 'team' }), 409, 'kind_change_blocked'],
        [await patch('ownerA', `/directory/entries/${made.rob.entry.id}`, { discloseNumbers: true }), 400, 'person_disclosure'],
        [await patch('ownerA', `/directory/entries/${made.rob.entry.id}`, { email: 'not an email' }), 400, 'invalid_email'],
        [await post('ownerA', '/directory/entries', { kind: 'person' }), 400, 'name_required'],
      ];
      expect(cases.map(([res, status, code]) => ({ status: res.status, code: res.body.code })))
        .toEqual(cases.map(([, status, code]) => ({ status, code })));
      expect(cases[1][0].body.field).toBe('number');
      expect(cases[6][0].body.field).toBe('params.ringSeconds');

      // A connection extension has no members.
      const onTheirSystem = await ok(ext({ number: '310', type: 'connection', entryId: group.entry.id }), 201);
      expect((await post('ownerA', `/directory/extensions/${onTheirSystem.extension.id}/members`, { entryId: spare.entry.id })).body.code).toBe('member_not_allowed_on_type');
      // A personal extension can have an assistant, who gets it after their own.
      const assisted = await ok(post('ownerA', `/directory/extensions/${made.priya.extension.id}/members`, { entryId: made.tom.entry.id, keyPosition: 1 }), 201);
      expect(assisted.member).toMatchObject({ keyPosition: 1, owner: false });
      const priya = await ok(get('ownerA', `/directory/extensions/${made.priya.extension.id}`));
      expect(priya.members.map((member) => [member.name, member.owner])).toEqual([['Priya Nair', true], ['Tom Okafor', false]]);
      expect((await del('ownerA', `/directory/entries/${made.priya.entry.id}`)).body).toMatchObject({ code: 'owned_extension_in_use', detail: { members: [made.tom.entry.id], numbers: [`+${ddi(2)}`] } });
    });

    test('removing a user takes their lines away and frees their extension number', async () => {
      const { entry, extension } = await person('ownerA', 'Dan Price', '107');
      await ok(post('ownerA', `/directory/extensions/${made.support.extension.id}/members`, { entryId: entry.id }), 201);
      const phone = await deskphone('ownerA', 30, 'Dan desk', [entry.id]);
      expect(keys(phone)).toEqual(['107', '210']);
      const removed = await ok(del('ownerA', `/directory/entries/${entry.id}`));
      expect(removed.effect).toMatchObject({ phonesAffected: 1, linesRemoved: 2 });
      expect((await ok(get('ownerA', `/phones/${phone.id}`))).lines).toEqual([]);
      expect((await get('ownerA', `/directory/entries/${entry.id}`)).status).toBe(404);
      expect((await get('ownerA', `/directory/extensions/${extension.id}`)).status).toBe(404);
      const support = await ok(get('ownerA', `/directory/extensions/${made.support.extension.id}`));
      expect(support.members.map((member) => member.name)).not.toContain('Dan Price');
      expect(support.members.map((member) => member.huntPosition)).toEqual(support.members.map((member, i) => i + 1));
      // The number can be used again, and the hunt order still takes a new member.
      const next = await person('ownerA', 'Dana Price', '107');
      await ok(post('ownerA', `/directory/extensions/${made.support.extension.id}/members`, { entryId: next.entry.id }), 201);
      const listed = await ok(get('ownerA', '/directory/entries?includeDeleted=true&q=price'));
      expect(listed.entries.map((e) => [e.name, Boolean(e.deletedAt)]).sort()).toEqual([['Dan Price', true], ['Dana Price', false]]);
      expect((await ok(get('memberA', '/directory/entries?includeDeleted=true&q=price'))).entries.map((e) => e.name)).toEqual(['Dana Price']);
    });

    test('a number rings an extension or an agent, never both', async () => {
      const userId = randomUUID();
      await User.create({
        id: userId, organisationId: orgs.a, name: 'Agent owner', email: `agent-owner-${stamp}@test.example.com`, emailVerified: true,
        phone: '+10000000000', phoneVerified: true, picture: 'https://example.com/p.png', role: 'owner',
      });
      const agent = await Agent.create({
        name: 'Front desk agent', description: 't', modelName: 'livekit:ultravox/ultravox-v0.7', prompt: 'You are a test agent.',
        options: {}, functions: {}, keys: [], userId, organisationId: orgs.a,
      });
      const instance = await Instance.create({ agentId: agent.id, type: 'livekit', key: 'k', userId, organisationId: orgs.a });
      await PhoneNumber.update({ instanceId: instance.id }, { where: { number: ddi(4), organisationId: orgs.a } });

      const refused = await put('ownerA', `/phone-endpoints/${ddi(4)}`, { extensionId: made.support.extension.id });
      expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 409, code: 'number_in_use' });
      const moved = await ok(put('ownerA', `/phone-endpoints/${ddi(4)}`, { extensionId: made.support.extension.id, replace: true }));
      expect(moved).toMatchObject({ extensionId: made.support.extension.id, handler: 'pbx' });
      const row = await PhoneNumber.findOne({ where: { number: ddi(4), organisationId: orgs.a } });
      expect(row).toMatchObject({ instanceId: null, handler: 'pbx' });
      // An agent cannot take a number that rings an extension.
      await expect(instance.linkNumber('livekit', ddi(4), orgs.a)).rejects.toThrow(/routes to pbx/);

      // The only number of an extension is what its calls out show. Cleared, it goes back to its trunk's handler.
      await ok(patch('ownerA', `/directory/extensions/${made.support.extension.id}`, { outboundNumber: `+${ddi(4)}` }));
      expect((await put('ownerA', `/phone-endpoints/${ddi(4)}`, { extensionId: null })).body.code).toBe('number_in_use_for_caller_id');
      await ok(patch('ownerA', `/directory/extensions/${made.support.extension.id}`, { outboundNumber: null }));
      expect(await ok(put('ownerA', `/phone-endpoints/${ddi(4)}`, { extensionId: null }))).toMatchObject({ extensionId: null, handler: 'livekit' });
      expect((await put('ownerA', `/phone-endpoints/${ddi(4)}`, { extensionId: randomUUID() })).status).toBe(404);
      expect((await put('ownerB', `/phone-endpoints/${ddi(4)}`, { extensionId: made.support.extension.id })).status).toBe(404);
    });

    test('the main number is shown by an extension with no number of its own', async () => {
      expect((await put('adminA', `/organisations/${orgs.a}/phone-system`, { mainNumber: '+442079460000' })).body.code).toBe('main_number_not_held');
      const set = await ok(put('adminA', `/organisations/${orgs.a}/phone-system`, { mainNumber: `+${ddi(5)}` }));
      expect(set).toMatchObject({ mainNumber: `+${ddi(5)}`, busyStatusVisible: true, capabilities: ['phoneSystem'] });
      const support = await ok(get('ownerA', `/directory/extensions/${made.support.extension.id}`));
      expect(support).toMatchObject({ shownNumber: `+${ddi(5)}`, shownNumberSource: 'main' });
      expect((await get('adminB', `/organisations/${orgs.a}/phone-system`)).status).toBe(404);
    });

    test('another organisation sees nothing, and a member can read but not write', async () => {
      const paths = [
        `/directory/entries/${made.rob.entry.id}`,
        `/directory/extensions/${made.sales.extension.id}`,
        `/directory/extensions/${made.sales.extension.id}/members`,
        `/phones/${made.robDesk.id}`,
        `/phones/${made.robDesk.id}/lines`,
        `/phones/${made.robDesk.id}/changes`,
      ];
      for (const path of paths) expect((await get('ownerB', path)).status).toBe(404);
      expect((await ok(get('ownerB', '/directory/entries'))).entries).toEqual([]);
      expect((await ok(get('ownerB', '/phones'))).phones).toEqual([]);
      expect((await del('ownerB', `/phones/${made.robDesk.id}`)).status).toBe(404);
      expect((await post('ownerB', `/directory/extensions/${made.sales.extension.id}/members`, { entryId: made.rob.entry.id })).status).toBe(404);
      expect((await get('ownerB', `/directory/entries?organisationId=${orgs.a}`)).status).toBe(404);
      // A platform operator names the organisation.
      expect((await get('operator', '/directory/entries')).status).toBe(403);
      expect((await ok(get('operator', `/directory/entries?organisationId=${orgs.a}`))).entries.length).toBeGreaterThan(3);

      for (const path of paths) expect((await get('memberA', path)).status).toBe(200);
      const writes = [
        await post('memberA', '/directory/entries', { kind: 'person', name: 'New' }),
        await patch('memberA', `/directory/entries/${made.rob.entry.id}`, { role: 'Boss' }),
        await post('memberA', `/directory/extensions/${made.sales.extension.id}/members`, { entryId: made.tom.entry.id }),
        await post('memberA', '/phones', { kind: 'deskphone', mac: mac(40), model: '710', label: 'Mine', people: [] }),
        await del('memberA', `/phones/${made.robDesk.id}`),
      ];
      expect(writes.map((res) => res.status)).toEqual([403, 403, 403, 403, 403]);
    });

    test('with the capability taken away, calls are refused and nothing is deleted', async () => {
      const lines = await db.Line.count({ where: { organisationId: orgs.a } });
      await ok(put('operator', `/organisations/${orgs.a}/capabilities`, { capabilities: [] }));
      expect(await resolve({ kind: 'number', calledNumber: ddi(3), trunkId: TRUNK })).toMatchObject({ action: 'refuse', reason: 'phone_system_disabled' });
      // An emergency call is still answered.
      const sos = await resolve({ kind: 'dialled', fromEndpoint: await usernameOf(lineOn(made.priyaDesk, '101')), digits: '112' });
      expect(sos).toMatchObject({ action: 'emergency', emergency: { presentNumber: `+${ddi(2)}` } });
      expect((await get('ownerA', '/phones')).body.code).toBe('phone_system_disabled');
      expect(await db.Line.count({ where: { organisationId: orgs.a } })).toBe(lines);
      expect((await ok(get('ownerA', '/directory/entries'))).entries.length).toBeGreaterThan(3);
      await ok(put('operator', `/organisations/${orgs.a}/capabilities`, { capabilities: ['phoneSystem'] }));
    });
  });

  describe('call records', () => {
    const record = (body) => post('ownerA', '/agent-db/pbx/calls', body);

    test('a call is one row with no agent, and a write sent twice is one row', async () => {
      const id = randomUUID();
      const body = { id, organisationId: orgs.a, callerId: '+447700900123', calledId: `+${ddi(3)}`, platformCallId: 'room-1', metadata: { direction: 'in', extensionNumber: '200' } };
      const created = await ok(record(body), 201);
      expect(created).toMatchObject({ id, modelName: 'telephony:pbx-call', live: true, status: 'in progress', metadata: { pbx: { direction: 'in', extensionNumber: '200' } } });
      expect(created.index).toBeGreaterThan(0);
      const again = await ok(record({ ...body, metadata: { answeredBy: 'rob' } }));
      expect(again.metadata.pbx).toEqual({ direction: 'in', extensionNumber: '200', answeredBy: 'rob' });
      const row = await db.Call.findByPk(id);
      expect(row).toMatchObject({ platform: 'pbx', instanceId: null, agentId: null, userId: null, organisationId: orgs.a });
      expect(await db.Call.count({ where: { id } })).toBe(1);

      // An answered leg is a child row.
      const legId = randomUUID();
      const leg = await ok(record({ id: legId, organisationId: orgs.a, parentId: id, callerId: '+447700900123', calledId: '200' }), 201);
      expect(leg).toMatchObject({ parentId: id, modelName: 'telephony:pbx-leg' });

      const events = [
        { id: randomUUID(), type: 'leg_rang', at: '2026-11-12T10:00:00Z', data: { phoneId: 'p1', key: 2 } },
        { id: randomUUID(), type: 'leg_rang', at: '2026-11-12T10:00:00Z', data: { phoneId: 'p2', key: 2 } },
        { id: randomUUID(), type: 'leg_answered', at: '2026-11-12T10:00:07Z', data: { phoneId: 'p1' } },
      ];
      expect(await ok(post('ownerA', `/agent-db/pbx/calls/${id}/events`, { events }))).toEqual({ stored: 3, duplicates: 0 });
      const resent = await ok(post('ownerA', `/agent-db/pbx/calls/${id}/events`, { events: [events[2], { id: randomUUID(), type: 'hold', data: {} }] }));
      expect(resent).toEqual({ stored: 1, duplicates: 1 });
      expect(await db.CallEvent.count({ where: { callId: id } })).toBe(4);

      const ended = await ok(post('ownerA', `/agent-db/pbx/calls/${id}/end`, { reason: 'hangup', answered: true, endedAt: new Date(Date.now() + 60000).toISOString() }));
      expect(ended).toMatchObject({ live: false, status: 'ended normally', metadata: { pbx: { endReason: 'hangup', answered: true } } });
      expect(ended.duration).toBeGreaterThan(50000);
      const endedAgain = await ok(post('ownerA', `/agent-db/pbx/calls/${id}/end`, { reason: 'late' }));
      expect(endedAgain.metadata.pbx.endReason).toBe('hangup');
      // A late write does not start an ended call again, and none of this is charged.
      expect((await ok(record(body))).live).toBe(false);
      expect(await db.UsageRecord.count({ where: { callId: [id, legId] } })).toBe(0);
    });

    test('bad records are refused', async () => {
      const id = randomUUID();
      expect((await record({ id: 'not-a-uuid', organisationId: orgs.a })).status).toBe(400);
      expect((await record({ id, organisationId: randomUUID() })).status).toBe(404);
      expect((await record({ id, organisationId: orgs.a, parentId: randomUUID() })).status).toBe(404);
      await ok(record({ id, organisationId: orgs.a }), 201);
      expect((await record({ id, organisationId: orgs.b })).body.code).toBe('call_id_in_use');
      expect((await post('ownerA', `/agent-db/pbx/calls/${randomUUID()}/events`, { events: [{ id: randomUUID(), type: 'hold' }] })).status).toBe(404);
      expect((await post('ownerA', `/agent-db/pbx/calls/${id}/events`, { events: [{ id: randomUUID(), type: 'Not A Type' }] })).status).toBe(400);
      expect((await post('ownerA', `/agent-db/pbx/calls/${randomUUID()}/end`, {})).status).toBe(404);
    });
  });
});

describe('the call control token', () => {
  let app;
  let server;
  let saved;
  const SHARED = 'pbx-test-shared-token';
  const CALLCTL = 'pbx-test-callctl-token';

  beforeAll(async () => {
    saved = { shared: process.env.SHARED_API_TOKEN, callctl: process.env.CALLCTL_SHARED_TOKEN, ba: process.env.BETTER_AUTH_ENABLED };
    process.env.BETTER_AUTH_ENABLED = 'false';
    process.env.SHARED_API_TOKEN = SHARED;
    process.env.CALLCTL_SHARED_TOKEN = CALLCTL;
    await setupRealDatabase();
    const { default: initAuth } = await import('../middleware/auth.js');
    app = express();
    app.use((req, res, next) => { req.log = log; next(); });
    initAuth(app, log);
    app.all('/api/agent-db/pbx/resolve', (req, res) => res.json({ principal: res.locals.user?.id }));
    app.all('/api/agent-db/agent', (req, res) => res.json({ principal: res.locals.user?.id }));
    app.all('/api/phones', (req, res) => res.json({ principal: res.locals.user?.id }));
    server = await listen(app);
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    for (const [key, name] of [['shared', 'SHARED_API_TOKEN'], ['callctl', 'CALLCTL_SHARED_TOKEN'], ['ba', 'BETTER_AUTH_ENABLED']]) {
      if (saved[key] === undefined) delete process.env[name];
      else process.env[name] = saved[key];
    }
    await teardownRealDatabase();
  });

  test('opens the call control routes and nothing else', async () => {
    const ok = await request(server).post('/api/agent-db/pbx/resolve').set('x-callctl-token', CALLCTL);
    expect({ status: ok.status, principal: ok.body.principal }).toEqual({ status: 200, principal: 'callctl' });
    expect((await request(server).post('/API/Agent-DB/PBX/resolve').set('x-callctl-token', CALLCTL)).status).toBe(200);
    expect((await request(server).get('/api/agent-db/agent').set('x-callctl-token', CALLCTL)).status).toBe(403);
    expect((await request(server).get('/api/phones').set('x-callctl-token', CALLCTL)).status).toBe(403);
  });

  test("the workers' shared token does not open the call control routes", async () => {
    expect((await request(server).post('/api/agent-db/pbx/resolve').set('x-shared-token', SHARED)).status).toBe(403);
    expect((await request(server).post('/api/agent-db/pbx/resolve')).status).toBe(403);
    expect((await request(server).post('/api/agent-db/pbx/resolve').set('x-callctl-token', 'wrong')).status).toBe(403);
    expect((await request(server).post('/api/agent-db/pbx/resolve').set('x-callctl-token', SHARED)).status).toBe(403);
    // The shared token still works where it did.
    expect((await request(server).get('/api/agent-db/agent').set('x-shared-token', SHARED)).status).toBe(200);
  });

  test('with no token set the routes are closed', async () => {
    delete process.env.CALLCTL_SHARED_TOKEN;
    expect((await request(server).post('/api/agent-db/pbx/resolve').set('x-callctl-token', CALLCTL)).status).toBe(403);
    expect((await request(server).post('/api/agent-db/pbx/resolve').set('x-callctl-token', '')).status).toBe(403);
    process.env.CALLCTL_SHARED_TOKEN = CALLCTL;
  });
});
