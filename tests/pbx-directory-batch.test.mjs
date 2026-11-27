/**
 * The directory API completed: the batch, restore and purge, next-number,
 * the views for agents, rings-now, the knowledge service's key, and the
 * refusal of our own extension digits in the outbound authorisation. Through
 * the real routes and the test database.
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
  PhoneNumber,
  PhoneRegistration,
} from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const REALM = 'sip.batch.test.example';
const TRUNK = `batch-test-trunk-${randomUUID().slice(0, 8)}`;

const listen = async (app) => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
};

describe('the directory API completed', () => {
  let app;
  let server;
  let db;
  let savedEnv;
  const users = {};
  const orgs = {};
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
  const batch = (user, body, query = '') => post(user, `/directory/batch${query}`, body);

  async function newOrg(name, capabilities = []) {
    const id = randomUUID();
    await Organisation.create({ id, name, capabilities });
    return id;
  }
  const counts = async (organisationId) => {
    const where = { organisationId };
    return {
      entries: await db.DirectoryEntry.count({ where }),
      extensions: await db.Extension.count({ where }),
      members: await db.ExtensionMember.count({ where }),
      lines: await db.Line.count({ where }),
      accounts: await PhoneRegistration.count({ where }),
    };
  };

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.PBX_REGISTRAR_DOMAIN = REALM;
    delete process.env.PBX_RELEASE;
    await setupRealDatabase();
    db = await import('../lib/database.js');

    orgs.on = await newOrg('Batch test, phone system', ['phoneSystem']);
    orgs.off = await newOrg('Batch test, switched off');
    orgs.golden = await newOrg('Batch test, golden directory');
    orgs.other = await newOrg('Batch test, another organisation', ['phoneSystem']);
    Object.assign(users, {
      ownerOn: { id: `owner-on-${stamp}`, organisationId: orgs.on, role: 'owner' },
      memberOn: { id: `member-on-${stamp}`, organisationId: orgs.on, role: 'member' },
      ownerOff: { id: `owner-off-${stamp}`, organisationId: orgs.off, role: 'owner' },
      ownerGolden: { id: `owner-golden-${stamp}`, organisationId: orgs.golden, role: 'owner' },
      ownerOther: { id: `owner-other-${stamp}`, organisationId: orgs.other, role: 'owner' },
      knowledge: { id: `knowledge-${stamp}`, organisationId: null, role: 'knowledgeService' },
      operator: { id: `operator-${stamp}`, organisationId: null, role: 'superAdmin' },
    });
    await db.Trunk.create({ id: TRUNK, name: 'Batch test trunk', handler: 'livekit' });
    for (const n of [1, 2]) await PhoneNumber.create({ number: ddi(n), handler: 'livekit', organisationId: orgs.on, aplisayId: TRUNK });

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
    for (const top of ['directory', 'phones', 'phone-endpoints']) {
      const files = [...(fs.existsSync(`./api/paths/${top}.js`) ? [`./api/paths/${top}.js`] : []), ...routeFiles(`./api/paths/${top}`)];
      for (const file of files) await import(`.${file}`);
    }
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{directory,phones,phone-endpoints}{.js,/**/*.js}',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    server = await listen(app);
  }, 60000);

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    const ids = Object.values(orgs);
    const where = { organisationId: ids };
    for (const model of ['Line', 'PhoneChange', 'PhonePerson', 'PhoneRule', 'Phone', 'Device', 'ExtensionMember']) {
      await db[model].destroy({ where });
    }
    await PhoneNumber.destroy({ where });
    await PhoneRegistration.destroy({ where });
    await db.Extension.destroy({ where });
    await db.DirectoryEntry.destroy({ where });
    await User.destroy({ where });
    await db.Trunk.destroy({ where: { id: TRUNK } });
    await Organisation.destroy({ where: { id: ids } });
    process.env = savedEnv;
    await teardownRealDatabase();
  }, 60000);

  describe('the batch', () => {
    test('applies every op in one go, with refs to rows made earlier in it', async () => {
      const out = await ok(batch('ownerOn', {
        actor: 'import',
        instructionText: 'Add the warehouse',
        ops: [
          { op: 'entry.create', ref: 'dan', entry: { kind: 'person', name: 'Dan Price', role: 'Picker', mobile: '07700 900501' } },
          { op: 'extension.create', ref: 'danExt', extension: { number: '106', type: 'ring_all', entryId: '$dan' } },
          { op: 'entry.create', ref: 'wh', entry: { kind: 'team', name: 'Warehouse' } },
          { op: 'extension.create', extension: { number: '230', type: 'ring_all', entryId: '$wh', members: ['$dan'] } },
          { op: 'entry.update', id: '$dan', fields: { hours: 'Mon-Fri 8-4' } },
        ],
      }));
      expect(out.applied).toBe(5);
      expect(out.results.every((r) => r.ok)).toBe(true);
      const dan = out.entries.find((e) => e.name === 'Dan Price');
      expect(dan).toMatchObject({ id: out.results[0].id, extension: '106', extensionType: 'ring_all', hours: 'Mon-Fri 8-4', mobile: '+447700900501' });
      expect(dan.memberships.map((m) => m.number)).toEqual(['230']);
      expect(out.results[1].id).toBe(dan.extensionId);
      // A person's own member row is not a change of its own: it comes with the extension.
      expect(out.changes.filter((c) => c.op === 'create').map((c) => c.target)).toEqual(['entry', 'extension', 'entry', 'extension', 'member']);
    });

    test('a refused op changes nothing, and says which op and why', async () => {
      const before = await counts(orgs.on);
      const res = await batch('ownerOn', {
        ops: [
          { op: 'entry.create', ref: 'a', entry: { kind: 'person', name: 'Ann Lee' } },
          { op: 'extension.create', extension: { number: '106', type: 'ring_all', entryId: '$a' } },
          { op: 'entry.create', entry: { kind: 'person', name: 'Never Made' } },
        ],
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('batch_failed');
      expect(res.body.results).toHaveLength(2);
      expect(res.body.results[0]).toMatchObject({ ok: true });
      expect(res.body.results[1]).toMatchObject({ ok: false, code: 'extension_number_taken', field: 'number' });
      expect(await counts(orgs.on)).toEqual(before);
    });

    test('refuses an unknown op, a ref used twice, and more than 500 ops', async () => {
      // The request schema refuses an op it does not know before the route runs.
      expect((await batch('ownerOn', { ops: [{ op: 'entry.explode' }] })).status).toBe(400);
      const twice = await batch('ownerOn', { ops: [
        { op: 'entry.create', ref: 'x', entry: { name: 'X One' } },
        { op: 'entry.create', ref: 'x', entry: { name: 'X Two' } },
      ] });
      expect(twice.body.results[1]).toMatchObject({ ok: false, code: 'invalid_ref' });
      const many = Array.from({ length: 501 }, (_, i) => ({ op: 'entry.create', entry: { name: `P ${i}` } }));
      const res = await batch('ownerOn', { ops: many });
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 413, code: 'too_many_ops' });
      expect((await batch('ownerOn', { ops: [] })).status).toBe(400);
    });

    test('a dry run changes nothing and reports what the real batch then does', async () => {
      const { entries } = await ok(get('ownerOn', '/directory/entries'));
      const dan = entries.find((e) => e.name === 'Dan Price');
      const desk = (await ok(post('ownerOn', '/phones', { kind: 'deskphone', mac: mac(1), model: 'D713', label: 'Dan desk', people: [dan.id] }), 201)).phone;
      expect(desk.lines.map((l) => l.number)).toEqual(['106', '230']);
      const sales = await ok(post('ownerOn', '/directory/entries', { kind: 'team', name: 'Sales', extension: '200', extensionType: 'ring_all' }), 201);
      const body = { ops: [{ op: 'member.add', extensionId: sales.entry.extensionId, entryId: dan.id }] };
      const before = await counts(orgs.on);
      const dry = await ok(batch('ownerOn', body, '?dryRun=true'));
      expect(dry).toMatchObject({ dryRun: true, results: [{ ok: true }] });
      expect(dry.entries).toBeUndefined();
      expect(await counts(orgs.on)).toEqual(before);
      const real = await ok(batch('ownerOn', body));
      expect(real.effect.phones.map((p) => p.after.map((k) => k.extensionId))).toEqual(dry.effect.phones.map((p) => p.after.map((k) => k.extensionId)));
      expect(real.effect.linesAdded).toBe(1);
      const lines = await ok(get('ownerOn', `/phones/${desk.id}/lines`));
      expect(lines.lines.map((l) => l.number)).toEqual(['106', '230', '200']);
    });

    test('orders: a hunt order must name every member, a key order every shared extension', async () => {
      const { entries } = await ok(get('ownerOn', '/directory/entries'));
      const dan = entries.find((e) => e.name === 'Dan Price');
      const [first, second] = dan.memberships.map((m) => m.extensionId);
      const res = await ok(batch('ownerOn', { ops: [{ op: 'keyOrder.set', entryId: dan.id, extensionIds: [second, first] }] }));
      expect(res.entries.find((e) => e.id === dan.id).memberships.map((m) => m.extensionId)).toEqual([second, first]);
      const wrong = await batch('ownerOn', { ops: [{ op: 'huntOrder.set', extensionId: first, entryIds: [] }] });
      expect(wrong.body.results[0]).toMatchObject({ ok: false, code: 'hunt_order_mismatch' });
    });

    test('an organisation without the phone system is refused its ops with the stable code', async () => {
      const res = await batch('ownerOff', { ops: [
        { op: 'entry.create', ref: 'p', entry: { kind: 'person', name: 'Pat Doe' } },
        { op: 'extension.create', extension: { number: '200', type: 'ring_all', entryId: '$p' } },
      ] });
      expect(res.body.results[1]).toMatchObject({ ok: false, code: 'phone_system_disabled', field: 'type' });
      // Today's product still works through the batch.
      const fine = await ok(batch('ownerOff', { ops: [{ op: 'entry.create', entry: { kind: 'person', name: 'Pat Doe', extension: '310' } }] }));
      expect(fine.entries.map((e) => [e.name, e.extension, e.extensionType])).toEqual([['Pat Doe', '310', 'connection']]);
    });

    test('a member reads but cannot write, and another organisation sees nothing', async () => {
      expect((await batch('memberOn', { ops: [{ op: 'entry.create', entry: { name: 'Nope' } }] })).status).toBe(403);
      const { entries } = await ok(get('ownerOn', '/directory/entries'));
      const res = await batch('ownerOther', { ops: [{ op: 'entry.update', id: entries[0].id, fields: { role: 'Boss' } }] });
      expect(res.body.results[0]).toMatchObject({ ok: false, code: 'not_found' });
    });
  });

  describe("the knowledge service's key", () => {
    test('writes what a crawl finds, for the organisation it names, as the crawl', async () => {
      const out = await ok(batch('knowledge', { actor: 'crawl', ops: [
        { op: 'entry.create', ref: 'k', entry: { kind: 'person', name: 'Kim Ode', role: 'Buyer', notes: { source: 'crawl', sourceRef: 'https://example.co.uk/team' } } },
        { op: 'extension.create', extension: { number: '412', entryId: '$k' } },
      ] }, `?organisationId=${orgs.off}`));
      const kim = out.entries.find((e) => e.name === 'Kim Ode');
      expect(kim).toMatchObject({ extension: '412', extensionType: 'connection', createdBy: 'system:crawl', notes: { source: 'crawl' } });
    });

    test('may not do anything else', async () => {
      const crawlOther = await batch('knowledge', { actor: 'crawl', ops: [{ op: 'entry.delete', id: randomUUID() }] }, `?organisationId=${orgs.off}`);
      expect(crawlOther.body.results[0]).toMatchObject({ ok: false, code: 'op_not_allowed' });
      const ourType = await batch('knowledge', { actor: 'crawl', ops: [{ op: 'extension.create', extension: { number: '499', type: 'ring_all', entryId: randomUUID() } }] }, `?organisationId=${orgs.on}`);
      expect(ourType.body.results[0]).toMatchObject({ ok: false, code: 'op_not_allowed' });
      expect((await batch('knowledge', { actor: 'import', ops: [{ op: 'entry.create', entry: { name: 'X' } }] }, `?organisationId=${orgs.off}`)).body.code).toBe('crawl_only');
      expect((await post('knowledge', `/directory/entries?organisationId=${orgs.off}`, { name: 'X' })).body.code).toBe('crawl_only');
      expect((await batch('knowledge', { actor: 'crawl', ops: [{ op: 'entry.create', entry: { name: 'X' } }] })).body.code).toBe('organisation_required');
      expect((await get('knowledge', `/phones?organisationId=${orgs.on}`)).status).toBe(403);
    });

    test('nobody else writes as the crawl', async () => {
      const res = await batch('ownerOff', { actor: 'crawl', ops: [{ op: 'entry.create', entry: { name: 'X' } }] });
      expect({ status: res.status, code: res.body.code }).toEqual({ status: 403, code: 'actor_not_allowed' });
    });

    test('reads any organisation through the agent views', async () => {
      const found = await ok(get('knowledge', `/directory/lookup?organisationId=${orgs.off}&query=kim`));
      expect(found.matches.map((m) => m.name)).toEqual(['Kim Ode']);
      expect((await get('ownerOn', `/directory/lookup?organisationId=${orgs.off}`)).status).toBe(404);
    });
  });

  describe('restore and purge', () => {
    test('a removed person comes back with their extension, membership and phone', async () => {
      const { entries } = await ok(get('ownerOn', '/directory/entries'));
      const dan = entries.find((e) => e.name === 'Dan Price');
      const [phone] = (await ok(get('ownerOn', '/phones'))).phones.filter((p) => p.label === 'Dan desk');
      const linesBefore = phone.lines.map((l) => l.number);
      await ok(del('ownerOn', `/directory/entries/${dan.id}`));
      expect((await ok(get('ownerOn', `/phones/${phone.id}/lines`))).lines).toEqual([]);

      const dry = await ok(post('ownerOn', `/directory/entries/${dan.id}/restore?dryRun=true`));
      expect(dry.dryRun).toBe(true);
      expect((await get('ownerOn', `/directory/entries/${dan.id}`)).status).toBe(404);

      const back = await ok(post('ownerOn', `/directory/entries/${dan.id}/restore`));
      expect(back.entry).toMatchObject({ name: 'Dan Price', extension: '106', extensionType: 'ring_all' });
      expect(back.entry.memberships.length).toBe(2);
      expect(back.changes.map((c) => [c.target, c.op])).toEqual([['extension', 'restore'], ['entry', 'restore']]);
      expect((await ok(get('ownerOn', `/phones/${phone.id}/lines`))).lines.map((l) => l.number)).toEqual(linesBefore);
      expect((await post('ownerOn', `/directory/entries/${dan.id}/restore`)).status).toBe(404);
    });

    test('a restore is refused when its number has been taken since', async () => {
      const made = await ok(post('ownerOn', '/directory/entries', { kind: 'person', name: 'Eve Holt', extension: '107', extensionType: 'ring_all' }), 201);
      await ok(del('ownerOn', `/directory/entries/${made.entry.id}`));
      const taker = await ok(post('ownerOn', '/directory/entries', { kind: 'person', name: 'Fay Ward', extension: '107', extensionType: 'ring_all' }), 201);
      const refused = await post('ownerOn', `/directory/entries/${made.entry.id}/restore`);
      expect({ status: refused.status, code: refused.body.code }).toEqual({ status: 409, code: 'extension_number_taken' });
      expect((await get('ownerOn', `/directory/entries/${made.entry.id}`)).status).toBe(404);
      // Undo of the taker, then the restore works.
      await ok(del('ownerOn', `/directory/entries/${taker.entry.id}`));
      await ok(post('ownerOn', `/directory/entries/${made.entry.id}/restore`));
    });

    test('an extension comes back on its own, but not while its entry is removed', async () => {
      const made = await ok(post('ownerOn', '/directory/entries', { kind: 'team', name: 'Returns', extension: '240', extensionType: 'ring_all' }), 201);
      const extensionId = made.entry.extensionId;
      await ok(patch('ownerOn', `/directory/entries/${made.entry.id}`, { extension: null }));
      const back = await ok(post('ownerOn', `/directory/extensions/${extensionId}/restore`));
      expect(back.extension).toMatchObject({ number: '240', type: 'ring_all', name: 'Returns' });
      await ok(del('ownerOn', `/directory/entries/${made.entry.id}`));
      expect((await post('ownerOn', `/directory/extensions/${extensionId}/restore`)).body.code).toBe('entry_removed');
      // The batch carries restores too.
      const res = await ok(batch('ownerOn', { ops: [{ op: 'entry.restore', id: made.entry.id }] }));
      expect(res.entries.find((e) => e.id === made.entry.id)).toMatchObject({ extension: '240' });
    });

    test('a restored person whose login is linked elsewhere comes back without the link', async () => {
      const login = `login-${stamp}`;
      await User.create({ id: login, name: 'Gus', email: `${login}@example.invalid`, organisationId: orgs.on, role: 'member', status: 'active' });
      const gus = await ok(post('ownerOn', '/directory/entries', { kind: 'person', name: 'Gus Hart', loginUserId: login }), 201);
      await ok(del('ownerOn', `/directory/entries/${gus.entry.id}`));
      await ok(post('ownerOn', '/directory/entries', { kind: 'person', name: 'Gus Hart (new)', loginUserId: login }), 201);
      const back = await ok(post('ownerOn', `/directory/entries/${gus.entry.id}/restore`));
      expect(back.entry.loginUserId).toBeNull();
    });

    test('rows removed more than 30 days ago are purged, and then cannot be restored', async () => {
      const { purgeRemoved } = await import('../lib/pbx/purge.js');
      const made = await ok(post('ownerOn', '/directory/entries', { kind: 'person', name: 'Old Timer', extension: '150', extensionType: 'ring_all' }), 201);
      const recent = await ok(post('ownerOn', '/directory/entries', { kind: 'person', name: 'Just Gone' }), 201);
      await ok(del('ownerOn', `/directory/entries/${made.entry.id}`));
      await ok(del('ownerOn', `/directory/entries/${recent.entry.id}`));
      const longAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
      await db.DirectoryEntry.update({ deletedAt: longAgo }, { where: { id: made.entry.id } });
      await db.Extension.update({ deletedAt: longAgo }, { where: { id: made.entry.extensionId }, validate: false });
      const purged = await purgeRemoved({ organisationId: orgs.on });
      expect(purged).toEqual({ entries: 1, extensions: 1 });
      expect(await db.DirectoryEntry.findByPk(made.entry.id)).toBeNull();
      expect(await db.ExtensionMember.count({ where: { entryId: made.entry.id } })).toBe(0);
      expect((await post('ownerOn', `/directory/entries/${made.entry.id}/restore`)).status).toBe(404);
      // Removed a moment ago: kept.
      expect(await db.DirectoryEntry.findByPk(recent.entry.id)).not.toBeNull();
      expect(await purgeRemoved({ organisationId: orgs.on })).toEqual({ entries: 0, extensions: 0 });
    });
  });

  describe('next-number', () => {
    test('offers the lowest free number of the usual length, or of the length asked for', async () => {
      const used = (await ok(get('ownerOn', '/directory/extensions'))).extensions.map((e) => e.number);
      expect(used).toEqual(expect.arrayContaining(['106', '107', '200', '230', '240']));
      expect(await ok(get('ownerOn', '/directory/extensions/next-number'))).toEqual({ number: '100' });
      await ok(post('ownerOn', '/directory/entries', { kind: 'team', name: 'Front desk', extension: '100' }), 201);
      expect(await ok(get('ownerOn', '/directory/extensions/next-number?near=105'))).toEqual({ number: '101' });
      expect(await ok(get('ownerOn', '/directory/extensions/next-number?near=4000'))).toEqual({ number: '1000' });
      expect((await get('ownerOn', '/directory/extensions/next-number?near=abc')).status).toBe(400);
    });
  });

  describe('the views for agents', () => {
    const fixture = JSON.parse(fs.readFileSync(new URL('./fixtures/directory-golden/contacts.json', import.meta.url), 'utf8'));
    const golden = JSON.parse(fs.readFileSync(new URL('./fixtures/directory-golden/golden.json', import.meta.url), 'utf8'));
    const keyOf = new Map();
    const idOf = new Map();

    beforeAll(async () => {
      for (const f of fixture) {
        let loginUserId;
        if (f.login) {
          loginUserId = `login-${f.key}-${stamp}`;
          await User.create({ id: loginUserId, name: f.name, email: `${loginUserId}@example.invalid`, organisationId: orgs.golden, role: 'member', status: 'active' });
        }
        const { key, login, ...fields } = f;
        const { entry } = await ok(post('ownerGolden', '/directory/entries', { ...fields, ...(loginUserId ? { loginUserId } : {}) }), 201);
        keyOf.set(entry.id, key);
        idOf.set(key, entry.id);
      }
    });

    // The crawler's answers name the fixture's keys; ours name row ids, and the
    // linked login is a different id. Everything else must be equal.
    const asKeys = (value) => JSON.parse(JSON.stringify(value), (k, v) => (k === 'id' && keyOf.has(v) ? keyOf.get(v) : v));

    test.each(golden.lookup.map((row) => [JSON.stringify({ query: row.query, kind: row.kind, limit: row.limit }), row]))('lookup %s equals the crawler', async (_, row) => {
      const qs = new URLSearchParams({ query: row.query, ...(row.kind ? { kind: row.kind } : {}), ...(row.limit ? { limit: String(row.limit) } : {}) });
      expect(asKeys(await ok(get('ownerGolden', `/directory/lookup?${qs}`)))).toEqual(row.answer);
    });

    test.each(golden.resolve.map((row) => [JSON.stringify(row.query ?? row.contact ?? row.contactId), row]))('resolve %s equals the crawler', async (_, row) => {
      const contactId = row.contact ? idOf.get(row.contact) : row.contactId;
      const qs = new URLSearchParams({ ...(row.query !== undefined ? { query: row.query } : {}), ...(contactId ? { contact_id: contactId } : {}), ...(row.kind ? { kind: row.kind } : {}) });
      expect(asKeys(await ok(get('ownerGolden', `/directory/resolve?${qs}`)))).toEqual(row.answer);
    });

    test('resolve needs a query or an id', async () => {
      const res = await get('ownerGolden', '/directory/resolve');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ status: 'none', match: null, candidates: [] });
    });

    test('with the phone system, an extension of ours with no direct number gives the number it shows', async () => {
      await ok(put('ownerOn', `/phone-endpoints/${ddi(1)}`, { extensionId: (await ok(get('ownerOn', '/directory/entries'))).entries.find((e) => e.name === 'Sales').extensionId }));
      const sales = await ok(get('ownerOn', '/directory/resolve?query=sales&kind=team'));
      expect(sales.match).toMatchObject({ name: 'Sales', extension: '200', direct: `+${ddi(1)}` });
      // No new field that holds a number.
      expect(Object.keys(sales.match).sort()).toEqual(['about', 'department', 'direct', 'extension', 'hours', 'id', 'kind', 'message_to', 'mobile', 'name', 'notes_for_agent', 'role']);
      const lookup = await ok(get('ownerOn', '/directory/lookup?query=sales&kind=team'));
      expect(lookup.matches[0]).not.toHaveProperty('availability');
    });
  });

  describe('rings-now', () => {
    test('lists each phone that would ring, marks one that is offline, and an outside number after its delay', async () => {
      const { entries } = await ok(get('ownerOn', '/directory/entries'));
      const dan = entries.find((e) => e.name === 'Dan Price');
      const desk = (await ok(get('ownerOn', '/phones'))).phones.find((p) => p.label === 'Dan desk');
      await ok(post('ownerOn', '/phones', { kind: 'external', number: '07700 900777', label: 'Dan mobile', ringDelay: 10, people: [dan.id] }), 201);
      const own = desk.lines.find((l) => l.number === '106');
      const line = await db.Line.findByPk(own.id);
      await PhoneRegistration.update({ bindings: [{ contact: 'sip:x@192.0.2.1' }] }, { where: { id: line.endpointId } });

      const now = await ok(get('ownerOn', `/directory/extensions/${dan.extensionId}/rings-now`));
      expect(now).toMatchObject({ number: '106', name: 'Dan Price', action: 'ring', open: true });
      expect(now.rings.map((r) => [r.label, r.state, r.afterSeconds])).toEqual([['Dan desk', 'rings', 0], ['Dan mobile', 'rings', 10]]);
      expect(now.summary).toBe('Rings 2 phones now.');

      const warehouse = entries.find((e) => e.name === 'Warehouse');
      const team = await ok(get('ownerOn', `/directory/extensions/${warehouse.extensionId}/rings-now`));
      expect(team.rings.map((r) => [r.label, r.state])).toEqual([['Dan desk', 'not_connected'], ['Dan mobile', 'mobile_not_for_shared']]);
      expect(team.summary).toBe("No phone rings now. Dan Price's Dan desk is offline. Dan Price's Dan mobile rings only for their own extension.");
    });

    test('needs the phone system, and a real time', async () => {
      const { extensions } = await ok(get('ownerOff', '/directory/extensions'));
      expect((await get('ownerOff', `/directory/extensions/${extensions[0].id}/rings-now`)).body.code).toBe('phone_system_disabled');
      const { entries } = await ok(get('ownerOn', '/directory/entries'));
      const dan = entries.find((e) => e.name === 'Dan Price');
      expect((await get('ownerOn', `/directory/extensions/${dan.extensionId}/rings-now?at=yesterday`)).status).toBe(400);
      expect((await get('ownerOther', `/directory/extensions/${dan.extensionId}/rings-now`)).status).toBe(404);
    });
  });

  describe('extension digits in the outbound authorisation', () => {
    test('an extension of ours is refused with its own reason, an extension on the customer system is not', async () => {
      const { authoriseOutboundDestination } = await import('../lib/outbound-authorisation.js');
      const agentOptions = { outboundCallFilter: '^(\\+?\\d{10,15}|\\d{3,4})$' };
      const ours = await authoriseOutboundDestination({ calledId: '200', organisationId: orgs.on, agentOptions, registrationOriginated: true });
      expect(ours).toMatchObject({ allowed: false, code: 'internal_extension_not_reachable' });
      const theirs = await authoriseOutboundDestination({ calledId: '310', organisationId: orgs.off, agentOptions, registrationOriginated: true });
      expect(theirs).toMatchObject({ allowed: true });
      // A removed extension no longer counts.
      const unused = await authoriseOutboundDestination({ calledId: '107', organisationId: orgs.other, agentOptions, registrationOriginated: true });
      expect(unused.allowed).toBe(true);
    });
  });
});
