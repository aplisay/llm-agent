import { setupRealDatabase, teardownRealDatabase, Organisation, User } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

// Workers load a fallback.agent or transfer_agent target through this route.
// It is unscoped, so expectedOrganisationId is the only tenancy guard.
describe('GET /agent-db/agent tenancy guard', () => {
  let createAgent;
  let internalGet;

  let orgId;
  let userId;
  let otherOrgId;
  let otherUserId;

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

  // The principal the auth middleware builds for x-shared-token.
  const asWorker = () => ({ user: { id: 'system', user_id: 'system', isSystem: true } });

  beforeAll(async () => {
    await setupRealDatabase();

    const agentsModule = await import('../api/paths/agents.js');
    const internalModule = await import('../api/paths/agent-db/agent.js');

    createAgent = agentsModule.default(mockLogger, {}, { emit: () => {}, on: () => {}, off: () => {} }).POST;
    internalGet = internalModule.default(mockLogger).GET;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    orgId = randomUUID();
    userId = randomUUID();
    otherOrgId = randomUUID();
    otherUserId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Tenancy org' });
    await Organisation.create({ id: otherOrgId, name: 'Tenancy other org' });
    await User.create({ id: userId, organisationId: orgId, name: 'Owner', email: 'owner-tenancy@example.com' });
    await User.create({ id: otherUserId, organisationId: otherOrgId, name: 'Other', email: 'other-tenancy@example.com' });
  }, 30000);

  afterEach(async () => {
    try {
      await User.destroy({ where: { id: [userId, otherUserId] } });
      await Organisation.destroy({ where: { id: [orgId, otherOrgId] } });
    } catch {}
  });

  const makeAgent = async () => {
    const res = createMockResponse({ user: { id: userId, role: 'owner', organisationId: orgId } });
    await createAgent(createMockRequest({
      body: {
        name: 'Fallback target',
        modelName: 'livekit:ultravox/ultravox-v0.7',
        prompt: 'You are the fallback agent.',
        keys: [{ name: 'CRM_TOKEN', in: 'bearer', value: 'crm_secret_value' }],
      },
    }), res);
    expect(res._body).toHaveProperty('id');
    return res._body.id;
  };

  const fetchInternal = async (query) => {
    const res = createMockResponse(asWorker());
    await internalGet(createMockRequest({ query }), res);
    return res;
  };

  test('returns the full row, with usable keys, to a worker acting for the same organisation', async () => {
    const agentId = await makeAgent();

    const res = await fetchInternal({ agentId, expectedOrganisationId: orgId });

    expect(res._status).toBeNull();
    expect(res._body).toMatchObject({ id: agentId, organisationId: orgId, prompt: 'You are the fallback agent.' });
    expect(res._body.keys).toEqual([expect.objectContaining({ name: 'CRM_TOKEN', value: 'crm_secret_value' })]);
  });

  test('refuses a worker acting for another organisation', async () => {
    const agentId = await makeAgent();

    const res = await fetchInternal({ agentId, expectedOrganisationId: otherOrgId });

    expect(res._status).toBe(404);
    expect(JSON.stringify(res._body)).not.toContain('crm_secret_value');
  });
});
