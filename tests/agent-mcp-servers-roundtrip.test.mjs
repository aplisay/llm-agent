import { setupRealDatabase, teardownRealDatabase, Organisation, User } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

describe('Agent mcpServers API round-trip', () => {
  let createAgent;
  let getAgent;
  let updateAgent;

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
    json(data) {
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
    updateAgent = agentByIdModule.default(mockLogger).PUT;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    testOrgId = randomUUID();
    testUserId = randomUUID();
    createdAgentId = null;

    await Organisation.create({ id: testOrgId, name: 'Test Org (mcpServers)' });
    await User.create({
      id: testUserId,
      organisationId: testOrgId,
      name: 'Test User',
      email: 'test-mcp@example.com',
    });
  }, 30000);

  afterEach(async () => {
    try {
      if (testUserId) await User.destroy({ where: { id: testUserId } });
      if (testOrgId) await Organisation.destroy({ where: { id: testOrgId } });
    } catch {}
  });

  test('Create agent with mcpServers, fetch and update it back', async () => {
    const mcpServers = [
      {
        name: 'weather_mcp',
        url: 'https://mcp.example.com/mcp',
        transport: 'streamable_http',
        headers: { Authorization: 'Bearer sk-test' },
      },
    ];

    const createReq = createMockRequest({
      body: {
        name: 'MCP test agent',
        // mcpServers is stored verbatim regardless of model; use a model the
        // other suites rely on so this test has no extra env dependency.
        modelName: 'livekit:ultravox/ultravox-v0.7',
        prompt: 'You are a helpful assistant.',
        mcpServers,
      },
    });
    const createRes = createMockResponse({
      user: { id: testUserId, role: 'owner', organisationId: testOrgId },
    });

    await createAgent(createReq, createRes);
    expect(createRes._body).toHaveProperty('id');
    createdAgentId = createRes._body.id;
    expect(createRes._body.mcpServers).toMatchObject(mcpServers);

    // Fetch it back
    const getReq = createMockRequest({ params: { agentId: createdAgentId } });
    const getRes = createMockResponse({
      user: { id: testUserId, role: 'owner', organisationId: testOrgId },
    });
    await getAgent(getReq, getRes);
    expect(getRes._status === 200 || getRes._status === null).toBe(true);
    expect(getRes._body).toHaveProperty('mcpServers');
    expect(getRes._body.mcpServers).toMatchObject(mcpServers);

    // Update the mcpServers array
    const updated = [
      { name: 'dir_mcp', url: 'https://dir.example.com/mcp', transport: 'sse', headers: {} },
    ];
    const putReq = createMockRequest({
      params: { agentId: createdAgentId },
      body: { mcpServers: updated },
    });
    const putRes = createMockResponse({
      user: { id: testUserId, role: 'owner', organisationId: testOrgId },
    });
    await updateAgent(putReq, putRes);
    expect(putRes._body).toHaveProperty('mcpServers');
    expect(putRes._body.mcpServers).toMatchObject(updated);
  });
});
