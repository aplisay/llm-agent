import {
  setupRealDatabase,
  teardownRealDatabase,
  databaseStarted,
  Call,
  TransactionLog,
  InvocationLog,
  UsageRecord,
  Organisation,
  User,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import { scopeWhereForUser } from '../lib/scope.js';
import { legBlocker, SETTLE_MS, STUCK_MS } from '../lib/call-redaction.js';

const mockLogger = { info() { }, error() { }, warn() { }, debug() { }, trace() { }, child() { return mockLogger; } };

const NOW = Date.parse('2026-11-23T12:00:00Z');
const MINUTE = 60 * 1000;

describe('legBlocker', () => {
  const now = new Date(NOW);
  const at = (msAgo) => new Date(NOW - msAgo);

  test('a live leg blocks, until it counts as stuck', () => {
    expect(legBlocker({ live: true, createdAt: at(MINUTE) }, now)).toBe('in_progress');
    expect(legBlocker({ live: false, endedAt: null, createdAt: at(MINUTE) }, now)).toBe('in_progress');
    expect(legBlocker({ live: true, createdAt: at(STUCK_MS + MINUTE) }, now)).toBeNull();
  });

  test('a leg that ended recently blocks until it has settled', () => {
    expect(legBlocker({ live: false, endedAt: at(MINUTE), createdAt: at(10 * MINUTE) }, now)).toBe('recently_ended');
    expect(legBlocker({ live: false, endedAt: at(SETTLE_MS + MINUTE), createdAt: at(SETTLE_MS + 5 * MINUTE) }, now)).toBeNull();
  });
});

describe('DELETE /calls/{callId}', () => {
  let db;
  let handlers;
  let idx = 1;
  // Tenancy is "same user OR same organisation", so each organisation gets its own user.
  const users = new Map();

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    db = await import('../lib/database.js');
    const callPath = (await import('../api/paths/calls/{callId}.js')).default(mockLogger);
    const listPath = (await import('../api/paths/calls.js')).default(mockLogger);
    const linkedPath = (await import('../api/paths/calls/{callId}/linked.js')).default(mockLogger);
    handlers = {
      get: callPath.GET,
      del: callPath.DELETE,
      list: listPath.GET,
      linked: linkedPath.GET,
      transcript: (await import('../api/paths/agent-db/transaction-log.js')).default(mockLogger).POST,
      invocation: (await import('../api/paths/agent-db/invocation-log.js')).default(mockLogger).POST,
      recording: (await import('../api/paths/agent-db/call/{callId}/recording.js')).default(mockLogger).PUT,
    };
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  const principal = (organisationId, role = 'owner') => {
    const user = { id: users.get(organisationId), organisationId, role };
    return { ...user, sql: { where: scopeWhereForUser(user) } };
  };

  async function call(handler, user, { params = {}, query = {}, body = {} } = {}) {
    const req = { params, query, body, log: mockLogger };
    const res = { locals: { user }, statusCode: 200, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.json = (b) => { res.body = b; return res; };
    await handler(req, res);
    return res;
  }

  const mkOrg = async () => {
    const id = randomUUID();
    await Organisation.create({ id, name: `Redaction Org ${id.slice(0, 8)}` });
    const uid = randomUUID();
    await User.upsert({
      id: uid, name: 'Redaction Tester', email: `redaction-${uid}@example.com`, organisationId: id,
      emailVerified: true, phone: '0000', phoneVerified: false, picture: '', role: 'owner',
    });
    users.set(id, uid);
    return id;
  };

  // Ended an hour ago unless told otherwise, so it has settled.
  const mkCall = async (organisationId, { parentId = null, live = false, endedMinutesAgo = 60, createdMinutesAgo = 70 } = {}) => {
    const userId = users.get(organisationId);
    const row = await Call.create({
      organisationId, userId, parentId, index: idx++,
      calledId: '+442080996945', callerId: '+443300889471',
      metadata: { aplisay: { callerIdName: 'Jane Caller' } },
      options: { prompt: 'secret prompt' },
      status: live ? 'in progress' : 'ended normally', platform: 'livekit', live,
      startedAt: new Date(Date.now() - createdMinutesAgo * MINUTE),
      endedAt: endedMinutesAgo === null ? null : new Date(Date.now() - endedMinutesAgo * MINUTE),
      recordingId: null,
    }, { hooks: false });
    await Call.sequelize.query('UPDATE calls SET created_at = :at WHERE id = :id', {
      replacements: { at: new Date(Date.now() - createdMinutesAgo * MINUTE), id: row.id },
    });
    await TransactionLog.create({ callId: row.id, organisationId, userId, type: 'user', data: { text: 'my card number is' }, isFinal: true }, { hooks: false });
    await InvocationLog.create({ callId: row.id, organisationId, userId, subsystem: 'livekit-agent', log: { encoding: 'none', data: 'x' } });
    await UsageRecord.create({
      sessionId: row.id, meterKey: `voice:${row.id}`, callId: row.id, organisationId,
      technology: 'voice', unit: 'milliseconds', quantity: 60000, finalised: true,
      metadata: { destinationRaw: '+442080996945' },
    });
    return row;
  };

  const mkTree = async (organisationId) => {
    const root = await mkCall(organisationId);
    const child = await mkCall(organisationId, { parentId: root.id });
    const grandchild = await mkCall(organisationId, { parentId: child.id });
    return { root, child, grandchild, ids: [root.id, child.id, grandchild.id] };
  };

  test('deleting any leg redacts the whole tree and keeps the billing record', async () => {
    const orgId = await mkOrg();
    const { child, ids } = await mkTree(orgId);
    const other = await mkCall(orgId);

    const res = await call(handlers.del, principal(orgId), { params: { callId: child.id } });
    expect(res.statusCode).toBe(200);
    expect(res.body.callIds.sort()).toEqual([...ids].sort());

    for (const id of ids) {
      const row = await Call.findByPk(id);
      expect(row.callerId).toBeNull();
      expect(row.calledId).toBeNull();
      expect(row.metadata).toEqual({});
      expect(row.options).toBeNull();
      expect(row.redactedAt).toBeInstanceOf(Date);
      expect(row.redactedBy).toBe(users.get(orgId));
      expect(row.organisationId).toBe(orgId);
      expect(row.endedAt).toBeInstanceOf(Date);
      expect(await TransactionLog.count({ where: { callId: id } })).toBe(0);
      expect(await InvocationLog.count({ where: { callId: id } })).toBe(0);
      const usage = await UsageRecord.findAll({ where: { callId: id } });
      expect(usage).toHaveLength(1);
      expect(usage[0].metadata.destinationRaw).toBe('+442080996945');
    }

    // A call outside the tree is untouched.
    const untouched = await Call.findByPk(other.id);
    expect(untouched.callerId).toBe('+443300889471');
    expect(untouched.redactedAt).toBeNull();
    expect(await TransactionLog.count({ where: { callId: other.id } })).toBe(1);
  });

  test('a deleted call is hidden from reads unless asked for', async () => {
    const orgId = await mkOrg();
    const { root, ids } = await mkTree(orgId);
    const kept = await mkCall(orgId);
    const user = principal(orgId);
    await call(handlers.del, user, { params: { callId: root.id } });

    expect((await call(handlers.get, user, { params: { callId: root.id } })).statusCode).toBe(404);
    expect((await call(handlers.linked, user, { params: { callId: root.id } })).statusCode).toBe(404);
    expect((await call(handlers.del, user, { params: { callId: root.id } })).statusCode).toBe(404);

    const listed = async (query) => (await call(handlers.list, user, { query })).body.calls.map((c) => c.id).sort();
    expect(await listed({})).toEqual([kept.id]);
    expect(await listed({ redacted: 'only' })).toEqual([...ids].sort());
    expect(await listed({ redacted: 'include' })).toEqual([...ids, kept.id].sort());

    // The handler sends model instances; read them as the client would.
    const shown = JSON.parse(JSON.stringify((await call(handlers.list, user, { query: { redacted: 'only' } })).body.calls[0]));
    expect(shown.callerId).toBeNull();
    expect(shown.redactedAt).toBeTruthy();
    expect(shown).toHaveProperty('costMicros');
  });

  test('refuses while a leg is in progress or has just ended, and names it', async () => {
    const orgId = await mkOrg();
    const root = await mkCall(orgId);
    const live = await mkCall(orgId, { parentId: root.id, live: true, endedMinutesAgo: null, createdMinutesAgo: 5 });
    let res = await call(handlers.del, principal(orgId), { params: { callId: root.id } });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('call_in_progress');
    expect(res.body.blockers).toEqual([{ callId: live.id, reason: 'in_progress' }]);
    expect((await Call.findByPk(root.id)).callerId).toBe('+443300889471');

    const recent = await mkCall(orgId, { endedMinutesAgo: 2, createdMinutesAgo: 5 });
    res = await call(handlers.del, principal(orgId), { params: { callId: recent.id } });
    expect(res.statusCode).toBe(409);
    expect(res.body.blockers[0].reason).toBe('recently_ended');
  });

  test('a stuck leg does not block, and its concurrency slot is freed', async () => {
    const orgId = await mkOrg();
    const stuck = await mkCall(orgId, { live: true, endedMinutesAgo: null, createdMinutesAgo: 25 * 60 });
    const userId = users.get(orgId);
    const agent = await db.Agent.create({
      name: 'Redaction agent', description: 't', modelName: 'livekit:ultravox/ultravox-v0.7',
      prompt: 'You are a test agent.', options: {}, functions: {}, keys: [], userId, organisationId: orgId,
    }, { validate: false });
    const instance = await db.Instance.create({ agentId: agent.id, type: 'livekit', key: 'k', userId, organisationId: orgId });
    await db.CallConcurrency.create({ callId: stuck.id, instanceId: instance.id, userId, organisationId: orgId });
    const res = await call(handlers.del, principal(orgId), { params: { callId: stuck.id } });
    expect(res.statusCode).toBe(200);
    expect(await db.CallConcurrency.count({ where: { callId: stuck.id } })).toBe(0);
    expect((await Call.findByPk(stuck.id)).live).toBe(false);
  });

  test('another organisation gets 404 and changes nothing', async () => {
    const orgId = await mkOrg();
    const otherOrg = await mkOrg();
    const target = await mkCall(orgId);
    const res = await call(handlers.del, principal(otherOrg), { params: { callId: target.id } });
    expect(res.statusCode).toBe(404);
    expect((await Call.findByPk(target.id)).redactedAt).toBeNull();
  });

  test('a member cannot delete', async () => {
    const orgId = await mkOrg();
    const target = await mkCall(orgId);
    const res = await call(handlers.del, principal(orgId, 'member'), { params: { callId: target.id } });
    expect(res.statusCode).toBe(403);
    expect((await Call.findByPk(target.id)).redactedAt).toBeNull();
  });

  test('late worker writes to a deleted call are refused with 410', async () => {
    const orgId = await mkOrg();
    const target = await mkCall(orgId);
    await call(handlers.del, principal(orgId), { params: { callId: target.id } });
    const worker = principal(orgId);
    const ids = { userId: users.get(orgId), organisationId: orgId, callId: target.id };

    let res = await call(handlers.transcript, worker, { body: { ...ids, type: 'agent', data: { text: 'late' } } });
    expect(res.statusCode).toBe(410);
    res = await call(handlers.invocation, worker, { body: { ...ids, log: { lines: ['late'] } } });
    expect(res.statusCode).toBe(410);
    res = await call(handlers.recording, worker, { params: { callId: target.id }, body: { recordingId: `recordings/${target.id}.ogg` } });
    expect(res.statusCode).toBe(410);

    expect(await TransactionLog.count({ where: { callId: target.id } })).toBe(0);
    expect(await InvocationLog.count({ where: { callId: target.id } })).toBe(0);
    expect((await Call.findByPk(target.id)).recordingId).toBeNull();
  });

  test('recording objects are deleted after the database change, and a failure is reported', async () => {
    const { redactCallTree } = await import('../lib/call-redaction.js');
    const orgId = await mkOrg();
    const a = await mkCall(orgId);
    const b = await mkCall(orgId, { parentId: a.id });
    await Call.update({ recordingId: `recordings/${a.id}.ogg` }, { where: { id: a.id }, hooks: false });
    await Call.update({ recordingId: `recordings/${b.id}.ogg` }, { where: { id: b.id }, hooks: false });
    const deleted = [];
    const result = await redactCallTree({
      callId: a.id,
      scope: { organisationId: orgId },
      deleteRecordingObject: async (name) => {
        if (name.includes(b.id)) throw new Error('storage down');
        deleted.push(name);
      },
    });
    expect(result.outcome).toBe('redacted');
    expect(deleted).toEqual([`recordings/${a.id}.ogg`]);
    expect(result.recordingErrors).toEqual([{ callId: b.id, objectName: `recordings/${b.id}.ogg` }]);
    expect((await Call.findByPk(a.id)).recordingId).toBeNull();
    expect((await Call.findByPk(b.id)).recordingId).toBeNull();
  });
});
