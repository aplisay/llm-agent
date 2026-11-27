/**
 * The list of desk phone lines that call control reads, through the real
 * routes and the test database.
 *
 * Emergency plans are asked for here, to compare with the list. A plan is an
 * answer from this server: no test places a call.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import {
  setupRealDatabase, teardownRealDatabase, Organisation, User, PhoneNumber, PhoneRegistration,
} from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const REALM = 'sip.phones.test.example';
const TRUNK = `line-list-trunk-${randomUUID().slice(0, 8)}`;
const CALLCTL = `callctl-${randomUUID()}`;
const SHARED = `shared-${randomUUID()}`;

const listen = async (app) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
};

describe('the list of lines for call control', () => {
  let app;
  let server;
  let db;
  let lineList;
  let savedEnv;
  const users = {};
  const orgs = {};
  const made = {};
  const stamp = String(Date.now()).slice(-6);
  const ddi = (n) => `4420795${stamp.slice(0, 2)}${String(n).padStart(3, '0')}`;
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

  const person = async (user, name, number) => {
    const { entry } = await ok(post(user, '/directory/entries', { kind: 'person', name }), 201);
    const { extension } = await ok(post(user, '/directory/extensions', { number, type: 'ring_all', entryId: entry.id }), 201);
    return { entry, extension };
  };
  const deskphone = async (user, n, label, people) => (await ok(post(user, '/phones', {
    kind: 'deskphone', mac: mac(n), model: '710', label, people,
  }), 201)).phone;
  const resolve = async (body) => ok(post('ownerA', '/agent-db/pbx/resolve', { callId: randomUUID(), request: body }));

  /** One page, as call control asks for it. */
  const page = (query = '') => get('ownerA', `/agent-db/pbx/lines${query}`);
  /** A whole pass: every page until `next` is null. Only this suite's organisations: others share the database. */
  async function pass(limit) {
    const lines = [];
    const pages = [];
    let after = '';
    for (let n = 0; after !== null && n < 1000; n++) {
      const body = await ok(page(`?after=${encodeURIComponent(after)}${limit ? `&limit=${limit}` : ''}`));
      pages.push(body.lines);
      lines.push(...body.lines);
      after = body.next;
    }
    const ours = (list) => list.filter((line) => Object.values(orgs).includes(line.organisationId));
    return { lines: ours(lines), pages: pages.map(ours).filter((list) => list.length) };
  }
  const linesOf = async (organisationId) => (await pass()).lines.filter((line) => line.organisationId === organisationId);
  const lineOf = async (extensionNumber, organisationId = orgs.a) => (await linesOf(organisationId))
    .find((line) => line.from.extensionNumber === extensionNumber);
  /** The list with nothing kept in memory: what a server that has just started gives. */
  async function fresh() {
    lineList.forgetLines();
    return (await pass()).lines;
  }

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.PBX_REGISTRAR_DOMAIN = REALM;
    delete process.env.PBX_RELEASE;
    await setupRealDatabase();
    db = await import('../lib/database.js');
    lineList = await import('../lib/pbx/line-list.js');

    const newOrg = async (name, capabilities = ['phoneSystem']) => {
      const id = randomUUID();
      await Organisation.create({ id, name, capabilities });
      return id;
    };
    orgs.a = await newOrg('Line list test A');
    orgs.b = await newOrg('Line list test B');
    orgs.c = await newOrg('Line list test C');
    orgs.empty = await newOrg('Line list test, no phones');
    for (const [name, key] of [['A', 'a'], ['B', 'b'], ['C', 'c'], ['Empty', 'empty']]) {
      users[`owner${name}`] = { id: `owner-${key}-${stamp}`, organisationId: orgs[key], role: 'owner' };
      users[`admin${name}`] = { id: `admin-${key}-${stamp}`, organisationId: orgs[key], role: 'orgAdmin' };
    }
    users.operator = { id: `operator-${stamp}`, organisationId: null, role: 'superAdmin' };
    await db.Trunk.create({ id: TRUNK, name: 'Line list test trunk', handler: 'livekit' });
    for (const n of [1, 2, 3, 4]) await PhoneNumber.create({ number: ddi(n), handler: 'livekit', organisationId: orgs.a, aplisayId: TRUNK });
    await PhoneNumber.create({ number: ddi(11), handler: 'livekit', organisationId: orgs.b, aplisayId: TRUNK });
    await PhoneNumber.create({ number: ddi(21), handler: 'livekit', organisationId: orgs.c, aplisayId: TRUNK });

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

    // A: Rob shows his own number, Priya has none of her own.
    made.rob = await person('ownerA', 'Rob Parkinson', '100');
    made.priya = await person('ownerA', 'Priya Nair', '101');
    made.robDesk = await deskphone('ownerA', 1, 'Rob desk', [made.rob.entry.id]);
    made.priyaDesk = await deskphone('ownerA', 2, 'Priya desk', [made.priya.entry.id]);
    await ok(put('ownerA', `/phone-endpoints/${ddi(1)}`, { extensionId: made.rob.extension.id }));
    // B and C: one person, one phone, one number.
    made.bea = await person('ownerB', 'Bea Okafor', '300');
    made.beaDesk = await deskphone('ownerB', 3, 'Bea desk', [made.bea.entry.id]);
    await ok(put('ownerB', `/phone-endpoints/${ddi(11)}`, { extensionId: made.bea.extension.id }));
    made.cal = await person('ownerC', 'Cal Reyes', '400');
    made.calDesk = await deskphone('ownerC', 4, 'Cal desk', [made.cal.entry.id]);
    await ok(put('ownerC', `/phone-endpoints/${ddi(21)}`, { extensionId: made.cal.extension.id }));
    // An organisation with a directory and no phone has no line to list.
    await person('ownerEmpty', 'Dana Price', '500');
  }, 120000);

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
    await User.destroy({ where });
    await db.Trunk.destroy({ where: { id: TRUNK } });
    await Organisation.destroy({ where: { id: ids } });
    process.env = savedEnv;
    await teardownRealDatabase();
  }, 60000);

  describe('what a pass gives', () => {
    test('every line that has a SIP account, with its organisation and the number it shows', async () => {
      const { lines } = await pass();
      expect(lines.map((line) => [line.organisationId, line.from.extensionNumber, line.from.presentNumber]).sort()).toEqual([
        [orgs.a, '100', `+${ddi(1)}`],
        [orgs.a, '101', null],
        [orgs.b, '300', `+${ddi(11)}`],
        [orgs.c, '400', `+${ddi(21)}`],
      ].sort());
      for (const line of lines) {
        expect(Object.keys(line).sort()).toEqual(['caller', 'from', 'organisationId', 'username']);
        expect(Object.keys(line.from).sort()).toEqual(['extensionId', 'extensionNumber', 'lineId', 'lineNumber', 'phoneId', 'presentNumber']);
        const account = await PhoneRegistration.findOne({ where: { username: line.username } });
        expect(account).toMatchObject({ mode: 'registrar', kind: 'device', organisationId: line.organisationId });
        expect((await db.Line.findByPk(line.from.lineId)).endpointId).toBe(account.id);
      }
      expect(new Set(lines.map((line) => line.username)).size).toBe(lines.length);
      expect(lines.find((line) => line.from.extensionNumber === '100').caller).toEqual({ number: '100', display: 'Rob P. 100', internal: true });
    });

    test('the blocks are those of a plan for a call from the line', async () => {
      for (const line of (await pass()).lines.filter((row) => [orgs.a, orgs.b].includes(row.organisationId))) {
        const user = line.organisationId === orgs.a ? 'ownerA' : 'ownerB';
        const plan = (digits) => ok(post(user, '/agent-db/pbx/resolve', { request: { kind: 'dialled', fromEndpoint: line.username, digits } }));
        for (const digits of ['101', '02079460999', '12']) {
          const answer = await plan(digits);
          expect({ digits, from: answer.from, caller: answer.caller }).toEqual({ digits, from: line.from, caller: line.caller });
        }
        for (const digits of ['999', '112']) {
          const answer = await plan(digits);
          expect(answer).toMatchObject({ action: 'emergency', organisationId: line.organisationId, from: line.from, caller: line.caller });
          expect(answer.emergency.presentNumber).toBe(line.from.presentNumber);
        }
      }
    });

    test('is in organisation order, then line order, with an organisation never split across pages', async () => {
      const whole = await pass();
      const order = (line) => [line.organisationId, line.from.lineNumber];
      const sorted = [...whole.lines].sort((x, y) => (x.organisationId === y.organisationId
        ? x.from.lineNumber - y.from.lineNumber
        : Buffer.compare(Buffer.from(x.organisationId), Buffer.from(y.organisationId))));
      expect(whole.lines.map(order)).toEqual(sorted.map(order));

      const byOne = await pass(1);
      expect(byOne.lines).toEqual(whole.lines);
      expect(byOne.pages.map((list) => new Set(list.map((line) => line.organisationId)).size)).toEqual([1, 1, 1]);
      expect(byOne.pages.find((list) => list[0].organisationId === orgs.a)).toHaveLength(2);
      for (const limit of [2, 3, 100]) expect((await pass(limit)).lines).toEqual(whole.lines);
    });

    test('the last page has no next, and a page after the last organisation is empty', async () => {
      let body = await ok(page('?limit=100'));
      while (body.next) body = await ok(page(`?limit=100&after=${encodeURIComponent(body.next)}`));
      expect(body.next).toBeNull();
      const last = Buffer.from('\u{10FFFF}', 'utf8').toString('base64url');
      expect(await ok(page(`?after=o1-${last}`))).toEqual({ lines: [], next: null });
    });

    test('refuses a page size out of range and a cursor that is not its own', async () => {
      for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?limit=many', '?after=nonsense', `?after=${orgs.a}`, '?after=o1-', '?after=o1-!!!']) {
        const res = await page(query);
        expect({ query, status: res.status }).toEqual({ query, status: 400 });
      }
      const res = await page('?limit=1.5');
      expect(res.body).toMatchObject({ code: 'bad_request', field: 'limit' });
      expect((await page('?after=nonsense')).body).toMatchObject({ code: 'bad_request', field: 'after' });
    });
  });

  describe('what is kept between passes', () => {
    const counting = () => {
      const read = [];
      return { read, loadSnapshot: async (id, options) => { read.push(id); return (await import('../lib/pbx/store.js')).loadSnapshot(id, options); } };
    };
    /** A whole pass through the module itself, with a count of the directories it read. */
    async function countedPass(deps) {
      let after;
      do {
        ({ next: after } = await lineList.listLines({ after, limit: 100 }, deps));
      } while (after);
    }
    const ours = (read) => read.filter((id) => Object.values(orgs).includes(id)).sort();

    test('a pass with nothing changed reads no directory, and a change reads that organisation only', async () => {
      lineList.forgetLines();
      const first = counting();
      await countedPass(first);
      expect(ours(first.read)).toEqual([orgs.a, orgs.b, orgs.c].sort());

      const second = counting();
      await countedPass(second);
      expect(second.read).toEqual([]);

      await ok(patch('ownerB', `/directory/entries/${made.bea.entry.id}`, { name: 'Bea Okafor-Lind' }));
      const third = counting();
      await countedPass(third);
      expect(third.read).toEqual([orgs.b]);
      expect((await lineOf('300', orgs.b)).caller.display).toBe('Bea O. 300');
      await ok(patch('ownerB', `/directory/entries/${made.bea.entry.id}`, { name: 'Bea Okafor' }));
    });

    test('an organisation is read again after six hours, whatever its marker says', async () => {
      lineList.forgetLines();
      let at = Date.parse('2026-11-27T09:00:00Z');
      const now = () => at;
      await countedPass({ ...counting(), now });
      at += lineList.KEPT_MS - 1000;
      const before = counting();
      await countedPass({ ...before, now });
      expect(before.read).toEqual([]);
      at += 1000;
      const after = counting();
      await countedPass({ ...after, now });
      expect(ours(after.read)).toEqual([orgs.a, orgs.b, orgs.c].sort());
    });
  });

  describe('a change to anything the blocks are worked out from', () => {
    const snapshot = async () => JSON.stringify((await pass()).lines);
    /**
     * Make a change, then compare what a warm server gives with what a server
     * that has just started gives. They must be equal, and not what was given
     * before the change.
     */
    async function changes(what, change) {
      const before = await snapshot();
      await change();
      const kept = await snapshot();
      const read = JSON.stringify(await fresh());
      expect({ what, kept }).toEqual({ what, kept: read });
      expect({ what, changed: kept !== before }).toEqual({ what, changed: true });
    }

    test('shows in the next pass', async () => {
      await changes('a number is routed to an extension', () => ok(put('ownerA', `/phone-endpoints/${ddi(2)}`, { extensionId: made.priya.extension.id })));
      expect((await lineOf('101')).from.presentNumber).toBe(`+${ddi(2)}`);
      await changes('the route is cleared', () => ok(put('ownerA', `/phone-endpoints/${ddi(2)}`, { extensionId: null })));
      expect((await lineOf('101')).from.presentNumber).toBeNull();

      await changes('the main number is set', () => ok(put('adminA', `/organisations/${orgs.a}/phone-system`, { mainNumber: `+${ddi(3)}` })));
      expect((await lineOf('101')).from.presentNumber).toBe(`+${ddi(3)}`);
      await changes('the main number is cleared', () => ok(put('adminA', `/organisations/${orgs.a}/phone-system`, { mainNumber: null })));

      await ok(put('ownerA', `/phone-endpoints/${ddi(4)}`, { extensionId: made.rob.extension.id }));
      // Two routed numbers and none chosen: no number to show.
      expect((await lineOf('100')).from.presentNumber).toBeNull();
      await changes('an extension is given the number it shows', () => ok(patch('ownerA', `/directory/extensions/${made.rob.extension.id}`, { outboundNumber: `+${ddi(4)}` })));
      expect((await lineOf('100')).from.presentNumber).toBe(`+${ddi(4)}`);
      await ok(patch('ownerA', `/directory/extensions/${made.rob.extension.id}`, { outboundNumber: null }));
      await ok(put('ownerA', `/phone-endpoints/${ddi(4)}`, { extensionId: null }));

      await changes('a person is renamed', () => ok(patch('ownerA', `/directory/entries/${made.priya.entry.id}`, { name: 'Maya Nair' })));
      expect((await lineOf('101')).caller.display).toBe('Maya N. 101');
      await ok(patch('ownerA', `/directory/entries/${made.priya.entry.id}`, { name: 'Priya Nair' }));
      await changes('an extension is renumbered', () => ok(patch('ownerA', `/directory/extensions/${made.priya.extension.id}`, { number: '111' })));
      expect((await lineOf('111')).caller.number).toBe('111');
      await ok(patch('ownerA', `/directory/extensions/${made.priya.extension.id}`, { number: '101' }));

      let spare;
      await changes('a phone is added', async () => { spare = await deskphone('ownerA', 5, 'Spare desk', [made.priya.entry.id]); });
      expect(await linesOf(orgs.a)).toHaveLength(3);
      await changes('a phone is removed', () => ok(del('ownerA', `/phones/${spare.id}`)));
      expect(await linesOf(orgs.a)).toHaveLength(2);
    });

    test('shows in the next pass when it is made in the database with no route', async () => {
      const line = await lineOf('100');
      const account = await PhoneRegistration.findOne({ where: { username: line.username } });
      const renamed = `l${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      await changes('an account gets a new SIP username', () => account.update({ username: renamed }));
      expect((await lineOf('100')).username).toBe(renamed);
      await account.update({ username: line.username });

      // 'Priya N. 101' is twelve characters. A D717 shows ten.
      const phone = await db.Phone.findByPk(made.priyaDesk.id);
      expect((await lineOf('101')).caller.display).toBe('Priya N. 101');
      await changes('a phone reports another model', () => db.Device.update({ reportedModel: 'D717' }, { where: { id: phone.deviceId } }));
      expect((await lineOf('101')).caller.display).not.toBe('Priya N. 101');
      await db.Device.update({ reportedModel: null }, { where: { id: phone.deviceId } });

      // A write that does not move updated_at.
      await ok(put('ownerA', `/phone-endpoints/${ddi(2)}`, { extensionId: made.priya.extension.id }));
      await changes('a row is changed by plain SQL', () => db.Extension.sequelize.query(
        'UPDATE extensions SET outbound_number = NULL, number = :number WHERE id = :id',
        { replacements: { number: '121', id: made.priya.extension.id } },
      ));
      await db.Extension.sequelize.query('UPDATE extensions SET number = :number WHERE id = :id', { replacements: { number: '101', id: made.priya.extension.id } });
      await ok(put('ownerA', `/phone-endpoints/${ddi(2)}`, { extensionId: null }));

      const robLine = (await lineOf('100')).from.lineId;
      const q = (sql, replacements) => db.Line.sequelize.query(sql, { replacements });
      await changes('a line is given another extension by plain SQL', () => q('UPDATE lines SET extension_id = :to WHERE id = :id', { to: made.priya.extension.id, id: robLine }));
      await q('UPDATE lines SET extension_id = :to WHERE id = :id', { to: made.rob.extension.id, id: robLine });
      await changes('a phone is marked removed by plain SQL', () => q('UPDATE phones SET removed_at = now() WHERE id = :id', { id: made.priyaDesk.id }));
      expect(await linesOf(orgs.a)).toHaveLength(1);
      await q('UPDATE phones SET removed_at = NULL WHERE id = :id', { id: made.priyaDesk.id });

      await changes('a number leaves the organisation', () => PhoneNumber.update({ organisationId: null, extensionId: null }, { where: { number: ddi(1), aplisayId: TRUNK } }));
      expect((await lineOf('100')).from.presentNumber).toBeNull();
      await PhoneNumber.update({ organisationId: orgs.a, extensionId: made.rob.extension.id }, { where: { number: ddi(1), aplisayId: TRUNK } });
      expect((await fresh()).find((row) => row.from.extensionNumber === '100').from.presentNumber).toBe(`+${ddi(1)}`);
    });

    test('a registration, a fetch or a call does not make the directory be read again', async () => {
      lineList.forgetLines();
      await pass();
      const line = await lineOf('100');
      const phone = await db.Phone.findByPk(made.robDesk.id);
      await PhoneRegistration.update({ lastSeenAt: new Date(), bindings: [{ contact: 'sip:x@192.0.2.1', expires: 60 }] }, { where: { username: line.username } });
      await db.Device.update({ lastFetchAt: new Date() }, { where: { id: phone.deviceId } });
      await PhoneNumber.update({ callReceived: new Date() }, { where: { number: ddi(1), aplisayId: TRUNK } });
      await Organisation.update({ name: 'Line list test A, renamed' }, { where: { id: orgs.a } });
      const read = [];
      const { loadSnapshot } = await import('../lib/pbx/store.js');
      let after;
      do {
        ({ next: after } = await lineList.listLines({ after, limit: 100 }, { loadSnapshot: (id, options) => { read.push(id); return loadSnapshot(id, options); } }));
      } while (after);
      expect(read).toEqual([]);
      await PhoneRegistration.update({ bindings: [] }, { where: { username: line.username } });
    });
  });

  describe('who may read it', () => {
    let guarded;

    beforeAll(async () => {
      process.env.SHARED_API_TOKEN = SHARED;
      process.env.CALLCTL_SHARED_TOKEN = CALLCTL;
      process.env.BETTER_AUTH_ENABLED = 'false';
      const { default: initAuth } = await import('../middleware/auth.js');
      const { default: route } = await import('../api/paths/agent-db/pbx/lines.js');
      const withAuth = express();
      withAuth.use((req, res, next) => { req.log = log; next(); });
      initAuth(withAuth, log);
      withAuth.get('/api/agent-db/pbx/lines', route(log).GET);
      guarded = await listen(withAuth);
    });

    afterAll(async () => {
      await new Promise((resolve) => guarded.close(resolve));
    });

    test('call control, and nobody else', async () => {
      const read = (headers = {}) => request(guarded).get('/api/agent-db/pbx/lines?limit=1').set(headers);
      const allowed = await read({ 'x-callctl-token': CALLCTL });
      expect(allowed.status).toBe(200);
      expect(Object.keys(allowed.body).sort()).toEqual(['lines', 'next']);
      for (const headers of [{}, { 'x-shared-token': SHARED }, { 'x-callctl-token': 'wrong' }, { 'x-callctl-token': SHARED }, { authorization: 'Bearer nothing' }]) {
        const res = await read(headers);
        expect({ headers, status: res.status }).toEqual({ headers, status: 403 });
      }
    });
  });

  describe('an organisation whose phone system is off', () => {
    test('is not listed while the capability is off or it is deactivated, and is listed again after', async () => {
      const username = (await lineOf('400', orgs.c)).username;
      await ok(put('operator', `/organisations/${orgs.c}/capabilities`, { capabilities: [] }));
      expect(await linesOf(orgs.c)).toEqual([]);
      await ok(put('operator', `/organisations/${orgs.c}/capabilities`, { capabilities: ['phoneSystem'] }));
      expect((await linesOf(orgs.c)).map((line) => line.username)).toEqual([username]);

      await ok(del('operator', `/organisations/${orgs.c}`));
      try {
        expect(await linesOf(orgs.c)).toEqual([]);
        expect((await linesOf(orgs.b)).length).toBe(1);
      } finally {
        await ok(patch('operator', `/organisations/${orgs.c}`, { status: 'active' }));
      }
      expect((await linesOf(orgs.c)).map((line) => line.username)).toEqual([username]);
    });
  });
});
