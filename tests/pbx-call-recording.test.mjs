/**
 * Storing the finished recording of a phone system call: the real route and
 * its token check, then the download route, on the test database and a
 * recording store in a local directory.
 */
import { randomUUID, randomBytes, createCipheriv } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { jest } from '@jest/globals';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import { setupRealDatabase, teardownRealDatabase, databaseStarted, Organisation, Call } from './setup/database-test-wrapper.js';
import { scopeWhereForUser } from '../lib/scope.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const TOKEN = 'test-callctl-token';
const SHARED = 'test-worker-token';

describe('the recording of a phone system call', () => {
  const stamp = `${Date.now()}`.slice(-6);
  const ORG = `rec-org-${stamp}`;
  const OTHER = `rec-other-${stamp}`;
  const users = {};
  let api;
  let db;
  let records;
  let savedEnv;
  let storeDir;

  const address = (callId) => `/api/agent-db/pbx/calls/${callId}/recording`;
  const put = (callId, body) => request(api).put(address(callId)).set('x-callctl-token', TOKEN).send(body);
  const download = (user, callId) => request(api).get(`/api/calls/${callId}/recording`).set('x-test-user', user)
    .buffer(true).parse((res, done) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
  const newCall = async (fields = {}) => (await records.upsertCall({
    id: randomUUID(), organisationId: ORG, callerId: '+442079460123', calledId: '201', ...fields,
  })).call;
  const nameFor = (callId) => `recordings/${callId}-${randomBytes(8).toString('hex')}.ogg`;
  const newKey = () => randomBytes(32).toString('base64');
  /** A file in the store, sealed as the contract says: IV, ciphertext, tag. */
  const sealed = (name, plain) => {
    const key = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    fs.mkdirSync(path.dirname(path.join(storeDir, name)), { recursive: true });
    fs.writeFileSync(path.join(storeDir, name), body);
    return key.toString('base64');
  };
  const held = async (callId) => {
    const call = await Call.findByPk(callId);
    return { recordingId: call.recordingId, encryptionKey: call.encryptionKey };
  };

  beforeAll(async () => {
    savedEnv = { ...process.env };
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbx-recording-'));
    process.env.RECORDING_STORAGE_PATH = `file://${storeDir}`;
    process.env.CALLCTL_SHARED_TOKEN = TOKEN;
    process.env.SHARED_API_TOKEN = SHARED;
    await setupRealDatabase();
    await databaseStarted;
    db = await import('../lib/database.js');
    records = await import('../lib/pbx/call-records.js');
    // The sign-in module needs its own settings to load. The call control token is checked before it.
    process.env.BETTER_AUTH_ENABLED = 'false';
    const { default: initAuth } = await import('../middleware/auth.js');

    await Organisation.create({ id: ORG, name: 'Recording', capabilities: ['phoneSystem'] });
    await Organisation.create({ id: OTHER, name: 'Elsewhere', capabilities: ['phoneSystem'] });
    Object.assign(users, {
      owner: { id: `rec-owner-${stamp}`, organisationId: ORG, role: 'owner' },
      // A login with no directory person sees no phone system calls.
      member: { id: `rec-member-${stamp}`, organisationId: ORG, role: 'member' },
      support: { id: `rec-support-${stamp}`, organisationId: ORG, role: 'support' },
      stranger: { id: `rec-stranger-${stamp}`, organisationId: OTHER, role: 'owner' },
    });
    for (const user of Object.values(users)) user.sql = { where: scopeWhereForUser(user) };

    const app = express();
    app.use(express.json());
    // A test user for the download route. Everything else goes through the server's own checks.
    const checks = express.Router();
    initAuth(checks, log);
    app.use((req, res, next) => {
      req.log = log;
      const user = users[req.headers['x-test-user']];
      if (!user) return checks(req, res, next);
      res.locals.user = user;
      return next();
    });
    for (const file of ['agent-db/pbx/calls/{callId}/recording.js', 'calls/{callId}/recording.js']) {
      await import(`../api/paths/${file}`);
    }
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{agent-db/pbx/calls/{callId}/recording.js,calls/{callId}/recording.js}',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    api = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => api.once('listening', resolve));
  }, 120000);

  afterAll(async () => {
    if (api) await new Promise((resolve) => api.close(resolve));
    if (db) {
      await db.CallRecordingDownload.destroy({ where: { organisationId: [ORG, OTHER] } });
      await Call.destroy({ where: { organisationId: [ORG, OTHER], parentId: { [db.Op.ne]: null } } });
      await Call.destroy({ where: { organisationId: [ORG, OTHER] } });
      await Organisation.destroy({ where: { id: [ORG, OTHER] } });
    }
    if (storeDir) fs.rmSync(storeDir, { recursive: true, force: true });
    process.env = savedEnv;
    await teardownRealDatabase();
  }, 60000);

  test('the route takes the call control token only', async () => {
    const call = await newCall();
    const body = { organisationId: ORG, recordingId: nameFor(call.id), encryptionKey: newKey() };
    const as = (headers) => request(api).put(address(call.id)).set(headers).send(body);
    expect((await request(api).put(address(call.id)).send(body)).status).toBe(403);
    expect((await as({ 'x-callctl-token': 'wrong' })).status).toBe(403);
    expect((await as({ 'x-callctl-token': SHARED })).status).toBe(403);
    expect((await as({ 'x-shared-token': SHARED })).status).toBe(403);
    expect(await held(call.id)).toEqual({ recordingId: null, encryptionKey: null });
    expect((await as({ 'x-callctl-token': TOKEN })).status).toBe(200);
  });

  test('a stored recording plays through the download route, to those who see the call', async () => {
    const call = await newCall();
    const recordingId = nameFor(call.id);
    const audio = Buffer.concat([Buffer.from('OggS'), randomBytes(5000)]);
    const encryptionKey = sealed(recordingId, audio);

    const res = await put(call.id, { organisationId: ORG, recordingId, encryptionKey });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ callId: call.id, recordingId });
    expect(await held(call.id)).toEqual({ recordingId, encryptionKey });
    // The key is not kept in the clear.
    const [[row]] = await Call.sequelize.query('SELECT encryption_key FROM calls WHERE id = :id', { replacements: { id: call.id } });
    expect(row.encryption_key).toMatch(/^enc:/);

    const played = await download('owner', call.id);
    expect(played.status).toBe(200);
    expect(played.headers['content-type']).toMatch(/audio\/ogg/);
    expect(Buffer.compare(played.body, audio)).toBe(0);

    expect((await download('member', call.id)).status).toBe(404);
    expect((await download('stranger', call.id)).status).toBe(404);
    expect((await download('support', call.id)).status).toBe(403);
  });

  test('the same name sent again is accepted, and changes nothing', async () => {
    const call = await newCall();
    const first = { organisationId: ORG, recordingId: nameFor(call.id), encryptionKey: newKey() };
    expect((await put(call.id, first)).status).toBe(200);
    const again = await put(call.id, first);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ callId: call.id, recordingId: first.recordingId });
    expect((await put(call.id, { ...first, encryptionKey: newKey() })).status).toBe(200);
    expect(await held(call.id)).toEqual({ recordingId: first.recordingId, encryptionKey: first.encryptionKey });
  });

  test('another name is refused with the name that is held', async () => {
    const call = await newCall();
    const first = { organisationId: ORG, recordingId: nameFor(call.id), encryptionKey: newKey() };
    expect((await put(call.id, first)).status).toBe(200);
    const second = await put(call.id, { organisationId: ORG, recordingId: nameFor(call.id), encryptionKey: newKey() });
    expect(second.status).toBe(409);
    expect(second.body).toEqual({ error: expect.any(String), code: 'recording_exists', recordingId: first.recordingId });
    expect(await held(call.id)).toEqual({ recordingId: first.recordingId, encryptionKey: first.encryptionKey });
  });

  test('of two names sent at once, one is stored and the other is told which', async () => {
    for (let round = 0; round < 10; round += 1) {
      const call = await newCall();
      const bodies = [0, 1, 2].map(() => ({ organisationId: ORG, recordingId: nameFor(call.id), encryptionKey: newKey() }));
      const answers = await Promise.all(bodies.map((body) => put(call.id, body)));
      const kept = answers.map((res, i) => (res.status === 200 ? bodies[i] : null)).filter(Boolean);
      expect(kept).toHaveLength(1);
      expect(await held(call.id)).toEqual({ recordingId: kept[0].recordingId, encryptionKey: kept[0].encryptionKey });
      for (const res of answers.filter((answer) => answer.status !== 200)) {
        expect(res.status).toBe(409);
        expect(res.body.recordingId).toBe(kept[0].recordingId);
      }
    }
  });

  test('a call that is not there, not this organisation\'s, a leg, an agent call or a deleted call: 404, and nothing stored', async () => {
    const body = (callId, organisationId = ORG) => ({ organisationId, recordingId: nameFor(callId), encryptionKey: newKey() });
    const refused = async (callId, organisationId) => {
      const res = await put(callId, body(callId, organisationId));
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    };
    await refused(randomUUID());

    const call = await newCall();
    await refused(call.id, OTHER);
    await refused(call.id, 'no-such-organisation');

    const leg = await newCall({ parentId: call.id });
    await refused(leg.id);

    const agentCall = await Call.create({ id: randomUUID(), organisationId: ORG, callerId: '1', calledId: '2', modelName: 'text:stub/echo' });
    await refused(agentCall.id);

    const erased = await newCall();
    await Call.update({ redactedAt: new Date() }, { where: { id: erased.id }, hooks: false });
    await refused(erased.id);

    for (const id of [call.id, leg.id, agentCall.id, erased.id]) {
      expect(await held(id)).toEqual({ recordingId: null, encryptionKey: null });
    }
  });

  test('a body that cannot be stored: 400, and nothing stored', async () => {
    const call = await newCall();
    const good = { organisationId: ORG, recordingId: nameFor(call.id), encryptionKey: newKey() };
    const bad = [
      {},
      { ...good, organisationId: undefined },
      { ...good, recordingId: undefined },
      { ...good, recordingId: '' },
      { ...good, recordingId: `recordings/${randomUUID()}-0011223344556677.ogg` },
      { ...good, recordingId: `${good.recordingId}\n` },
      { ...good, recordingId: `${call.id}/${'x'.repeat(1024)}` },
      { ...good, encryptionKey: undefined },
      { ...good, encryptionKey: randomBytes(16).toString('base64') },
      { ...good, encryptionKey: randomBytes(32).toString('hex') },
      { ...good, encryptionKey: good.encryptionKey.replace('=', '') },
    ];
    for (const body of bad) {
      const res = await put(call.id, body);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('bad_request');
    }
    expect((await put('not-a-call-id', good)).status).toBe(400);
    expect(await held(call.id)).toEqual({ recordingId: null, encryptionKey: null });
  });

  test('a write that fails answers 500, and a later try stores', async () => {
    const call = await newCall();
    const body = { organisationId: ORG, recordingId: nameFor(call.id), encryptionKey: newKey() };
    const update = jest.spyOn(Call, 'update').mockRejectedValueOnce(new Error('connection lost'));
    try {
      expect((await put(call.id, body)).status).toBe(500);
    } finally {
      update.mockRestore();
    }
    expect(await held(call.id)).toEqual({ recordingId: null, encryptionKey: null });
    expect((await put(call.id, body)).status).toBe(200);
  });

  test('a call whose recording was deleted takes a new one', async () => {
    const call = await newCall();
    const first = { organisationId: ORG, recordingId: nameFor(call.id), encryptionKey: sealed('unused', Buffer.from('x')) };
    sealed(first.recordingId, Buffer.from('first'));
    expect((await put(call.id, first)).status).toBe(200);
    expect((await request(api).delete(`/api/calls/${call.id}/recording`).set('x-test-user', 'owner')).status).toBeLessThan(300);
    expect(await held(call.id)).toEqual({ recordingId: null, encryptionKey: null });
    const second = { organisationId: ORG, recordingId: nameFor(call.id), encryptionKey: newKey() };
    expect((await put(call.id, second)).status).toBe(200);
    expect((await held(call.id)).recordingId).toBe(second.recordingId);
  });
});
