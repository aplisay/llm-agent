/**
 * Asking a desk phone to fetch its settings: what is sent to call control and
 * when, against a stand-in call control, on the test database.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import { setupRealDatabase, teardownRealDatabase, Organisation, PhoneRegistration } from './setup/database-test-wrapper.js';
import { startCallctlStandIn } from './setup/callctl-stand-in.js';
import { resyncDue, callctlTarget, RESYNC_WAITS_MS, RESYNC_MAX_ASKS } from '../lib/pbx/resync-rules.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const TOKEN = 'stand-in-callctl-token';
const MINUTE = 60 * 1000;

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

  test('a new version of the settings starts the count again', () => {
    expect(resyncDue(device({ configVersion: 6, resyncAttempts: 6, resyncRequestedAt: new Date(at) }), at)).toEqual({ due: true, attempts: 0 });
  });

  test('call control is used only with an address and the token', () => {
    expect(callctlTarget({})).toBeNull();
    expect(callctlTarget({ CALLCTL_URL: 'http://callctl:8090' })).toBeNull();
    expect(callctlTarget({ CALLCTL_SHARED_TOKEN: 't' })).toBeNull();
    expect(callctlTarget({ CALLCTL_URL: 'callctl:8090', CALLCTL_SHARED_TOKEN: 't' })).toBeNull();
    expect(callctlTarget({ CALLCTL_URL: 'http://callctl:8090/', CALLCTL_SHARED_TOKEN: 't' })).toEqual({ url: 'http://callctl:8090/phones/resync', token: 't' });
  });
});

describe('asking call control', () => {
  let api;
  let db;
  let resync;
  let callctl;
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
  const until = async (check, ms = 3000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };
  const team = async (name, number, members = [made.ada.id]) => {
    const { entry } = await ok(post('ownerA', '/directory/entries', { kind: 'team', name }), 201);
    await ok(post('ownerA', '/directory/extensions', { number, type: 'ring_all', entryId: entry.id, members }), 201);
  };
  const deviceOf = (phone) => db.Device.findByPk(phone.device.id);
  /** As the provisioning service leaves a device after a good fetch. */
  const fetched = async (phone) => {
    const device = await deviceOf(phone);
    await device.update({ provisioningState: 'fetched', fetchedVersion: device.configVersion, tokenHash: 'x'.repeat(64) });
  };
  const usernames = async (phone) => {
    const lines = await db.Line.findAll({ where: { phoneId: phone.id }, order: [['position', 'ASC']] });
    const accounts = await PhoneRegistration.findAll({ where: { id: lines.map((line) => line.endpointId) } });
    return lines.map((line) => accounts.find((account) => account.id === line.endpointId).username);
  };
  const sentFor = (phone) => callctl.phones().filter((sent) => sent.deviceId === phone.device.id);

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.PBX_REGISTRAR_DOMAIN = 'sip.resync.test.example';
    delete process.env.PBX_RELEASE;
    delete process.env.CALLCTL_URL;
    process.env.CALLCTL_SHARED_TOKEN = TOKEN;
    await setupRealDatabase();
    db = await import('../lib/database.js');
    resync = await import('../lib/pbx/resync.js');
    callctl = await startCallctlStandIn({ token: TOKEN });

    for (const name of ['a', 'b']) {
      orgs[name] = randomUUID();
      await Organisation.create({ id: orgs[name], name: `Resync test ${name}`, capabilities: ['phoneSystem'] });
    }
    Object.assign(users, {
      ownerA: { id: `resync-owner-a-${stamp}`, organisationId: orgs.a, role: 'owner' },
      ownerB: { id: `resync-owner-b-${stamp}`, organisationId: orgs.b, role: 'owner' },
    });
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.log = log;
      res.locals.user = users[req.headers['x-test-user']];
      next();
    });
    // Loaded one by one first: see tests/pbx-directory-api.test.mjs.
    const routeFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
      const path = `${dir}/${item.name}`;
      if (item.isDirectory()) return routeFiles(path);
      return item.name.endsWith('.js') ? [path] : [];
    });
    for (const top of ['directory', 'phones']) {
      const files = [...(fs.existsSync(`./api/paths/${top}.js`) ? [`./api/paths/${top}.js`] : []), ...routeFiles(`./api/paths/${top}`)];
      for (const file of files) await import(`.${file}`);
    }
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{directory,phones}{.js,/**/*.js}',
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
    await new Promise((resolve) => api.close(resolve));
    await callctl.close();
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

  test('with no call control set nothing is sent and nothing is recorded', async () => {
    await fetched(made.phone);
    await team('Support', '201');
    const device = await deviceOf(made.phone);
    expect(device.provisioningState).toBe('updating');
    expect(await resync.requestResyncs()).toEqual({ asked: 0 });
    expect((await deviceOf(made.phone)).resyncVersion).toBeNull();
    expect(callctl.state.requests).toEqual([]);
  });

  test('a phone that has never fetched, or is wiped, is not asked', async () => {
    // The phone of the test above has fetched by now, so it is not due here.
    await fetched(made.phone);
    process.env.CALLCTL_URL = callctl.url;
    const fresh = (await ok(post('ownerA', '/phones', { kind: 'deskphone', mac: mac(2), model: 'D735', label: 'New phone', people: [] }), 201)).phone;
    const wiped = (await ok(post('ownerA', '/phones', { kind: 'deskphone', mac: mac(3), model: 'D735', label: 'Wiped phone', people: [] }), 201)).phone;
    await (await deviceOf(wiped)).update({ provisioningState: 'wiped' });
    await ok(post('ownerA', `/phones/${fresh.id}/people`, { entryId: made.ada.id }), 201);
    await ok(post('ownerA', `/phones/${wiped.id}/people`, { entryId: made.ada.id }), 201);
    await resync.requestResyncs();
    // Time for the asks that follow each write, which nothing waits for.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(callctl.state.requests).toEqual([]);
    expect((await deviceOf(fresh)).provisioningState).toBe('waiting');
    expect((await deviceOf(wiped)).provisioningState).toBe('wiped');
  });

  test('a directory change asks for the phone straight after the write, with its lines in key order', async () => {
    const before = await deviceOf(made.phone);
    await team('Accounts', '202');
    expect(await until(() => sentFor(made.phone).length === 1)).toBe(true);
    const [sent] = sentFor(made.phone);
    const names = await usernames(made.phone);
    expect(names).toHaveLength(4);
    expect(sent).toEqual({
      deviceId: made.phone.device.id,
      phoneId: made.phone.id,
      organisationId: orgs.a,
      configVersion: before.configVersion + 1,
      action: 'check-sync',
      lines: names,
    });
    const { headers, body } = callctl.state.requests[0];
    expect(headers['x-callctl-token']).toBe(TOKEN);
    expect(headers['content-type']).toBe('application/json');
    expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
    // The body holds no password and no hash.
    expect(JSON.stringify(body)).not.toMatch(/ha1|password/i);

    expect(await until(async () => (await deviceOf(made.phone)).resyncState === 'sent')).toBe(true);
    const after = await deviceOf(made.phone);
    expect(after).toMatchObject({ provisioningState: 'updating', resyncVersion: after.configVersion, resyncAttempts: 1 });
    const view = await ok(get('ownerA', `/phones/${made.phone.id}`));
    expect(view.device.resync).toMatchObject({ attempts: 1, state: 'sent' });
  });

  test('the sweep asks again after each wait until the phone has fetched, and six times at most', async () => {
    const device = await deviceOf(made.phone);
    let now = device.resyncRequestedAt.getTime();
    expect(await resync.requestResyncs({ now: now + 30 * 1000 })).toEqual({ asked: 0 });
    for (let ask = 2; ask <= 6; ask += 1) {
      now += RESYNC_WAITS_MS[ask - 2];
      expect((await resync.requestResyncs({ now })).asked).toBe(1);
      expect((await deviceOf(made.phone)).resyncAttempts).toBe(ask);
    }
    expect(sentFor(made.phone)).toHaveLength(6);
    expect(await resync.requestResyncs({ now: now + 30 * 24 * 60 * MINUTE })).toEqual({ asked: 0 });
  });

  test('a new change starts the count again, and a phone that has fetched is left alone', async () => {
    const sent = sentFor(made.phone).length;
    await team('Returns', '203');
    expect(await until(() => sentFor(made.phone).length === sent + 1)).toBe(true);
    expect(await until(async () => (await deviceOf(made.phone)).resyncState === 'sent')).toBe(true);
    const device = await deviceOf(made.phone);
    expect(device).toMatchObject({ resyncAttempts: 1, resyncVersion: device.configVersion });

    await fetched(made.phone);
    expect(await resync.requestResyncs({ now: Date.now() + 24 * 60 * MINUTE })).toEqual({ asked: 0 });
    expect((await ok(get('ownerA', `/phones/${made.phone.id}`))).device.state).toBe('fetched');
  });

  test('two servers that sweep at once send one request', async () => {
    const sent = sentFor(made.phone).length;
    const device = await deviceOf(made.phone);
    await device.update({ provisioningState: 'updating', configVersion: device.configVersion + 1 });
    const answers = await Promise.all([resync.requestResyncs(), resync.requestResyncs(), resync.requestResyncs()]);
    expect(answers.map((answer) => answer.asked).sort()).toEqual([0, 0, 1]);
    expect(sentFor(made.phone)).toHaveLength(sent + 1);
  });

  test('what call control answers is kept on the phone, and every answer waits the same', async () => {
    const device = await deviceOf(made.phone);
    for (const state of ['held', 'no_binding', 'failed']) {
      callctl.state.answers.set(device.id, state);
      await device.update({ configVersion: (await deviceOf(made.phone)).configVersion + 1 });
      expect((await resync.requestResyncs()).states).toEqual({ [device.id]: state });
      expect((await deviceOf(made.phone)).resyncState).toBe(state);
      expect(await resync.requestResyncs({ now: Date.now() + 30 * 1000 })).toEqual({ asked: 0 });
    }
    callctl.state.answers.clear();
  });

  test('call control down, refusing or with the wrong token: the write still works and the ask is counted', async () => {
    const device = await deviceOf(made.phone);
    const bump = async () => device.update({ configVersion: (await deviceOf(made.phone)).configVersion + 1 });

    await bump();
    process.env.CALLCTL_URL = 'http://127.0.0.1:1';
    await team('Night desk', '204');
    expect(await until(async () => (await deviceOf(made.phone)).resyncState === 'unanswered')).toBe(true);
    expect((await deviceOf(made.phone)).resyncAttempts).toBe(1);
    // It is not asked again before the wait, so a call control that is down is not hammered.
    expect(await resync.requestResyncs()).toEqual({ asked: 0 });

    process.env.CALLCTL_URL = callctl.url;
    await bump();
    callctl.state.failWith = 503;
    expect(await resync.requestResyncs()).toMatchObject({ asked: 1, ok: false, status: 503 });
    callctl.state.failWith = null;
    expect((await deviceOf(made.phone)).resyncState).toBe('unanswered');

    await bump();
    process.env.CALLCTL_SHARED_TOKEN = 'not-the-token';
    expect(await resync.requestResyncs()).toMatchObject({ asked: 1, ok: false, status: 401 });
    expect(callctl.state.refused).toEqual(['token']);
    process.env.CALLCTL_SHARED_TOKEN = TOKEN;

    // After the wait the sweep gets through.
    expect(await resync.requestResyncs({ now: Date.now() + 2 * MINUTE })).toMatchObject({ asked: 1, ok: true });
    expect((await deviceOf(made.phone)).resyncState).toBe('sent');
  });

  test('a write in one organisation asks for that organisation only, and a phone with no line is not sent', async () => {
    const ben = (await ok(post('ownerB', '/directory/entries', { kind: 'person', name: 'Ben Okri' }), 201)).entry;
    await ok(post('ownerB', '/directory/extensions', { number: '100', type: 'ring_all', entryId: ben.id }), 201);
    const theirs = (await ok(post('ownerB', '/phones', { kind: 'deskphone', mac: mac(4), model: 'D735', label: 'Ben desk', people: [ben.id] }), 201)).phone;
    await fetched(theirs);
    await fetched(made.phone);
    const sent = callctl.phones().length;
    const { entry } = await ok(post('ownerA', '/directory/entries', { kind: 'team', name: 'Stores' }), 201);
    await ok(post('ownerA', '/directory/extensions', { number: '205', type: 'ring_all', entryId: entry.id, members: [made.ada.id] }), 201);
    expect(await until(() => callctl.phones().length > sent)).toBe(true);
    expect(callctl.phones().slice(sent).map((phone) => phone.organisationId)).toEqual([orgs.a]);

    // A phone left with no active line account has nobody to tell.
    await (await deviceOf(theirs)).update({ provisioningState: 'updating', configVersion: 99 });
    const lines = await db.Line.findAll({ where: { phoneId: theirs.id } });
    await PhoneRegistration.update({ status: 'disabled' }, { where: { id: lines.map((line) => line.endpointId) } });
    const before = sentFor(theirs).length;
    expect(await resync.requestResyncs({ organisationId: orgs.b })).toEqual({ asked: 0 });
    expect(sentFor(theirs)).toHaveLength(before);
    expect((await deviceOf(theirs)).resyncState).toBe('no_lines');
  });
});
