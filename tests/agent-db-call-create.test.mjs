/**
 * POST /api/agent-db/call with a caller-chosen id: a new id creates that call,
 * a live one is updated in place, and an ended one is never restarted.
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
} from './setup/database-test-wrapper.js';

describe('agent-db call create', () => {
  const mockLogger = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    child: () => mockLogger,
  };
  let callCreate;
  let ctx;

  beforeAll(async () => {
    await setupRealDatabase();
    const callModule = await import('../api/paths/agent-db/call.js');
    callCreate = callModule.default(mockLogger, {}, {}).POST;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    const organisationId = randomUUID();
    const userId = randomUUID();
    await Organisation.create({ id: organisationId, name: 'Call create test org' });
    await User.create({
      id: userId,
      organisationId,
      name: 'Test User',
      email: 'call-create@test.example.com',
      emailVerified: true,
      phone: '+10000000000',
      phoneVerified: true,
      picture: 'https://example.com/p.png',
      role: 'owner',
    });
    const agent = await Agent.create({
      name: 'Call create agent',
      description: 't',
      modelName: 'livekit:ultravox/ultravox-v0.7',
      prompt: 'You are a test agent.',
      // No voice: validating one fetches the Ultravox voice list.
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
    await Call.destroy({ where: {} }).catch(() => {});
    await Instance.destroy({ where: {} }).catch(() => {});
    await Agent.destroy({ where: {} }).catch(() => {});
    await User.destroy({ where: {} }).catch(() => {});
    await Organisation.destroy({ where: {} }).catch(() => {});
  });

  async function post(body) {
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
    await callCreate({ body: { ...ctx, platform: 'livekit', ...body } }, res);
    return res;
  }

  test('a new id creates the call with that id', async () => {
    const id = randomUUID();
    const res = await post({ id, platformCallId: 'room-1' });
    expect(res._status).toBe(201);
    expect(res._body.id).toBe(id);
    expect((await Call.findByPk(id)).platformCallId).toBe('room-1');
  });

  test('the id of a live call updates it in place', async () => {
    const id = randomUUID();
    await post({ id, platformCallId: 'room-1' });
    const res = await post({ id, platformCallId: 'room-2' });
    expect(res._status).toBe(200);
    expect(res._body.id).toBe(id);
    expect((await Call.findByPk(id)).platformCallId).toBe('room-2');
    expect(await Call.count()).toBe(1);
  });

  test('the id of an ended call creates a new call and leaves the ended one alone', async () => {
    const id = randomUUID();
    await post({ id, platformCallId: 'room-1' });
    const ended = await Call.findByPk(id);
    await ended.start();
    await ended.end('test');
    const { endedAt, startedAt } = await Call.findByPk(id);

    const res = await post({ id, platformCallId: 'room-1-again' });
    expect(res._status).toBe(201);
    expect(res._body.id).not.toBe(id);
    expect((await Call.findByPk(res._body.id)).platformCallId).toBe('room-1-again');

    const after = await Call.findByPk(id);
    expect(after.platformCallId).toBe('room-1');
    expect(after.startedAt).toEqual(startedAt);
    expect(after.endedAt).toEqual(endedAt);
    expect(after.live).toBe(false);
  });
});
