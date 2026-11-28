/**
 * Who sees which calls, through the real calls routes and the test database:
 * each role, a shared extension, a login with no linked person, and calls
 * that have no instance.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { jest } from '@jest/globals';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import {
  setupRealDatabase, teardownRealDatabase, databaseStarted, Organisation, User, Call, TransactionLog,
} from './setup/database-test-wrapper.js';
import { scopeWhereForUser } from '../lib/scope.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

// POST /agents/{id}/invoke runs a model; the runner is stubbed so only the call check is under test.
const runSubagent = jest.fn(async () => ({ result: { ok: true }, complete: true, transcript: [], usage: [] }));
class SubagentError extends Error {}
jest.unstable_mockModule('../lib/subagent.js', () => ({ runSubagent, SubagentError, organisationAllowsModel: async () => true }));

describe('who sees calls', () => {
  const stamp = `${Date.now()}`.slice(-6);
  const ORG = `cv-org-${stamp}`;
  const OTHER = `cv-other-${stamp}`;
  const users = {};
  const calls = {};
  let db;
  let server;

  const get = (user, path) => request(server).get(`/api${path}`).set('x-test-user', user);
  const listed = async (user) => {
    const res = await get(user, '/calls?limit=500');
    expect(res.status).toBe(200);
    return new Set(res.body.calls.map((c) => c.id));
  };

  // Phone system rows are written as call control writes them (lib/pbx/call-records.js): a leg's row
  // when the network answers it, with no `answered`, which comes only with the leg's end.
  let records;
  const pbxCall = async (fields = {}, pbx = {}) => (await records.upsertCall({
    id: randomUUID(), organisationId: ORG, callerId: '+442079460123', calledId: '201', ...fields, metadata: pbx,
  })).call;
  const pbxLeg = async (parent, pbx) => (await records.upsertCall({
    id: randomUUID(), organisationId: ORG, parentId: parent.id, callerId: parent.callerId, calledId: '201', metadata: pbx,
  })).call;
  const end = (call, answered, reason) => records.endCall(call.id, { answered, reason });

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    db = await import('../lib/database.js');
    records = await import('../lib/pbx/call-records.js');
    await Organisation.create({ id: ORG, name: 'Visibility', capabilities: ['phoneSystem'] });
    await Organisation.create({ id: OTHER, name: 'Elsewhere', capabilities: ['phoneSystem'] });

    const person = (key, role, organisationId = ORG) => {
      users[key] = { id: `cv-${key}-${stamp}`, organisationId, role };
      return User.create({
        id: users[key].id, name: key, email: `${key}-${stamp}@example.com`, emailVerified: true,
        phone: '', phoneVerified: false, picture: '', role, organisationId,
      });
    };
    for (const [key, role] of [
      ['owner', 'owner'], ['admin', 'orgAdmin'], ['super', 'superAdmin'], ['support', 'support'], ['textOnly', 'textOnly'],
      ['alice', 'member'], ['bob', 'member'], ['carol', 'member'],
    ]) await person(key, role);
    await person('stranger', 'owner', OTHER);
    // Bob's login with one more grant: he may delete recordings, and still sees only his own calls.
    users.bobDeletes = { ...users.bob, permissions: { recording: ['delete'] } };
    for (const user of Object.values(users)) user.sql = { where: scopeWhereForUser(user) };

    // Alice and Bob are linked to directory people. Carol has a login and no person.
    const entry = (name, kind, loginUserId = null) => db.DirectoryEntry.create({ organisationId: ORG, name, kind, loginUserId });
    const alice = await entry('Alice', 'person', users.alice.id);
    const bob = await entry('Bob', 'person', users.bob.id);
    const sales = await entry('Sales', 'team');
    const ext = (number, entryId) => db.Extension.create({ organisationId: ORG, number, type: 'ring_all', entryId });
    const extAlice = await ext('201', alice.id);
    const extBob = await ext('202', bob.id);
    const extSales = await ext('300', sales.id);
    await db.ExtensionMember.bulkCreate([
      { organisationId: ORG, extensionId: extAlice.id, entryId: alice.id, huntPosition: 1 },
      { organisationId: ORG, extensionId: extBob.id, entryId: bob.id, huntPosition: 1 },
      { organisationId: ORG, extensionId: extSales.id, entryId: alice.id, huntPosition: 1 },
      { organisationId: ORG, extensionId: extSales.id, entryId: bob.id, huntPosition: 2 },
    ]);
    const phoneAlice = await db.Phone.create({ organisationId: ORG, label: 'Alice desk', kind: 'browser' });
    await db.PhonePerson.create({ organisationId: ORG, phoneId: phoneAlice.id, entryId: alice.id, position: 1 });
    const lineAlice = await db.Line.create({ organisationId: ORG, phoneId: phoneAlice.id, position: 1, kind: 'extension', extensionId: extAlice.id });

    // Calls in, all with no instance and no agent.
    calls.toAlice = await pbxCall({}, { direction: 'in', extensionId: extAlice.id, extensionNumber: '201' });
    calls.toAliceLeg = await pbxLeg(calls.toAlice, { kind: 'line', entryId: alice.id, phoneId: phoneAlice.id });
    await end(calls.toAliceLeg, true, 'hangup');
    await end(calls.toAlice, true, 'caller_hangup');
    calls.missedAlice = await pbxCall({}, { direction: 'in', extensionId: extAlice.id });
    await end(calls.missedAlice, false, 'no_answer');
    calls.salesBob = await pbxCall({}, { direction: 'in', extensionId: extSales.id });
    calls.salesBobLeg = await pbxLeg(calls.salesBob, { kind: 'line', entryId: bob.id });
    await end(calls.salesBobLeg, true, 'hangup');
    await end(calls.salesBob, true, 'callee_hangup');
    // Nobody took it. Alice's mobile answered and waited for its key, which never came.
    calls.salesMissed = await pbxCall({}, { direction: 'in', extensionId: extSales.id });
    const mobile = await pbxLeg(calls.salesMissed, { kind: 'external', entryId: alice.id, keyToAnswer: true });
    await end(mobile, false, 'no_key');
    await end(calls.salesMissed, false, 'no_answer');
    // In progress: Bob has answered a call to Sales, and Alice's mobile waits for its key on another.
    calls.salesNow = await pbxCall({}, { direction: 'in', extensionId: extSales.id });
    calls.salesNowLeg = await pbxLeg(calls.salesNow, { kind: 'line', entryId: bob.id });
    calls.salesWaiting = await pbxCall({}, { direction: 'in', extensionId: extSales.id });
    calls.salesWaitingLeg = await pbxLeg(calls.salesWaiting, { kind: 'external', entryId: alice.id, keyToAnswer: true });
    // Calls out from Alice's phone, and from her line on another phone.
    calls.aliceOut = await pbxCall({ callerId: '201', calledId: '+442079460999' }, { direction: 'out', fromPhoneId: phoneAlice.id, fromLineId: lineAlice.id });
    calls.aliceLineOut = await pbxCall({ callerId: '201', calledId: '+442079460998' }, { direction: 'out', fromPhoneId: randomUUID(), fromLineId: lineAlice.id });
    // An agent call whose listener has gone: no instance.
    calls.agent = await Call.create({
      id: randomUUID(), organisationId: ORG, platform: 'livekit', modelName: 'livekit:openai/gpt-realtime',
      callerId: '+442079460123', calledId: '+442079460100', status: 'ended normally',
    });
    calls.elsewhere = await Call.create({
      id: randomUUID(), organisationId: OTHER, platform: 'pbx', modelName: 'telephony:pbx-call',
      callerId: '+442079460123', calledId: '201', metadata: { pbx: { direction: 'in' } },
    });

    await TransactionLog.create({ callId: calls.toAlice.id, organisationId: ORG, type: 'user', data: 'hello' });
    await TransactionLog.create({ callId: calls.agent.id, organisationId: ORG, type: 'user', data: 'hi agent' });
    await Call.update({ recordingId: 'test/recording.enc' }, { where: { id: calls.toAlice.id } });

    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.log = log;
      res.locals.user = users[req.headers['x-test-user']];
      next();
    });
    for (const file of ['calls.js', 'calls/{callId}.js', 'calls/{callId}/linked.js', 'calls/{callId}/logs.js', 'calls/{callId}/recording.js', 'calls/{callId}/invocation-log.js']) {
      await import(`../api/paths/${file}`);
    }
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{calls.js,calls/{callId}.js,calls/{callId}/{linked,logs,recording,invocation-log}.js}',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
  }, 60000);

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await TransactionLog.destroy({ where: { organisationId: [ORG, OTHER] } });
    await Call.destroy({ where: { organisationId: [ORG, OTHER], parentId: { [db.Op.ne]: null } } });
    await Call.destroy({ where: { organisationId: [ORG, OTHER] } });
    await db.Line.destroy({ where: { organisationId: ORG } });
    await db.PhonePerson.destroy({ where: { organisationId: ORG } });
    await db.Phone.destroy({ where: { organisationId: ORG } });
    await db.ExtensionMember.destroy({ where: { organisationId: ORG } });
    await db.Extension.destroy({ where: { organisationId: ORG } });
    await db.DirectoryEntry.destroy({ where: { organisationId: ORG } });
    await User.destroy({ where: { organisationId: [ORG, OTHER] } });
    await Organisation.destroy({ where: { id: [ORG, OTHER] } });
    await teardownRealDatabase();
  }, 60000);

  const everyCallOfOrg = () => Object.entries(calls).filter(([key]) => key !== 'elsewhere').map(([, call]) => call.id);

  describe('each role', () => {
    test.each(['owner', 'admin', 'super', 'support', 'textOnly'])('%s sees every call of the organisation', async (user) => {
      const seen = await listed(user);
      for (const id of everyCallOfOrg()) expect(seen.has(id)).toBe(true);
      expect(seen.has(calls.elsewhere.id)).toBe(false);
    });

    test('an ordinary member sees agent calls and the phone system calls that involve them', async () => {
      const seen = await listed('alice');
      for (const key of ['agent', 'toAlice', 'toAliceLeg', 'missedAlice', 'aliceOut', 'aliceLineOut']) {
        expect([key, seen.has(calls[key].id)]).toEqual([key, true]);
      }
      for (const key of ['salesBob', 'salesBobLeg', 'salesMissed', 'salesNow', 'salesWaiting', 'elsewhere']) {
        expect([key, seen.has(calls[key].id)]).toEqual([key, false]);
      }
    });

    test("another member does not see a call to someone else's own extension", async () => {
      const seen = await listed('bob');
      for (const key of ['toAlice', 'toAliceLeg', 'missedAlice', 'aliceOut', 'aliceLineOut']) {
        expect([key, seen.has(calls[key].id)]).toEqual([key, false]);
      }
    });

    test("another organisation's owner sees none of them", async () => {
      const seen = await listed('stranger');
      for (const id of everyCallOfOrg()) expect(seen.has(id)).toBe(false);
    });
  });

  describe('a shared extension', () => {
    test('a call shows to the member who answered it, and not to the member whose phone only rang', async () => {
      expect((await listed('bob')).has(calls.salesBob.id)).toBe(true);
      expect((await listed('bob')).has(calls.salesBobLeg.id)).toBe(true);
      expect((await listed('alice')).has(calls.salesBob.id)).toBe(false);
    });

    test('the member who answered sees the call while it is in progress', async () => {
      expect((await listed('bob')).has(calls.salesNow.id)).toBe(true);
      expect((await get('bob', `/calls/${calls.salesNow.id}`)).status).toBe(200);
      expect((await get('bob', `/calls/${calls.salesNowLeg.id}`)).status).toBe(200);
      expect((await get('alice', `/calls/${calls.salesNow.id}`)).status).toBe(404);
    });

    test('a mobile waiting for its key does not count until the key comes', async () => {
      expect((await get('alice', `/calls/${calls.salesWaiting.id}`)).status).toBe(404);
      await records.upsertCall({ id: calls.salesWaitingLeg.id, organisationId: ORG, parentId: calls.salesWaiting.id, metadata: { keyPressedAt: new Date().toISOString() } });
      expect((await get('alice', `/calls/${calls.salesWaiting.id}`)).status).toBe(200);
      expect((await get('bob', `/calls/${calls.salesWaiting.id}`)).status).toBe(404);
    });

    test('a call nobody answered shows only to those who see every call', async () => {
      expect((await listed('alice')).has(calls.salesMissed.id)).toBe(false);
      expect((await listed('bob')).has(calls.salesMissed.id)).toBe(false);
      expect((await listed('admin')).has(calls.salesMissed.id)).toBe(true);
    });
  });

  describe('a login with no linked person', () => {
    test('sees agent calls and no phone system calls', async () => {
      const seen = await listed('carol');
      expect(seen.has(calls.agent.id)).toBe(true);
      for (const key of ['toAlice', 'missedAlice', 'salesBob', 'salesMissed', 'aliceOut']) {
        expect([key, seen.has(calls[key].id)]).toEqual([key, false]);
      }
    });
  });

  describe('what a call read shows of a phone system call', () => {
    test('GET /calls/{id} gives the listed facts of metadata.pbx, and nothing else stored there', async () => {
      const call = await pbxCall({ callerId: '201', calledId: '999' }, {
        direction: 'emergency', extensionNumber: '201', presentNumber: '+442079460100', addressState: 'accepted', numberFrom: 'plan',
        fromLineNumber: 1, engine: 'engine-1', planId: 'plan-1', sourceAddress: '192.0.2.10', extensionName: { nested: true },
      });
      await end(call, true, 'callee_hangup');
      const res = await get('owner', `/calls/${call.id}`);
      expect(res.status).toBe(200);
      expect(res.body.metadata).toEqual({
        pbx: {
          direction: 'emergency', extensionNumber: '201', presentNumber: '+442079460100', addressState: 'accepted', numberFrom: 'plan',
          fromLineNumber: 1, endReason: 'callee_hangup', answered: true,
        },
      });
    });

    test('the list and /linked give them for the call and its leg, to the party who answered', async () => {
      const item = (await get('alice', '/calls?limit=500')).body.calls.find((c) => c.id === calls.toAlice.id);
      expect(item.metadata.pbx).toMatchObject({ direction: 'in', extensionNumber: '201', endReason: 'caller_hangup', answered: true });
      const linked = (await get('alice', `/calls/${calls.toAliceLeg.id}/linked`)).body.calls;
      const leg = linked.find((c) => c.id === calls.toAliceLeg.id);
      expect(leg.metadata.pbx).toMatchObject({ kind: 'line', endReason: 'hangup', answered: true });
      expect(linked.find((c) => c.id === calls.toAlice.id).metadata.pbx).toMatchObject({ direction: 'in' });
    });

    test('a call out of sight gives nothing, and an agent call has no metadata', async () => {
      expect((await get('bob', `/calls/${calls.toAlice.id}`)).status).toBe(404);
      await Call.update({ metadata: { aplisay: { note: 'kept' } } }, { where: { id: calls.agent.id } });
      const agentCall = await get('owner', `/calls/${calls.agent.id}`);
      expect(agentCall.status).toBe(200);
      expect(agentCall.body).not.toHaveProperty('metadata');
      const item = (await get('owner', '/calls?limit=500')).body.calls.find((c) => c.id === calls.agent.id);
      expect(item).not.toHaveProperty('metadata');
    });

    test('a deleted call has no metadata', async () => {
      const call = await pbxCall({}, { direction: 'in', extensionNumber: '201' });
      await end(call, false, 'no_answer');
      const { redactCallTree, SETTLE_MS } = await import('../lib/call-redaction.js');
      const result = await redactCallTree({
        callId: call.id, scope: { organisationId: ORG }, now: new Date(Date.now() + SETTLE_MS + 60_000), deleteRecordingObject: async () => {},
      });
      expect(result.outcome).toBe('redacted');
      const item = (await get('owner', '/calls?limit=500&redacted=include')).body.calls.find((c) => c.id === call.id);
      expect(item.redactedAt).toBeTruthy();
      expect(item).not.toHaveProperty('metadata');
    });
  });

  describe('one call, its tree, its transcript and its recording follow the same rule', () => {
    test('GET /calls/{id}', async () => {
      expect((await get('alice', `/calls/${calls.toAlice.id}`)).status).toBe(200);
      expect((await get('alice', `/calls/${calls.toAliceLeg.id}`)).status).toBe(200);
      expect((await get('bob', `/calls/${calls.toAlice.id}`)).status).toBe(404);
      expect((await get('carol', `/calls/${calls.toAlice.id}`)).status).toBe(404);
      expect((await get('carol', `/calls/${calls.agent.id}`)).status).toBe(200);
      expect((await get('owner', `/calls/${calls.salesMissed.id}`)).status).toBe(200);
    });

    test('GET /calls/{id}/linked', async () => {
      const res = await get('alice', `/calls/${calls.toAliceLeg.id}/linked`);
      expect(res.status).toBe(200);
      expect(res.body.calls.map((c) => c.id).sort()).toEqual([calls.toAlice.id, calls.toAliceLeg.id].sort());
      expect((await get('bob', `/calls/${calls.toAliceLeg.id}/linked`)).status).toBe(404);
    });

    test('GET /calls/{id}/logs', async () => {
      expect((await get('alice', `/calls/${calls.toAlice.id}/logs`)).body).toHaveLength(1);
      expect((await get('owner', `/calls/${calls.toAlice.id}/logs`)).body).toHaveLength(1);
      expect((await get('bob', `/calls/${calls.toAlice.id}/logs`)).body).toEqual([]);
      expect((await get('carol', `/calls/${calls.toAlice.id}/logs`)).body).toEqual([]);
      expect((await get('carol', `/calls/${calls.agent.id}/logs`)).body).toHaveLength(1);
    });

    test('GET /calls/{id}/invocation-log', async () => {
      expect((await get('bob', `/calls/${calls.toAlice.id}/invocation-log`)).body).toEqual([]);
      expect((await get('alice', `/calls/${calls.toAlice.id}/invocation-log`)).status).toBe(200);
    });

    test('GET /calls/{id}/recording', async () => {
      // The test store holds no such object: a visible call gets 500, and a call out of sight 404.
      const alice = await get('alice', `/calls/${calls.toAlice.id}/recording`);
      expect(alice.status).not.toBe(404);
      expect((await get('owner', `/calls/${calls.toAlice.id}/recording`)).status).toBe(alice.status);
      const bob = await get('bob', `/calls/${calls.toAlice.id}/recording`);
      expect(bob.status).toBe(404);
      expect(bob.body.error).toBe('Call not found');
      expect((await request(server).delete(`/api/calls/${calls.toAlice.id}/recording`).set('x-test-user', 'bobDeletes')).status).toBe(404);
      expect((await Call.findByPk(calls.toAlice.id)).recordingId).toBe('test/recording.enc');
    });
  });

  describe('POST /agents/{id}/invoke with a call', () => {
    let invoke;
    let agent;
    const call = async (user, callId) => {
      const res = {
        _status: 200, _body: null, locals: { user: users[user] },
        status(code) { this._status = code; return this; },
        send(body) { this._body = body; return this; },
        json(body) { this._body = body; return this; },
      };
      await invoke({ params: { agentId: agent.id }, body: { input: 'summarise', callId }, query: {}, headers: {}, log }, res);
      return res;
    };

    beforeAll(async () => {
      invoke = (await import('../api/paths/agents/{agentId}/invoke.js')).default(log).POST;
      agent = await db.Agent.create({
        name: 'Summary', type: 'text', modelName: 'text:anthropic/claude-opus-4-8', prompt: 'Summarise.',
        organisationId: ORG, userId: users.owner.id,
      });
    });
    afterAll(() => db.Agent.destroy({ where: { id: agent.id } }));

    test('answers a hidden call as it answers a missing one, and runs nothing', async () => {
      runSubagent.mockClear();
      const hidden = await call('bob', calls.toAlice.id);
      const missingId = randomUUID();
      const missing = await call('bob', missingId);
      expect([hidden._status, missing._status]).toEqual([404, 404]);
      expect(hidden._body.message.replace(calls.toAlice.id, 'X')).toBe(missing._body.message.replace(missingId, 'X'));
      expect(runSubagent).not.toHaveBeenCalled();
    });

    test('runs for a call its caller can see', async () => {
      runSubagent.mockClear();
      expect((await call('alice', calls.toAlice.id))._status).toBe(200);
      expect((await call('owner', calls.salesMissed.id))._status).toBe(200);
      expect(runSubagent).toHaveBeenCalledTimes(2);
    });
  });

  describe('calls with no instance', () => {
    test('are written and read by every route without one', async () => {
      for (const key of ['toAlice', 'agent']) expect(calls[key].instanceId ?? null).toBeNull();
      const res = await get('owner', `/calls/${calls.agent.id}/linked`);
      expect(res.status).toBe(200);
      expect(res.body.calls).toEqual([expect.objectContaining({ id: calls.agent.id, instanceId: null, agentId: null })]);
    });
  });

  describe('the condition itself', () => {
    test('allows every call for a principal that sees them all, and keeps the leg with its call', async () => {
      const { visibilityCondition, callVisibility } = await import('../lib/call-visibility.js');
      expect(visibilityCondition({ all: true })).toBeNull();
      expect(await callVisibility(users.owner)).toEqual({ all: true });
      const alice = await callVisibility(users.alice);
      expect(alice).toMatchObject({ all: false, extensionIds: [expect.any(String)], phoneIds: [expect.any(String)], lineIds: [expect.any(String)] });
      expect(await callVisibility(users.carol)).toMatchObject({ all: false, entryId: null, extensionIds: [] });
      expect(visibilityCondition(await callVisibility(users.carol)).val).toContain('FALSE');
    });
  });
});
