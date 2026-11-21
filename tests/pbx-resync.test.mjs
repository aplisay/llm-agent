/**
 * Asking a desk phone to fetch its settings: which phones call control is
 * given and when, through the real route and its token check, on the test
 * database.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import { setupRealDatabase, teardownRealDatabase, Organisation, PhoneRegistration } from './setup/database-test-wrapper.js';
import { resyncDue, RESYNC_WAITS_MS, RESYNC_MAX_ASKS, RESYNC_MIN_GAP_MS, RESYNC_MAX_HELD } from '../lib/pbx/resync-rules.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const TOKEN = 'test-callctl-token';
const SHARED = 'test-worker-token';
const MINUTE = 60 * 1000;
const CLAIM = '/api/agent-db/pbx/resync/claim';

describe('when a phone is due to be asked', () => {
  const at = Date.parse('2026-01-01T12:00:00Z');
  const device = (fields) => ({ configVersion: 5, resyncVersion: 5, resyncAttempts: 0, resyncRequestedAt: null, ...fields });

  test('at once for a new version, then after 1, 5, 15 and 60 minutes and 6 hours, then no more', () => {
    expect(resyncDue(device({ resyncVersion: null, resyncAttempts: null }), at)).toEqual({ due: true, attempts: 0 });
    expect(RESYNC_WAITS_MS.map((ms) => ms / MINUTE)).toEqual([1, 5, 15, 60, 360]);
    RESYNC_WAITS_MS.forEach((wait, i) => {
      const asked = device({ resyncAttempts: i + 1, resyncRequestedAt: new Date(at) });
      expect(resyncDue(asked, at + wait - 1000).due).toBe(false);
      expect(resyncDue(asked, at + wait)).toEqual({ due: true, attempts: i + 1 });
    });
    expect(RESYNC_MAX_ASKS).toBe(6);
    expect(resyncDue(device({ resyncAttempts: 6, resyncRequestedAt: new Date(at) }), at + 365 * 24 * 60 * MINUTE).due).toBe(false);
  });

  test('a new version starts the count again, but not within 10 seconds of the last ask', () => {
    const changed = device({ configVersion: 6, resyncAttempts: 6, resyncRequestedAt: new Date(at) });
    expect(RESYNC_MIN_GAP_MS).toBe(10 * 1000);
    expect(resyncDue(changed, at + RESYNC_MIN_GAP_MS - 1)).toEqual({ due: false, attempts: 0 });
    expect(resyncDue(changed, at + RESYNC_MIN_GAP_MS)).toEqual({ due: true, attempts: 0 });
  });
});

describe('the phones call control is given', () => {
  let api;
  let db;
  let resync;
  let savedEnv;
  const users = {};
  const orgs = {};
  const made = {};
  const stamp = String(Date.now()).slice(-6);
  const mac = (n) => `000413${stamp.slice(-4)}${String(n).padStart(2, '0')}`;

  const call = (method) => (user, path, body) => {
    const req = request(api)[method](`/api${path}`).set('x-test-user', user);
    return body === undefined ? req : req.send(body);
  };
  const get = call('get');
  const post = call('post');
  const ok = async (pending, status = 200) => {
    const res = await pending;
    if (res.status !== status) throw new Error(`expected ${status}, got ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body;
  };
  /** As call control asks. Other suites share the database, so only this suite's phones are returned. */
  const claim = async (body = {}) => {
    const { phones } = await ok(request(api).post(CLAIM).set('x-callctl-token', TOKEN).send(body));
    return phones.filter((phone) => Object.values(orgs).includes(phone.organisationId));
  };
  const takeFor = (organisationId, options = {}) => resync.claimDueResyncs({ organisationId, log, ...options });
  const team = async (name, number, members = [made.ada.id]) => {
    const { entry } = await ok(post('ownerA', '/directory/entries', { kind: 'team', name }), 201);
    await ok(post('ownerA', '/directory/extensions', { number, type: 'ring_all', entryId: entry.id, members }), 201);
  };
  const deviceOf = (phone) => db.Device.findByPk(phone.device.id);
  /** As the provisioning service leaves a device after a good fetch, a minute after any ask. */
  const fetched = async (phone) => {
    const device = await deviceOf(phone);
    await device.update({
      provisioningState: 'fetched',
      fetchedVersion: device.configVersion,
      tokenHash: 'x'.repeat(64),
      ...(device.resyncRequestedAt ? { resyncRequestedAt: new Date(Date.now() - MINUTE) } : {}),
    });
  };
  /** Move the phone's last ask into the past. */
  const age = async (phone, ms) => {
    const device = await deviceOf(phone);
    await device.update({ resyncRequestedAt: new Date(device.resyncRequestedAt.getTime() - ms) });
  };
  /** A change to the settings that no write on this process made. */
  const bump = async (phone) => {
    const device = await deviceOf(phone);
    await device.update({ provisioningState: 'updating', configVersion: device.configVersion + 1 });
    return device.configVersion;
  };
  const usernames = async (phone) => {
    const lines = await db.Line.findAll({ where: { phoneId: phone.id }, order: [['position', 'ASC']] });
    const accounts = await PhoneRegistration.findAll({ where: { id: lines.map((line) => line.endpointId) } });
    return lines.map((line) => accounts.find((account) => account.id === line.endpointId).username);
  };
  const resyncShown = async (phone) => (await ok(get('ownerA', `/phones/${phone.id}`))).device.resync;

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.PBX_REGISTRAR_DOMAIN = 'sip.resync.test.example';
    process.env.PBX_LINE_PASSWORD_RESET = 'true';
    delete process.env.PBX_RELEASE;
    process.env.CALLCTL_SHARED_TOKEN = TOKEN;
    process.env.SHARED_API_TOKEN = SHARED;
    await setupRealDatabase();
    db = await import('../lib/database.js');
    resync = await import('../lib/pbx/resync.js');
    // The sign-in module needs its own settings to load. The call control token is checked before it.
    process.env.BETTER_AUTH_ENABLED = 'false';
    const { default: initAuth } = await import('../middleware/auth.js');

    for (const name of ['a', 'b', 'c']) {
      orgs[name] = randomUUID();
      await Organisation.create({ id: orgs[name], name: `Resync test ${name}`, capabilities: ['phoneSystem'] });
    }
    Object.assign(users, {
      ownerA: { id: `resync-owner-a-${stamp}`, organisationId: orgs.a, role: 'owner' },
      ownerB: { id: `resync-owner-b-${stamp}`, organisationId: orgs.b, role: 'owner' },
    });
    const app = express();
    app.use(express.json());
    // A test user for the directory routes. Everything else goes through the server's own checks.
    const checks = express.Router();
    initAuth(checks, log);
    app.use((req, res, next) => {
      req.log = log;
      const user = users[req.headers['x-test-user']];
      if (!user) return checks(req, res, next);
      res.locals.user = user;
      return next();
    });
    // Loaded one by one first: see tests/pbx-directory-api.test.mjs.
    const routeFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) return routeFiles(path);
      return item.name.endsWith('.js') ? [path] : [];
    });
    for (const top of ['directory', 'phones', 'agent-db/pbx/resync']) {
      const files = [...(fs.existsSync(`./api/paths/${top}.js`) ? [`./api/paths/${top}.js`] : []), ...routeFiles(`./api/paths/${top}`)];
      for (const file of files) await import(`.${file}`);
    }
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{directory,phones,agent-db/pbx/resync}{.js,/**/*.js}',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    api = http.createServer(app);
    api.listen(0, '127.0.0.1');
    await new Promise((resolve) => api.once('listening', resolve));

    made.ada = (await ok(post('ownerA', '/directory/entries', { kind: 'person', name: 'Ada Byron' }), 201)).entry;
    await ok(post('ownerA', '/directory/extensions', { number: '100', type: 'ring_all', entryId: made.ada.id }), 201);
    await team('Sales', '200');
    made.phone = (await ok(post('ownerA', '/phones', { kind: 'deskphone', mac: mac(1), model: 'D735', label: 'Ada desk', people: [made.ada.id] }), 201)).phone;
  }, 120000);

  afterAll(async () => {
    if (api) await new Promise((resolve) => api.close(resolve));
    const where = { organisationId: Object.values(orgs) };
    for (const model of ['Line', 'PhoneChange', 'PhonePerson', 'PhoneRule', 'Phone', 'Device', 'ExtensionMember']) {
      await db[model].destroy({ where });
    }
    await PhoneRegistration.destroy({ where });
    await db.Extension.destroy({ where });
    await db.DirectoryEntry.destroy({ where });
    await Organisation.destroy({ where: { id: Object.values(orgs) } });
    process.env = savedEnv;
    await teardownRealDatabase();
  }, 60000);

  test('the route takes the call control token only', async () => {
    expect((await request(api).post(CLAIM).send({})).status).toBe(403);
    expect((await request(api).post(CLAIM).set('x-callctl-token', 'wrong').send({})).status).toBe(403);
    expect((await request(api).post(CLAIM).set('x-callctl-token', SHARED).send({})).status).toBe(403);
    expect((await request(api).post(CLAIM).set('x-shared-token', SHARED).send({})).status).toBe(403);
    expect((await request(api).post(CLAIM).set('x-callctl-token', TOKEN).send({})).status).toBe(200);
    expect((await request(api).post(CLAIM).set('x-callctl-token', TOKEN).send({ limit: 101 })).status).toBe(400);
    expect((await request(api).post(CLAIM).set('x-callctl-token', TOKEN).send({ waitSeconds: 31 })).status).toBe(400);
  });

  test('a phone that has never fetched, or is wiped, is not given', async () => {
    const fresh = (await ok(post('ownerA', '/phones', { kind: 'deskphone', mac: mac(2), model: 'D735', label: 'New phone', people: [] }), 201)).phone;
    const wiped = (await ok(post('ownerA', '/phones', { kind: 'deskphone', mac: mac(3), model: 'D735', label: 'Wiped phone', people: [] }), 201)).phone;
    await (await deviceOf(wiped)).update({ provisioningState: 'wiped' });
    await ok(post('ownerA', `/phones/${fresh.id}/people`, { entryId: made.ada.id }), 201);
    await ok(post('ownerA', `/phones/${wiped.id}/people`, { entryId: made.ada.id }), 201);
    expect(await claim()).toEqual([]);
    expect((await deviceOf(fresh)).provisioningState).toBe('waiting');
    expect((await deviceOf(wiped)).provisioningState).toBe('wiped');
  });

  test('after a directory change the phone is given once, with its lines in key order and nothing secret', async () => {
    await fetched(made.phone);
    const before = await deviceOf(made.phone);
    await team('Accounts', '202');
    // Nothing is counted until call control asks.
    expect(await deviceOf(made.phone)).toMatchObject({ provisioningState: 'updating', resyncVersion: null, resyncAttempts: null });
    expect(await resyncShown(made.phone)).toBeNull();

    const given = await claim();
    const names = await usernames(made.phone);
    expect(names).toHaveLength(3);
    expect(given).toEqual([{
      deviceId: made.phone.device.id,
      phoneId: made.phone.id,
      organisationId: orgs.a,
      configVersion: before.configVersion + 1,
      attempt: 1,
      action: 'check-sync',
      lines: names,
    }]);
    expect(JSON.stringify(given)).not.toMatch(/ha1|password|token|mac/i);
    expect(await claim()).toEqual([]);

    const after = await deviceOf(made.phone);
    expect(after).toMatchObject({ provisioningState: 'updating', resyncVersion: after.configVersion, resyncAttempts: 1, resyncState: 'taken' });
    expect(await resyncShown(made.phone)).toMatchObject({ attempts: 1, state: 'taken' });
  });

  test('what call control reports is kept for the ask it names, and for no other', async () => {
    const device = await deviceOf(made.phone);
    const report = (fields) => ({ deviceId: device.id, configVersion: device.configVersion, attempt: 1, state: 'sent', ...fields });
    expect(await claim({ limit: 0, results: [report({ state: 'held' })] })).toEqual([]);
    expect(await resyncShown(made.phone)).toMatchObject({ attempts: 1, state: 'held' });
    // A report for another ask or another version changes nothing.
    await claim({ limit: 0, results: [report({ attempt: 2 }), report({ configVersion: device.configVersion - 1 }), report({ deviceId: randomUUID() })] });
    expect((await deviceOf(made.phone)).resyncState).toBe('held');
    await claim({ limit: 0, results: [report()] });
    expect((await deviceOf(made.phone)).resyncState).toBe('sent');
    const refused = await request(api).post(CLAIM).set('x-callctl-token', TOKEN).send({ limit: 0, results: [report({ state: 'taken' })] });
    expect(refused.status).toBe(400);
  });

  test('the same version is given again after each wait, with the next attempt, and six times at most', async () => {
    const device = await deviceOf(made.phone);
    let now = device.resyncRequestedAt.getTime();
    expect(await takeFor(orgs.a, { now: now + 30 * 1000 })).toEqual([]);
    for (let ask = 2; ask <= 6; ask += 1) {
      now += RESYNC_WAITS_MS[ask - 2];
      expect(await takeFor(orgs.a, { now: now - 1000 })).toEqual([]);
      expect(await takeFor(orgs.a, { now })).toMatchObject([{ deviceId: device.id, configVersion: device.configVersion, attempt: ask }]);
    }
    expect(await takeFor(orgs.a, { now: now + 30 * 24 * 60 * MINUTE })).toEqual([]);
    // An earlier report does not overwrite the state of a later ask.
    await claim({ limit: 0, results: [{ deviceId: device.id, configVersion: device.configVersion, attempt: 5, state: 'failed' }] });
    expect((await deviceOf(made.phone)).resyncState).toBe('taken');
  });

  test('a new change starts the count again, but the phone is not given twice within 10 seconds', async () => {
    // The last ask of the test above was written with a time in the future: bring it back to now.
    await (await deviceOf(made.phone)).update({ resyncRequestedAt: new Date() });
    await team('Returns', '203');
    expect(await claim()).toEqual([]);
    await age(made.phone, RESYNC_MIN_GAP_MS);
    const device = await deviceOf(made.phone);
    expect(await claim()).toMatchObject([{ deviceId: device.id, configVersion: device.configVersion, attempt: 1 }]);
  });

  test('a phone that has fetched is not given, and its read shows no ask', async () => {
    expect(await resyncShown(made.phone)).toMatchObject({ attempts: 1 });
    await fetched(made.phone);
    expect(await takeFor(orgs.a, { now: Date.now() + 24 * 60 * MINUTE })).toEqual([]);
    const view = await ok(get('ownerA', `/phones/${made.phone.id}`));
    expect(view.device).toMatchObject({ state: 'fetched', resync: null });
  });

  test('a line password reset does not start an ask, and a phone already waiting is given for the newest version', async () => {
    const [line] = await db.Line.findAll({ where: { phoneId: made.phone.id }, order: [['position', 'ASC']] });
    const reset = () => ok(post('ownerA', `/phones/${made.phone.id}/lines/${line.id}/password-reset`));
    const version = (await deviceOf(made.phone)).configVersion;
    await reset();
    expect(await deviceOf(made.phone)).toMatchObject({ provisioningState: 'fetched', configVersion: version + 1 });
    expect(await takeFor(orgs.a, { now: Date.now() + 24 * 60 * MINUTE })).toEqual([]);

    await bump(made.phone);
    expect(await claim()).toMatchObject([{ configVersion: version + 2, attempt: 1 }]);
    await reset();
    await age(made.phone, RESYNC_MIN_GAP_MS);
    expect(await claim()).toMatchObject([{ configVersion: version + 3, attempt: 1 }]);
    await fetched(made.phone);
  });

  test('a request held open is answered when a write on this process changes a phone', async () => {
    const started = Date.now();
    const pending = claim({ waitSeconds: 10 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(resync.heldClaims()).toBeGreaterThanOrEqual(1);
    await team('Night desk', '204');
    expect(await pending).toMatchObject([{ deviceId: made.phone.device.id, attempt: 1 }]);
    expect(Date.now() - started).toBeLessThan(2000);
    await fetched(made.phone);
  });

  test('a request held open sees a change made by another process, and ends empty at its time', async () => {
    let started = Date.now();
    expect(await claim({ waitSeconds: 1 })).toEqual([]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);

    started = Date.now();
    const pending = claim({ waitSeconds: 10 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await bump(made.phone);
    expect(await pending).toMatchObject([{ deviceId: made.phone.device.id, attempt: 1 }]);
    expect(Date.now() - started).toBeLessThan(4000);
    await fetched(made.phone);
  });

  test('nothing is taken for a caller that has left', async () => {
    const leaving = request(api).post(CLAIM).set('x-callctl-token', TOKEN).send({ waitSeconds: 10 });
    leaving.end(() => {});
    await new Promise((resolve) => setTimeout(resolve, 300));
    leaving.abort();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const version = await bump(made.phone);
    // Longer than the time between two looks of a held request.
    await new Promise((resolve) => setTimeout(resolve, 2600));
    expect((await deviceOf(made.phone)).resyncVersion).not.toBe(version);
    expect(resync.heldClaims()).toBe(0);
    expect(await claim()).toMatchObject([{ configVersion: version, attempt: 1 }]);
    await fetched(made.phone);
  });

  test('one process holds a few requests open, and answers one more at once', async () => {
    const held = Array.from({ length: RESYNC_MAX_HELD }, () => claim({ waitSeconds: 2 }));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(resync.heldClaims()).toBe(RESYNC_MAX_HELD);
    const started = Date.now();
    expect(await claim({ waitSeconds: 2 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect((await Promise.all(held)).flat()).toEqual([]);
    expect(resync.heldClaims()).toBe(0);
  });

  describe('with many phones', () => {
    const DEVICES = 15;
    const ids = [];
    const child = (claimAt) => new Promise((resolve, reject) => {
      const proc = spawn(process.execPath, ['tests/setup/resync-claim-child.mjs'], {
        env: { ...process.env, CLAIM_AT: String(claimAt), CLAIM_ORGANISATION: orgs.c, LOGLEVEL: 'fatal' },
      });
      let text = '';
      proc.stdout.on('data', (chunk) => { text += chunk; });
      proc.stderr.on('data', (chunk) => { text += chunk; });
      proc.on('close', () => {
        const line = text.split('\n').find((row) => row.startsWith('TAKEN '));
        return line ? resolve(JSON.parse(line.slice(6))) : reject(new Error(text.slice(-600)));
      });
    });

    beforeAll(async () => {
      const ben = (await ok(post('ownerB', '/directory/entries', { kind: 'person', name: 'Ben Okri' }), 201)).entry;
      await ok(post('ownerB', '/directory/extensions', { number: '100', type: 'ring_all', entryId: ben.id }), 201);
      made.theirs = (await ok(post('ownerB', '/phones', { kind: 'deskphone', mac: mac(4), model: 'D735', label: 'Ben desk', people: [ben.id] }), 201)).phone;
      // Organisation c: phones made in the tables, each with one line, all due.
      for (let n = 0; n < DEVICES; n += 1) {
        const device = await db.Device.create({
          organisationId: orgs.c, vendor: 'snom', model: 'D735', mac: mac(20 + n), provisioningState: 'updating', configVersion: 2, fetchedVersion: 1,
        });
        const phone = await db.Phone.create({ organisationId: orgs.c, kind: 'deskphone', label: `Phone ${n}`, deviceId: device.id });
        const account = await PhoneRegistration.create({
          organisationId: orgs.c, mode: 'registrar', kind: 'device', status: 'active', username: `lresync${stamp}${n}`, password: '',
          ha1: 'a'.repeat(32), registrar: 'sip.resync.test.example', handler: 'pbx',
        });
        await db.Line.create({ organisationId: orgs.c, phoneId: phone.id, endpointId: account.id, position: 1, kind: 'other' });
        ids.push(device.id);
      }
    }, 60000);

    test('three API processes that are asked at the same instant give each phone once', async () => {
      const claimAt = Date.now() + 4000;
      const taken = await Promise.all([child(claimAt), child(claimAt), child(claimAt)]);
      expect(taken.flat().sort()).toEqual([...ids].sort());
      const rows = await db.Device.findAll({ where: { id: ids } });
      expect(rows.every((row) => row.resyncAttempts === 1 && row.resyncVersion === 2)).toBe(true);
    }, 60000);

    test('three callers of one process at once are given each phone once', async () => {
      await db.Device.update({ configVersion: 3, resyncRequestedAt: new Date(Date.now() - MINUTE) }, { where: { id: ids } });
      const taken = await Promise.all([claim(), claim(), claim()]);
      expect(taken.flat().map((phone) => phone.deviceId).sort()).toEqual([...ids].sort());
    });

    test('phones that have had every ask do not take the place of a phone that is due', async () => {
      const long = new Date(Date.now() - 30 * 24 * 60 * MINUTE);
      await db.Device.update({ resyncAttempts: RESYNC_MAX_ASKS, resyncRequestedAt: long }, { where: { id: ids } });
      // The one due phone was asked last, so it sorts after every phone that is done.
      await db.Device.update({ resyncAttempts: 1, resyncRequestedAt: new Date(Date.now() - 2 * MINUTE) }, { where: { id: ids[7] } });
      expect(await takeFor(orgs.c, { limit: 1 })).toMatchObject([{ deviceId: ids[7], attempt: 2 }]);
      expect(await takeFor(orgs.c)).toEqual([]);
    });

    test('`limit` is the most phones one request is given', async () => {
      await db.Device.update({ configVersion: 4, resyncRequestedAt: new Date(Date.now() - MINUTE) }, { where: { id: ids } });
      expect(await takeFor(orgs.c, { limit: 4 })).toHaveLength(4);
      expect(await takeFor(orgs.c)).toHaveLength(DEVICES - 4);
    });

    test('a phone with no active line is not given, and is not looked at again until its wait has passed', async () => {
      await fetched(made.theirs);
      await bump(made.theirs);
      const lines = await db.Line.findAll({ where: { phoneId: made.theirs.id } });
      await PhoneRegistration.update({ status: 'disabled' }, { where: { id: lines.map((line) => line.endpointId) } });
      expect(await takeFor(orgs.b)).toEqual([]);
      expect(await deviceOf(made.theirs)).toMatchObject({ resyncState: 'no_lines', resyncAttempts: 1 });
      expect(await takeFor(orgs.b, { now: Date.now() + 30 * 1000 })).toEqual([]);
      expect((await deviceOf(made.theirs)).resyncAttempts).toBe(1);
    });
  });
});
