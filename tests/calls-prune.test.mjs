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

// POST /calls/prune — org-scoped bulk artifact pruning (retention seam for
// client systems). Covers: artifact-aware matching + idempotency, live/unended
// exclusion, call-row + usage-record preservation, batching, tenancy scoping
// and body validation. GCS is stubbed via the module's storage-factory seam.

const mockLogger = { info() { }, error() { }, warn() { }, debug() { }, trace() { }, child() { return mockLogger; } };

const FUTURE = '2100-01-01T00:00:00Z';

describe('POST /calls/prune', () => {
  let prunePOST;
  let setStorageFactory;
  let userId;
  let idx = 1;
  const deletedObjects = [];
  const fakeStorage = {
    bucket: (bucket) => ({
      file: (objectName) => ({
        delete: async () => { deletedObjects.push({ bucket, objectName }); },
      }),
    }),
  };

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    const mod = await import('../api/paths/calls/prune.js');
    prunePOST = mod.default(mockLogger).POST;
    setStorageFactory = mod._setStorageFactory;
    setStorageFactory(() => fakeStorage);

    userId = randomUUID();
    await User.upsert({
      id: userId,
      name: 'Prune Tester',
      email: `prune-${userId}@example.com`,
      emailVerified: true,
      phone: '0000',
      phoneVerified: false,
      picture: '',
      role: 'owner',
    });
  }, 30000);

  afterAll(async () => {
    setStorageFactory(null);
    await teardownRealDatabase();
  }, 60000);

  function mockReqRes(user, body = {}) {
    const req = { params: {}, body, query: {}, log: mockLogger };
    const res = { locals: { user }, statusCode: 200, body: undefined };
    res.status = (c) => { res.statusCode = c; return res; };
    res.send = (b) => { res.body = b; return res; };
    res.json = (b) => { res.body = b; return res; };
    return { req, res };
  }

  const prune = async (user, body) => {
    const { req, res } = mockReqRes(user, body);
    await prunePOST(req, res);
    return res;
  };

  const mkOrg = async () => {
    const id = randomUUID();
    await Organisation.create({ id, name: `Prune Org ${id.slice(0, 8)}` });
    return id;
  };

  const mkCall = async (orgId, {
    live = false,
    endedAt = new Date('2026-01-01T01:00:00Z'),
    recording = false,
    transcript = false,
    invocation = false,
  } = {}) => {
    const call = await Call.create({
      organisationId: orgId,
      userId,
      index: idx++,
      calledId: '+442080996945',
      callerId: '+443300889471',
      status: live ? 'in progress' : 'ended normally',
      platform: 'test',
      live,
      startedAt: new Date('2026-01-01T00:00:00Z'),
      endedAt,
      ...(recording ? { recordingId: `test-recordings/${randomUUID()}.ogg`, encryptionKey: 'k'.repeat(32) } : {}),
    }, { hooks: false });
    if (transcript) {
      await TransactionLog.create({ callId: call.id, organisationId: orgId, userId, type: 'user', data: { text: 'hello' }, isFinal: true }, { hooks: false });
      await TransactionLog.create({ callId: call.id, organisationId: orgId, userId, type: 'agent', data: { text: 'hi' }, isFinal: true }, { hooks: false });
    }
    if (invocation) {
      await InvocationLog.create({ callId: call.id, organisationId: orgId, userId, subsystem: 'livekit-agent', log: { encoding: 'none', data: 'x' } });
    }
    return call;
  };

  test('prunes all artifact types, keeps call rows + usage records, deletes storage objects, and is idempotent', async () => {
    const orgId = await mkOrg();
    const c1 = await mkCall(orgId, { recording: true, transcript: true, invocation: true });
    const c2 = await mkCall(orgId, { transcript: true });
    const c3 = await mkCall(orgId, { recording: true });
    const c1Recording = c1.recordingId;
    const c3Recording = c3.recordingId;

    await UsageRecord.create({
      sessionId: c1.id,
      meterKey: 'llm:test:1',
      callId: c1.id,
      organisationId: orgId,
      technology: 'llm',
      unit: 'input_tokens',
      quantity: 10,
    });

    const user = { id: userId, role: 'superAdmin', organisationId: orgId };
    const res = await prune(user, { before: FUTURE });

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      matched: 3,
      prunedRecordings: 2,
      prunedTranscripts: 2,
      prunedInvocationLogs: 1,
      remaining: false,
    });

    // Call rows survive, with only the recording metadata columns nulled.
    for (const call of [c1, c2, c3]) {
      const row = await Call.findByPk(call.id);
      expect(row).not.toBeNull();
      expect(row.recordingId).toBeNull();
      expect(row.getDataValue('encryptionKey')).toBeNull();
      expect(row.status).toBe('ended normally');
    }

    // Artifacts gone; the usage (billing) record is untouched.
    expect(await TransactionLog.count({ where: { callId: [c1.id, c2.id, c3.id] } })).toBe(0);
    expect(await InvocationLog.count({ where: { callId: [c1.id, c2.id, c3.id] } })).toBe(0);
    expect(await UsageRecord.count({ where: { callId: c1.id } })).toBe(1);

    // The stub storage saw exactly the two recording objects.
    const objectNames = deletedObjects.map((d) => d.objectName);
    expect(objectNames).toContain(c1Recording);
    expect(objectNames).toContain(c3Recording);

    // Second identical request: everything already pruned -> nothing matches.
    const again = await prune(user, { before: FUTURE });
    expect(again.statusCode).toBe(200);
    expect(again.body).toEqual({
      matched: 0,
      prunedRecordings: 0,
      prunedTranscripts: 0,
      prunedInvocationLogs: 0,
      remaining: false,
    });
  });

  test('matching is artifact-aware: only calls holding a REQUESTED artifact are selected', async () => {
    const orgId = await mkOrg();
    const recOnly = await mkCall(orgId, { recording: true });
    const txOnly = await mkCall(orgId, { transcript: true });
    const user = { id: userId, role: 'superAdmin', organisationId: orgId };

    const txPass = await prune(user, { before: FUTURE, artifacts: ['transcript'] });
    expect(txPass.statusCode).toBe(200);
    expect(txPass.body.matched).toBe(1);
    expect(txPass.body.prunedTranscripts).toBe(1);
    expect(txPass.body.prunedRecordings).toBe(0);

    // The recording-only call was not touched by a transcript-only prune.
    expect((await Call.findByPk(recOnly.id)).recordingId).not.toBeNull();
    // ... and a repeat transcript pass finds nothing (terminating).
    expect((await prune(user, { before: FUTURE, artifacts: ['transcript'] })).body.matched).toBe(0);

    const recPass = await prune(user, { before: FUTURE, artifacts: ['recording'] });
    expect(recPass.body).toMatchObject({ matched: 1, prunedRecordings: 1, remaining: false });
    expect((await Call.findByPk(recOnly.id)).recordingId).toBeNull();
    expect((await Call.findByPk(txOnly.id)).id).toBe(txOnly.id);
  });

  test('never touches live or unended calls', async () => {
    const orgId = await mkOrg();
    const liveCall = await mkCall(orgId, { live: true, endedAt: null, recording: true, transcript: true });
    const unended = await mkCall(orgId, { live: false, endedAt: null, recording: true });
    const user = { id: userId, role: 'superAdmin', organisationId: orgId };

    const res = await prune(user, { before: FUTURE });
    expect(res.statusCode).toBe(200);
    expect(res.body.matched).toBe(0);

    expect((await Call.findByPk(liveCall.id)).recordingId).not.toBeNull();
    expect((await Call.findByPk(unended.id)).recordingId).not.toBeNull();
    expect(await TransactionLog.count({ where: { callId: liveCall.id } })).toBe(2);
  });

  test('a cut-off in the past matches nothing', async () => {
    const orgId = await mkOrg();
    await mkCall(orgId, { transcript: true });
    const user = { id: userId, role: 'superAdmin', organisationId: orgId };
    const res = await prune(user, { before: '1970-01-01T00:00:00Z' });
    expect(res.body.matched).toBe(0);
  });

  test('batches by limit (clamped) and reports remaining until drained', async () => {
    const orgId = await mkOrg();
    await mkCall(orgId, { transcript: true });
    await mkCall(orgId, { transcript: true });
    await mkCall(orgId, { transcript: true });
    const user = { id: userId, role: 'superAdmin', organisationId: orgId };

    const first = await prune(user, { before: FUTURE, limit: 2 });
    expect(first.body).toMatchObject({ matched: 2, prunedTranscripts: 2, remaining: true });

    // limit: 0 clamps up to 1 — the last call drains and the loop terminates.
    const second = await prune(user, { before: FUTURE, limit: 0 });
    expect(second.body).toMatchObject({ matched: 1, prunedTranscripts: 1, remaining: true });

    const third = await prune(user, { before: FUTURE, limit: 2 });
    expect(third.body).toEqual({ matched: 0, prunedRecordings: 0, prunedTranscripts: 0, prunedInvocationLogs: 0, remaining: false });
  });

  test('tenancy: org-scoped callers are confined to their own organisation', async () => {
    const orgA = await mkOrg();
    const orgB = await mkOrg();
    await mkCall(orgA, { transcript: true });
    const foreign = await mkCall(orgB, { transcript: true });

    // An org-scoped principal holding call:prune via a permissions override.
    const scoped = { id: userId, role: 'owner', organisationId: orgA, permissions: { call: ['prune'] } };

    // Naming someone else's organisation: 404, and their data is untouched.
    const denied = await prune(scoped, { before: FUTURE, organisationId: orgB });
    expect(denied.statusCode).toBe(404);
    expect(await TransactionLog.count({ where: { callId: foreign.id } })).toBe(2);

    // Explicitly naming their OWN organisation is fine.
    const own = await prune(scoped, { before: FUTURE, organisationId: orgA });
    expect(own.statusCode).toBe(200);
    expect(own.body.matched).toBe(1);

    // Defaulting to their own organisation also works (already drained -> 0).
    const defaulted = await prune(scoped, { before: FUTURE });
    expect(defaulted.statusCode).toBe(200);
    expect(defaulted.body.matched).toBe(0);
  });

  test('tenancy: the billing-service role prunes cross-org; unknown orgs 404; no permission 403', async () => {
    const serviceOrg = await mkOrg();
    const orgB = await mkOrg();
    const foreign = await mkCall(orgB, { transcript: true, invocation: true });

    const service = { id: userId, role: 'billingService', organisationId: serviceOrg };
    const res = await prune(service, { before: FUTURE, organisationId: orgB });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ matched: 1, prunedTranscripts: 1, prunedInvocationLogs: 1 });
    expect(await TransactionLog.count({ where: { callId: foreign.id } })).toBe(0);
    expect((await Call.findByPk(foreign.id))).not.toBeNull();

    const missing = await prune(service, { before: FUTURE, organisationId: randomUUID() });
    expect(missing.statusCode).toBe(404);

    const noPerm = await prune({ id: userId, role: 'owner', organisationId: orgB }, { before: FUTURE });
    expect(noPerm.statusCode).toBe(403);
  });

  test('validates before, artifacts, limit and organisationId', async () => {
    const orgId = await mkOrg();
    const user = { id: userId, role: 'superAdmin', organisationId: orgId };

    expect((await prune(user, {})).statusCode).toBe(400);
    expect((await prune(user, { before: 'not-a-date' })).statusCode).toBe(400);
    expect((await prune(user, { before: 42 })).statusCode).toBe(400);
    expect((await prune(user, { before: FUTURE, artifacts: [] })).statusCode).toBe(400);
    expect((await prune(user, { before: FUTURE, artifacts: ['bogus'] })).statusCode).toBe(400);
    expect((await prune(user, { before: FUTURE, artifacts: 'recording' })).statusCode).toBe(400);
    expect((await prune(user, { before: FUTURE, limit: 1.5 })).statusCode).toBe(400);
    expect((await prune(user, { before: FUTURE, limit: 'ten' })).statusCode).toBe(400);
    expect((await prune(user, { before: FUTURE, organisationId: 42 })).statusCode).toBe(400);
  });
});
