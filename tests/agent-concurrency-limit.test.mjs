import { randomUUID } from 'crypto';
import {
  setupRealDatabase,
  teardownRealDatabase,
  Agent,
  Instance,
  Call,
  User,
  Organisation,
} from './setup/database-test-wrapper.js';
import { AgentConcurrencyLimitExceededError } from '../lib/concurrency/agent-concurrency-limits.js';

describe('Agent concurrency limits', () => {
  let InstanceConcurrency;
  let UserConcurrency;
  let OrganisationConcurrency;

  const mockLogger = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    child: () => mockLogger,
  };

  beforeAll(async () => {
    await setupRealDatabase();
    const db = await import('../lib/database.js');
    InstanceConcurrency = db.InstanceConcurrency;
    UserConcurrency = db.UserConcurrency;
    OrganisationConcurrency = db.OrganisationConcurrency;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  async function createOrgUserAgentInstance(overrides = {}) {
    const orgId = overrides.orgId ?? randomUUID();
    const userId = overrides.userId ?? randomUUID();
    const agentLimitUser = overrides.agentLimitUser ?? null;
    const agentLimitOrg = overrides.agentLimitOrg ?? null;
    const agentLimitInstance = overrides.agentLimitInstance ?? null;

    await Organisation.create({
      id: orgId,
      name: 'Concurrency test org',
      agentLimit: agentLimitOrg,
    });
    await User.create({
      id: userId,
      organisationId: orgId,
      name: 'Test User',
      email: 'c@test.example.com',
      emailVerified: true,
      phone: '+10000000000',
      phoneVerified: true,
      picture: 'https://example.com/p.png',
      role: { admin: true },
      agentLimit: agentLimitUser,
    });
    const agent = await Agent.create({
      name: 'Concurrency agent',
      description: 't',
      modelName: 'livekit:ultravox/ultravox-v0.7',
      prompt: 'You are a test agent.',
      options: { tts: { language: 'any', voice: 'Ciara' } },
      functions: {},
      keys: [],
      userId,
      organisationId: orgId,
    });
    const instance = await Instance.create({
      agentId: agent.id,
      type: 'livekit',
      key: 'k',
      userId,
      organisationId: orgId,
      agentLimit: agentLimitInstance,
    });
    return { orgId, userId, agentId: agent.id, instanceId: instance.id };
  }

  async function createCallRow(ctx, callId = randomUUID()) {
    return Call.create({
      id: callId,
      instanceId: ctx.instanceId,
      agentId: ctx.agentId,
      userId: ctx.userId,
      organisationId: ctx.orgId,
      callerId: '+441',
      calledId: '+442',
      platform: 'livekit',
    });
  }

  afterEach(async () => {
    await Call.destroy({ where: {} }).catch(() => {});
    await Instance.destroy({ where: {} }).catch(() => {});
    await Agent.destroy({ where: {} }).catch(() => {});
    await User.destroy({ where: {} }).catch(() => {});
    await Organisation.destroy({ where: {} }).catch(() => {});
  });

  test('A1 user.agentLimit=1 blocks second concurrent start', async () => {
    const ctx = await createOrgUserAgentInstance({ agentLimitUser: 1 });
    const c1 = await createCallRow(ctx);
    const c2 = await createCallRow(ctx);
    await expect(c1.start()).resolves.toBeUndefined();
    await expect(c2.start()).rejects.toThrow(AgentConcurrencyLimitExceededError);
    await c1.end();
  });

  test('A2 after end, second call can start', async () => {
    const ctx = await createOrgUserAgentInstance({ agentLimitUser: 1 });
    const c1 = await createCallRow(ctx);
    const c2 = await createCallRow(ctx);
    await c1.start();
    await c1.end();
    await expect(c2.start()).resolves.toBeUndefined();
    expect(
      await UserConcurrency.count({ where: { userId: ctx.userId } }),
    ).toBe(1);
    await c2.end();
    expect(
      await UserConcurrency.count({ where: { userId: ctx.userId } }),
    ).toBe(0);
  });

  test('A3 organisation.agentLimit=1 across two users', async () => {
    const orgId = randomUUID();
    await Organisation.create({
      id: orgId,
      name: 'Org',
      agentLimit: 1,
    });
    const u1 = randomUUID();
    const u2 = randomUUID();
    for (const u of [u1, u2]) {
      await User.create({
        id: u,
        organisationId: orgId,
        name: `U ${u}`,
        email: `${u}@t.com`,
        emailVerified: true,
        phone: '+1',
        phoneVerified: true,
        picture: 'x',
        role: { admin: true },
      });
    }
    const a1 = await Agent.create({
      name: 'A1',
      description: 'd',
      modelName: 'livekit:ultravox/ultravox-v0.7',
      prompt: 'p',
      options: { tts: { language: 'any', voice: 'Ciara' } },
      functions: {},
      keys: [],
      userId: u1,
      organisationId: orgId,
    });
    const a2 = await Agent.create({
      name: 'A2',
      description: 'd',
      modelName: 'livekit:ultravox/ultravox-v0.7',
      prompt: 'p',
      options: { tts: { language: 'any', voice: 'Ciara' } },
      functions: {},
      keys: [],
      userId: u2,
      organisationId: orgId,
    });
    const i1 = await Instance.create({
      agentId: a1.id,
      type: 'livekit',
      userId: u1,
      organisationId: orgId,
    });
    const i2 = await Instance.create({
      agentId: a2.id,
      type: 'livekit',
      userId: u2,
      organisationId: orgId,
    });
    const call1 = await Call.create({
      id: randomUUID(),
      instanceId: i1.id,
      agentId: a1.id,
      userId: u1,
      organisationId: orgId,
      callerId: '1',
      calledId: '2',
    });
    const call2 = await Call.create({
      id: randomUUID(),
      instanceId: i2.id,
      agentId: a2.id,
      userId: u2,
      organisationId: orgId,
      callerId: '1',
      calledId: '2',
    });
    await call1.start();
    await expect(call2.start()).rejects.toThrow(AgentConcurrencyLimitExceededError);
    await call1.end();
    await expect(call2.start()).resolves.toBeUndefined();
    await call2.end();
  });

  test('A4 instance.agentLimit=1', async () => {
    const ctx = await createOrgUserAgentInstance({ agentLimitInstance: 1 });
    const c1 = await createCallRow(ctx);
    const c2 = await createCallRow(ctx);
    await c1.start();
    await expect(c2.start()).rejects.toThrow(AgentConcurrencyLimitExceededError);
    await c1.end();
  });

  test('A5 null limits allow two concurrent starts', async () => {
    const ctx = await createOrgUserAgentInstance({});
    const c1 = await createCallRow(ctx);
    const c2 = await createCallRow(ctx);
    await c1.start();
    await c2.start();
    expect(
      await InstanceConcurrency.count({ where: { instanceId: ctx.instanceId } }),
    ).toBe(2);
    await c1.end();
    await c2.end();
  });

  test('A6 user.agentLimit=0 disallows start', async () => {
    const ctx = await createOrgUserAgentInstance({ agentLimitUser: 0 });
    const c1 = await createCallRow(ctx);
    await expect(c1.start()).rejects.toThrow(AgentConcurrencyLimitExceededError);
  });

  test('A7 idempotent second start does not add rows', async () => {
    const ctx = await createOrgUserAgentInstance({ agentLimitUser: 2 });
    const c1 = await createCallRow(ctx);
    await c1.start();
    await c1.start();
    expect(
      await UserConcurrency.count({ where: { userId: ctx.userId } }),
    ).toBe(1);
    await c1.end();
  });

  /** No userId / organisationId on call → SQL store skips user/org rows; instance limit still applies. */
  test('A8 missing userId and organisationId enforces instance scope only', async () => {
    const ctx = await createOrgUserAgentInstance({
      agentLimitInstance: 1,
      agentLimitUser: 1,
    });
    const c1 = await Call.create(
      {
        id: randomUUID(),
        instanceId: ctx.instanceId,
        agentId: ctx.agentId,
        userId: null,
        organisationId: null,
        callerId: '+1',
        calledId: '+2',
        platform: 'livekit',
        index: 1,
      },
      { hooks: false },
    );
    const c2 = await Call.create(
      {
        id: randomUUID(),
        instanceId: ctx.instanceId,
        agentId: ctx.agentId,
        userId: null,
        organisationId: null,
        callerId: '+1',
        calledId: '+2',
        platform: 'livekit',
        index: 2,
      },
      { hooks: false },
    );
    await expect(c1.start()).resolves.toBeUndefined();
    await expect(c2.start()).rejects.toThrow(AgentConcurrencyLimitExceededError);
    await c1.end();
  });

  test('B1 agent-db start returns 429 when limit exceeded', async () => {
    const ctx = await createOrgUserAgentInstance({ agentLimitUser: 1 });
    const c1 = await createCallRow(ctx);
    const c2 = await createCallRow(ctx);
    await c1.start();

    const startModule = await import('../api/paths/agent-db/call/{callId}/start.js');
    const handler = startModule.default(mockLogger, {}, {}).POST;

    const req = {
      params: { callId: c2.id },
      body: { userId: ctx.userId, organisationId: ctx.orgId },
      log: mockLogger,
    };
    const res = {
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
    };
    await handler(req, res);
    expect(res._status).toBe(429);
    expect(res._body.code).toBe('AGENT_CONCURRENCY_LIMIT_EXCEEDED');
    await c1.end();
  });

  test('B2 agent-db start returns 200 and creates concurrency rows', async () => {
    const ctx = await createOrgUserAgentInstance({});
    const c1 = await createCallRow(ctx);

    const startModule = await import('../api/paths/agent-db/call/{callId}/start.js');
    const handler = startModule.default(mockLogger, {}, {}).POST;

    const req = {
      params: { callId: c1.id },
      body: { userId: ctx.userId, organisationId: ctx.orgId },
      log: mockLogger,
    };
    const res = {
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
    };
    await handler(req, res);
    expect(res._status === null || res._status === 200).toBe(true);
    expect(res._body).toMatchObject({ callId: c1.id });
    expect(
      await InstanceConcurrency.count({ where: { instanceId: ctx.instanceId } }),
    ).toBe(1);
    await c1.end();
  });

  test('B3 agent-db end clears concurrency rows', async () => {
    const ctx = await createOrgUserAgentInstance({});
    const c1 = await createCallRow(ctx);
    await c1.start();
    expect(
      await InstanceConcurrency.count({ where: { instanceId: ctx.instanceId } }),
    ).toBe(1);

    const endModule = await import('../api/paths/agent-db/call/{callId}/end.js');
    const endHandler = endModule.default(mockLogger, {}, {}).POST;

    const req = {
      params: { callId: c1.id },
      body: {
        userId: ctx.userId,
        organisationId: ctx.orgId,
        reason: 'test',
      },
      log: mockLogger,
    };
    const res = {
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
    };
    await endHandler(req, res);
    expect(res._status === null || res._status === 200).toBe(true);
    expect(res._body).toMatchObject({ callId: c1.id });
    expect(
      await InstanceConcurrency.count({ where: { instanceId: ctx.instanceId } }),
    ).toBe(0);
  });
});
