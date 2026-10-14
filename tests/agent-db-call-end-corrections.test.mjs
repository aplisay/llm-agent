/**
 * POST /api/agent-db/call/{callId}/end with transactionLogCorrections: rows a
 * worker streamed during the call get their reconciled createdAt before the
 * call ends (and so before the end hook reads them back). Bad entries are
 * skipped without stopping the call from ending.
 */
import { randomUUID } from 'crypto';
import {
  setupRealDatabase,
  teardownRealDatabase,
  Agent,
  Instance,
  Call,
  User,
  Organisation,
  TransactionLog,
} from './setup/database-test-wrapper.js';

describe('agent-db call end transaction log corrections', () => {
  const warnings = [];
  const mockLogger = {
    info: () => {},
    error: () => {},
    warn: (fields, msg) => warnings.push({ ...fields, msg }),
    debug: () => {},
    child: () => mockLogger,
  };
  let callCreate;
  let callEnd;
  let ctx;

  beforeAll(async () => {
    await setupRealDatabase();
    callCreate = (await import('../api/paths/agent-db/call.js')).default(mockLogger, {}, {}).POST;
    callEnd = (await import('../api/paths/agent-db/call/{callId}/end.js')).default(mockLogger, {}, {}).POST;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    const organisationId = randomUUID();
    const userId = randomUUID();
    await Organisation.create({ id: organisationId, name: 'Call end corrections org' });
    await User.create({
      id: userId,
      organisationId,
      name: 'Test User',
      email: 'call-end-corrections@test.example.com',
      emailVerified: true,
      phone: '+10000000000',
      phoneVerified: true,
      picture: 'https://example.com/p.png',
      role: 'owner',
    });
    const agent = await Agent.create({
      name: 'Call end corrections agent',
      description: 't',
      modelName: 'livekit:ultravox/ultravox-v0.7',
      prompt: 'You are a test agent.',
      options: {},
      functions: {},
      keys: [],
      userId,
      organisationId,
    });
    const instance = await Instance.create({
      agentId: agent.id,
      type: 'livekit',
      key: 'k',
      userId,
      organisationId,
    });
    ctx = { userId, organisationId, agentId: agent.id, instanceId: instance.id };
  });

  afterEach(async () => {
    await TransactionLog.destroy({ where: {} }).catch(() => {});
    await Call.destroy({ where: {} }).catch(() => {});
    await Instance.destroy({ where: {} }).catch(() => {});
    await Agent.destroy({ where: {} }).catch(() => {});
    await User.destroy({ where: {} }).catch(() => {});
    await Organisation.destroy({ where: {} }).catch(() => {});
  });

  const response = () => ({
    _status: null,
    _body: null,
    status(code) {
      this._status = code;
      return this;
    },
    send(body) {
      this._body = body;
      return this;
    },
  });

  async function newCall() {
    const res = response();
    await callCreate({ body: { ...ctx, id: randomUUID(), platform: 'livekit' } }, res);
    const call = await Call.findByPk(res._body.id);
    await call.start();
    return call;
  }

  const userRow = (callId, createdAt, data) =>
    TransactionLog.create({ userId: ctx.userId, organisationId: ctx.organisationId, callId, type: 'user', data, isFinal: true, createdAt });

  test('streamed rows get their reconciled createdAt and the call still ends', async () => {
    const call = await newCall();
    const other = await newCall();
    const t0 = Date.parse('2026-10-14T17:21:00.000Z');
    const first = await userRow(call.id, new Date(t0 + 5000), 'Hello');
    const second = await userRow(call.id, new Date(t0 + 9000), 'Goodbye');
    const otherCallRow = await userRow(other.id, new Date(t0 + 5000), 'Not this call');

    const res = response();
    await callEnd({
      params: { callId: call.id },
      body: {
        reason: 'normal',
        transactionLogCorrections: [
          { id: first.id, createdAt: new Date(t0 + 4200).toISOString() },
          { id: otherCallRow.id, createdAt: new Date(t0 + 1000).toISOString() },
          { id: 'not-a-number', createdAt: new Date(t0).toISOString() },
          { id: second.id, createdAt: 'not a date' },
        ],
      },
    }, res);

    expect(res._status).toBeNull();
    expect(res._body.callId).toBe(call.id);
    expect(warnings).toEqual([]);
    expect((await TransactionLog.findByPk(first.id)).createdAt.getTime()).toBe(t0 + 4200);
    expect((await TransactionLog.findByPk(second.id)).createdAt.getTime()).toBe(t0 + 9000);
    expect((await TransactionLog.findByPk(otherCallRow.id)).createdAt.getTime()).toBe(t0 + 5000);
    expect((await Call.findByPk(call.id)).live).toBe(false);
    expect(await TransactionLog.count({ where: { callId: call.id, type: 'hangup' } })).toBe(1);
  });

  test('batched rows keep the createdAt the worker sent', async () => {
    const call = await newCall();
    const at = '2026-10-14T17:21:04.200Z';

    const res = response();
    await callEnd({
      params: { callId: call.id },
      body: {
        reason: 'normal',
        transactionLogs: [{ userId: ctx.userId, organisationId: ctx.organisationId, type: 'user', data: '"Hello"', isFinal: true, createdAt: at }],
      },
    }, res);

    const [row] = await TransactionLog.findAll({ where: { callId: call.id, type: 'user' } });
    expect(row.createdAt.toISOString()).toBe(at);
  });
});
