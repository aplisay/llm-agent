/**
 * The transcript of a phone system call with no agent: the real route and its
 * token check, the read route for those who may see the call, and erasure.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import { setupRealDatabase, teardownRealDatabase, databaseStarted, Organisation, User, Call } from './setup/database-test-wrapper.js';
import { scopeWhereForUser } from '../lib/scope.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const TOKEN = 'test-callctl-token';
const SHARED = 'test-worker-token';

describe('the transcript of a phone system call', () => {
  const stamp = `${Date.now()}`.slice(-6);
  const ORG = `tr-org-${stamp}`;
  const OTHER = `tr-other-${stamp}`;
  const users = {};
  let api;
  let db;
  let records;
  let redaction;
  let savedEnv;
  let alice;

  const address = (callId) => `/api/agent-db/pbx/calls/${callId}/transcript`;
  const post = (callId, texts) => request(api).post(address(callId)).set('x-callctl-token', TOKEN).send({ texts });
  const read = async (user, callId) => (await request(api).get(`/api/calls/${callId}/logs`).set('x-test-user', user)).body;
  const stored = (callId) => db.TransactionLog.count({ where: { callId } });
  const T0 = Date.parse('2026-11-27T10:15:00.000Z');
  const text = (leg, words, seconds, more = {}) => ({
    id: randomUUID(), leg, text: words, at: new Date(T0 + seconds * 1000).toISOString(), ...more,
  });
  /** A call that Alice answered: the call row is the caller, the leg row is Alice. */
  const newCall = async (organisationId = ORG) => {
    const { call } = await records.upsertCall({ id: randomUUID(), organisationId, callerId: '+442079460123', calledId: '201' });
    const { call: leg } = await records.upsertCall({
      id: randomUUID(), organisationId, parentId: call.id, calledId: '201', metadata: { kind: 'line', entryId: alice.id },
    });
    return { call, leg };
  };

  beforeAll(async () => {
    savedEnv = { ...process.env };
    process.env.CALLCTL_SHARED_TOKEN = TOKEN;
    process.env.SHARED_API_TOKEN = SHARED;
    await setupRealDatabase();
    await databaseStarted;
    db = await import('../lib/database.js');
    records = await import('../lib/pbx/call-records.js');
    redaction = await import('../lib/call-redaction.js');
    process.env.BETTER_AUTH_ENABLED = 'false';
    const { default: initAuth } = await import('../middleware/auth.js');

    await Organisation.create({ id: ORG, name: 'Transcript', capabilities: ['phoneSystem'] });
    await Organisation.create({ id: OTHER, name: 'Elsewhere', capabilities: ['phoneSystem'] });
    Object.assign(users, {
      owner: { id: `tr-owner-${stamp}`, organisationId: ORG, role: 'owner' },
      alice: { id: `tr-alice-${stamp}`, organisationId: ORG, role: 'member' },
      bob: { id: `tr-bob-${stamp}`, organisationId: ORG, role: 'member' },
      // A login with no directory person sees no phone system calls.
      nobody: { id: `tr-nobody-${stamp}`, organisationId: ORG, role: 'member' },
      stranger: { id: `tr-stranger-${stamp}`, organisationId: OTHER, role: 'owner' },
    });
    for (const [key, user] of Object.entries(users)) {
      user.sql = { where: scopeWhereForUser(user) };
      await User.create({
        id: user.id, name: key, email: `tr-${key}-${stamp}@example.com`, emailVerified: true,
        phone: '', phoneVerified: false, picture: '', role: user.role, organisationId: user.organisationId,
      });
    }
    alice = await db.DirectoryEntry.create({ organisationId: ORG, name: 'Alice', kind: 'person', loginUserId: users.alice.id });
    await db.DirectoryEntry.create({ organisationId: ORG, name: 'Bob', kind: 'person', loginUserId: users.bob.id });

    const app = express();
    app.use(express.json({ limit: '2mb' }));
    const checks = express.Router();
    initAuth(checks, log);
    app.use((req, res, next) => {
      req.log = log;
      const user = users[req.headers['x-test-user']];
      if (!user) return checks(req, res, next);
      res.locals.user = user;
      return next();
    });
    for (const file of ['agent-db/pbx/calls/{callId}/transcript.js', 'calls/{callId}/logs.js']) {
      await import(`../api/paths/${file}`);
    }
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{agent-db/pbx/calls/{callId}/transcript.js,calls/{callId}/logs.js}',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    api = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => api.once('listening', resolve));
  }, 120000);

  afterAll(async () => {
    if (api) await new Promise((resolve) => api.close(resolve));
    if (db) {
      const where = { organisationId: [ORG, OTHER] };
      await db.TransactionLog.destroy({ where, hooks: false });
      await Call.destroy({ where: { ...where, parentId: { [db.Op.ne]: null } } });
      await Call.destroy({ where });
      await db.DirectoryEntry.destroy({ where });
      await User.destroy({ where });
      await Organisation.destroy({ where: { id: [ORG, OTHER] } });
    }
    process.env = savedEnv;
    await teardownRealDatabase();
  }, 60000);

  test('the route takes the call control token only', async () => {
    const { call } = await newCall();
    const body = { texts: [text(call.id, 'hello', 1)] };
    const as = (headers) => request(api).post(address(call.id)).set(headers).send(body);
    expect((await request(api).post(address(call.id)).send(body)).status).toBe(403);
    expect((await as({ 'x-callctl-token': 'wrong' })).status).toBe(403);
    expect((await as({ 'x-shared-token': SHARED })).status).toBe(403);
    expect(await stored(call.id)).toBe(0);
    expect((await as({ 'x-callctl-token': TOKEN })).status).toBe(200);
    expect(await stored(call.id)).toBe(1);
  });

  test('each text is a row on the call that names who spoke, read in the order the words began', async () => {
    const { call, leg } = await newCall();
    // Sent out of order, and with the fields that are not stored.
    const said = [
      text(leg.id, 'hello sales', 2, { party: 'callee', startMs: 2000, endMs: 2900 }),
      text(call.id, 'hi is that alice', 4, { party: 'caller' }),
      text(call.id.toUpperCase(), 'are you there', 1),
    ];
    const res = await post(call.id, said);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ stored: 3, duplicates: 0 });

    const rows = await read('owner', call.id);
    expect(rows.map((row) => [row.speaker, row.data, row.type, row.isFinal, row.callId])).toEqual([
      [call.id, 'are you there', 'user', true, call.id],
      [leg.id, 'hello sales', 'user', true, call.id],
      [call.id, 'hi is that alice', 'user', true, call.id],
    ]);
    expect(rows.map((row) => row.createdAt)).toEqual([1, 2, 4].map((s) => new Date(T0 + s * 1000).toISOString()));
    expect(rows.map((row) => row.sourceId).sort()).toEqual(said.map((item) => item.id).sort());
    // Nothing is stored on the leg's own row.
    expect(await stored(leg.id)).toBe(0);
    expect(await read('owner', leg.id)).toEqual([]);
  });

  test('the transcript shows to those who see the call, and to nobody else', async () => {
    const { call, leg } = await newCall();
    expect((await post(call.id, [text(call.id, 'one', 1), text(leg.id, 'two', 2)])).status).toBe(200);
    expect((await read('owner', call.id)).map((row) => row.data)).toEqual(['one', 'two']);
    // Alice answered it. Bob is in the directory and had no part in it.
    expect((await read('alice', call.id)).map((row) => row.data)).toEqual(['one', 'two']);
    expect(await read('bob', call.id)).toEqual([]);
    expect(await read('nobody', call.id)).toEqual([]);
    expect(await read('stranger', call.id)).toEqual([]);
  });

  test('a text sent again, or twice at once, is stored once', async () => {
    const { call, leg } = await newCall();
    const first = [text(call.id, 'one', 1), text(leg.id, 'two', 2)];
    expect((await post(call.id, first)).body).toEqual({ stored: 2, duplicates: 0 });
    const more = text(call.id, 'three', 3);
    expect((await post(call.id, [...first, more])).body).toEqual({ stored: 1, duplicates: 2 });
    // The same id twice in one request.
    const twice = text(leg.id, 'four', 4);
    expect((await post(call.id, [twice, { ...twice }])).body).toEqual({ stored: 1, duplicates: 1 });

    for (let round = 0; round < 5; round += 1) {
      const batch = [text(call.id, `again ${round}`, 10 + round), text(leg.id, `and again ${round}`, 20 + round)];
      const answers = await Promise.all([1, 2, 3, 4].map(() => post(call.id, batch)));
      expect(answers.map((res) => res.status)).toEqual([200, 200, 200, 200]);
      expect(answers.reduce((sum, res) => sum + res.body.stored, 0)).toBe(2);
    }
    expect(await stored(call.id)).toBe(4 + 10);
  });

  test('a call that is not there, or a leg that is not of the call, is 404 and stores nothing', async () => {
    const { call, leg } = await newCall();
    const other = await newCall();
    const elsewhere = await newCall(OTHER);
    const agentCall = await Call.create({ id: randomUUID(), organisationId: ORG, platform: 'livekit', modelName: 'x', startedAt: new Date() });
    const refused = async (callId, texts) => {
      const res = await post(callId, texts);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    };
    await refused(randomUUID(), [text(call.id, 'x', 1)]);
    // A leg takes no transcript of its own.
    await refused(leg.id, [text(leg.id, 'x', 1)]);
    await refused(agentCall.id, [text(agentCall.id, 'x', 1)]);
    // One good text and one that names a row of another call: neither is stored.
    await refused(call.id, [text(call.id, 'good', 1), text(other.leg.id, 'x', 2)]);
    await refused(call.id, [text(call.id, 'good', 1), text(other.call.id, 'x', 2)]);
    await refused(call.id, [text(elsewhere.leg.id, 'x', 1)]);
    await refused(call.id, [text(randomUUID(), 'x', 1)]);
    for (const id of [call.id, leg.id, other.call.id, agentCall.id, elsewhere.call.id]) expect(await stored(id)).toBe(0);
    await Call.destroy({ where: { id: agentCall.id } });
  });

  test('a text or a list that is not valid is 400 and stores nothing', async () => {
    const { call } = await newCall();
    const good = text(call.id, 'good', 1);
    const bad = [
      undefined,
      [],
      'hello',
      [good, { ...text(call.id, 'x', 2), id: 'not-a-uuid' }],
      [good, { ...text(call.id, 'x', 2), leg: 'the caller' }],
      [good, { ...text(call.id, 'x', 2), leg: undefined }],
      [good, text(call.id, '', 2)],
      [good, text(call.id, '   ', 2)],
      [good, text(call.id, 'x'.repeat(4001), 2)],
      [good, { ...text(call.id, 'x', 2), text: 7 }],
      [good, { ...text(call.id, 'x', 2), at: 'yesterday' }],
      [good, null],
      Array.from({ length: 201 }, (_, i) => text(call.id, `t${i}`, i)),
    ];
    for (const texts of bad) {
      const res = await post(call.id, texts);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('bad_request');
    }
    expect(await stored(call.id)).toBe(0);
    // The limits themselves are taken.
    const full = Array.from({ length: 200 }, (_, i) => text(call.id, i ? `t${i}` : 'x'.repeat(4000), i));
    expect((await post(call.id, full)).body).toEqual({ stored: 200, duplicates: 0 });
    // With no time, the text is stored at the time it arrived.
    const before = Date.now();
    expect((await post(call.id, [{ id: randomUUID(), leg: call.id, text: 'no time' }])).status).toBe(200);
    const row = await db.TransactionLog.findOne({ where: { callId: call.id, data: 'no time' } });
    expect(row.createdAt.valueOf()).toBeGreaterThanOrEqual(before - 1000);
  });

  test('a call that has ended still takes a late text', async () => {
    const { call, leg } = await newCall();
    await records.endCall(leg.id, {});
    await records.endCall(call.id, {});
    expect((await post(call.id, [text(leg.id, 'late', 5)])).body).toEqual({ stored: 1, duplicates: 0 });
  });

  test('erasing the call removes its transcript, and a later text is refused', async () => {
    const { call, leg } = await newCall();
    const kept = await newCall();
    const said = [text(call.id, 'my card number is', 1), text(leg.id, 'go ahead', 2)];
    expect((await post(call.id, said)).status).toBe(200);
    expect((await post(kept.call.id, [text(kept.call.id, 'another call', 1)])).status).toBe(200);
    const long = new Date(Date.now() - 60 * 60 * 1000);
    await Call.update({ endedAt: long, live: false }, { where: { id: [call.id, leg.id] }, hooks: false });

    // Erased by its leg's id: the whole call goes.
    const done = await redaction.redactCallTree({ callId: leg.id, scope: { organisationId: ORG }, actorId: users.owner.id, log });
    expect(done.outcome).toBe('redacted');
    expect(done.callIds.sort()).toEqual([call.id, leg.id].sort());
    expect(await stored(call.id)).toBe(0);
    expect(await db.TransactionLog.count({ where: { speaker: [call.id, leg.id] } })).toBe(0);
    for (const user of ['owner', 'alice']) expect(await read(user, call.id)).toEqual([]);
    expect(await stored(kept.call.id)).toBe(1);

    // The same texts again, and a new one, as a late retry would send them.
    for (const texts of [said, [text(leg.id, 'late', 3)]]) {
      const res = await post(call.id, texts);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    }
    expect(await stored(call.id)).toBe(0);
  });

  test('a text sent while the call is being erased never stays on it', async () => {
    for (let round = 0; round < 8; round += 1) {
      const { call, leg } = await newCall();
      const long = new Date(Date.now() - 60 * 60 * 1000);
      await Call.update({ endedAt: long, live: false }, { where: { id: [call.id, leg.id] }, hooks: false });
      const sends = [1, 2, 3].map((n) => post(call.id, [text(call.id, `a${n}`, n), text(leg.id, `b${n}`, n)]));
      const [done, ...answers] = await Promise.all([
        redaction.redactCallTree({ callId: call.id, scope: { organisationId: ORG }, log }),
        ...sends,
      ]);
      expect(done.outcome).toBe('redacted');
      for (const res of answers) expect([200, 404]).toContain(res.status);
      expect(await stored(call.id)).toBe(0);
    }
  });
});
