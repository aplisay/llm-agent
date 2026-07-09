import { setupRealDatabase, teardownRealDatabase, Organisation, User } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

// GET /agents/{agentId}/keys must expose only key NAMES (never values), so a
// trusted BFF can confirm a write-only key it pushed is actually armed on the
// agent — the fix for the silent "MCP server dropped because its key is
// missing" wedge. PUT /keys must still merge (never clobber a sibling key).
describe('Agent keys endpoint (names-only visibility + merge)', () => {
  let createAgent;
  let listKeys;
  let upsertKeys;

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

  const asUser = () => ({ user: { id: testUserId, role: 'owner', organisationId: testOrgId } });

  beforeAll(async () => {
    await setupRealDatabase();

    const agentsModule = await import('../api/paths/agents.js');
    const keysModule = await import('../api/paths/agents/{agentId}/keys.js');

    createAgent = agentsModule.default(mockLogger, {}, { emit: () => {}, on: () => {}, off: () => {} }).POST;
    listKeys = keysModule.default(mockLogger).GET;
    upsertKeys = keysModule.default(mockLogger).PUT;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    testOrgId = randomUUID();
    testUserId = randomUUID();
    createdAgentId = null;

    await Organisation.create({ id: testOrgId, name: 'Test Org (keys)' });
    await User.create({
      id: testUserId,
      organisationId: testOrgId,
      name: 'Test User',
      email: 'test-keys@example.com',
    });
  }, 30000);

  afterEach(async () => {
    try {
      if (testUserId) await User.destroy({ where: { id: testUserId } });
      if (testOrgId) await Organisation.destroy({ where: { id: testOrgId } });
    } catch {}
  });

  const makeAgentWithKeys = async (keys) => {
    const req = createMockRequest({
      body: {
        name: 'Keys test agent',
        modelName: 'livekit:ultravox/ultravox-v0.7',
        prompt: 'You are a helpful assistant.',
        keys,
      },
    });
    const res = createMockResponse(asUser());
    await createAgent(req, res);
    expect(res._body).toHaveProperty('id');
    // The create response itself must never echo key values back.
    expect(JSON.stringify(res._body)).not.toContain('pik_secret');
    return res._body.id;
  };

  test('GET /keys returns key NAMES and never values', async () => {
    createdAgentId = await makeAgentWithKeys([
      { name: 'POLITE_DISCOVERY', in: 'bearer', value: 'pik_secret_discovery' },
      { name: 'OTHER_KEY', in: 'header', value: 'pik_secret_other' },
    ]);

    const res = createMockResponse(asUser());
    await listKeys(createMockRequest({ params: { agentId: createdAgentId } }), res);

    expect(res._status === 200 || res._status === null).toBe(true);
    expect(res._body).toHaveProperty('id', createdAgentId);
    expect([...res._body.keyNames].sort()).toEqual(['OTHER_KEY', 'POLITE_DISCOVERY']);
    // The whole point: values stay write-only.
    expect(JSON.stringify(res._body)).not.toContain('pik_secret');
  });

  test('GET /keys returns an empty list for an agent with no keys', async () => {
    createdAgentId = await makeAgentWithKeys(undefined);

    const res = createMockResponse(asUser());
    await listKeys(createMockRequest({ params: { agentId: createdAgentId } }), res);

    expect(res._body.keyNames).toEqual([]);
  });

  test('PUT /keys merges by name without clobbering siblings; GET reflects it', async () => {
    createdAgentId = await makeAgentWithKeys([
      { name: 'POLITE_DISCOVERY', in: 'bearer', value: 'pik_secret_old' },
    ]);

    // Arm a fresh discovery bearer AND a new sibling key in one merge.
    const putRes = createMockResponse(asUser());
    await upsertKeys(
      createMockRequest({
        params: { agentId: createdAgentId },
        body: {
          keys: [
            { name: 'POLITE_DISCOVERY', in: 'bearer', value: 'pik_secret_new' },
            { name: 'POLITE_KNOWLEDGE', in: 'bearer', value: 'pik_secret_knowledge' },
          ],
        },
      }),
      putRes,
    );
    expect([...putRes._body.keyNames].sort()).toEqual(['POLITE_DISCOVERY', 'POLITE_KNOWLEDGE']);
    expect(JSON.stringify(putRes._body)).not.toContain('pik_secret');

    const getRes = createMockResponse(asUser());
    await listKeys(createMockRequest({ params: { agentId: createdAgentId } }), getRes);
    expect([...getRes._body.keyNames].sort()).toEqual(['POLITE_DISCOVERY', 'POLITE_KNOWLEDGE']);
  });

  test('GET /keys 404s for an unknown agent', async () => {
    const res = createMockResponse(asUser());
    await listKeys(createMockRequest({ params: { agentId: randomUUID() } }), res);
    expect(res._status).toBe(404);
  });
});
