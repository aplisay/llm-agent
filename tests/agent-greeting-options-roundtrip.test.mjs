import { setupRealDatabase, teardownRealDatabase, Organisation, User } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

describe('Agent options.greeting API round-trip', () => {
  let createAgent;
  let getAgent;

  let testOrgId;
  let testUserId;
  let createdAgentId;

  const mockLogger = {
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
    child: () => mockLogger,
  };

  const createMockRequest = (overrides = {}) => ({
    body: {},
    params: {},
    query: {},
    headers: {},
    log: mockLogger,
    ...overrides,
  });

  const createMockResponse = (locals = {}) => ({
    _status: null,
    _body: null,
    locals,
    status(code) {
      this._status = code;
      return this;
    },
    send(data) {
      this._body = data;
      return this;
    },
  });

  beforeAll(async () => {
    await setupRealDatabase();

    const agentsModule = await import('../api/paths/agents.js');
    const agentByIdModule = await import('../api/paths/agents/{agentId}.js');

    const mockVoices = {};
    const mockWsServer = { emit: () => {}, on: () => {}, off: () => {} };

    createAgent = agentsModule.default(mockLogger, mockVoices, mockWsServer).POST;
    getAgent = agentByIdModule.default(mockLogger).GET;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    testOrgId = randomUUID();
    testUserId = randomUUID();
    createdAgentId = null;

    await Organisation.create({
      id: testOrgId,
      name: 'Test Org (greeting options)',
    });
    await User.create({
      id: testUserId,
      organisationId: testOrgId,
      name: 'Test User',
      email: 'test-greeting@example.com',
    });
  });

  afterEach(async () => {
    // The Agent row is created through the handler; cleaning org/user is enough due to FK cascade in test schema,
    // but keep this best-effort and tolerant.
    try {
      if (testUserId) {
        await User.destroy({ where: { id: testUserId } });
      }
      if (testOrgId) {
        await Organisation.destroy({ where: { id: testOrgId } });
      }
    } catch {}
  });

  test('Create agent with greeting options and fetch it back', async () => {
    const greeting = {
      text: 'Hello, how can I help you today?',
    };

    const createReq = createMockRequest({
      body: {
        name: 'Greeting test agent',
        modelName: 'livekit:openai/gpt-realtime',
        prompt: 'You are a helpful assistant.',
        options: { greeting },
      },
    });
    const createRes = createMockResponse({
      user: { id: testUserId, organisationId: testOrgId },
    });

    await createAgent(createReq, createRes);
    expect(createRes._body).toHaveProperty('id');
    createdAgentId = createRes._body.id;

    const getReq = createMockRequest({
      params: { agentId: createdAgentId },
    });
    const getRes = createMockResponse({
      user: { id: testUserId, organisationId: testOrgId },
    });

    await getAgent(getReq, getRes);
    expect(getRes._status === 200 || getRes._status === null).toBe(true);
    expect(getRes._body).toHaveProperty('options');
    expect(getRes._body.options).toHaveProperty('greeting');
    expect(getRes._body.options.greeting).toMatchObject(greeting);
  });
});

