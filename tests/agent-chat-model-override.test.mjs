// POST /agents/{agentId}/chat `model` override: a per-SESSION model choice
// (e.g. a user's builder-model preference) validated against the text
// catalogue and the caller's model allow-list, then applied in-memory to the
// resolved agent so the LLM build and the persisted session both reflect it.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

// Provider keys must exist BEFORE the endpoint (and its driver imports)
// load: the catalogue filters on canLoad.ok, and anthropic.js reads its key
// at module scope.
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.GOOGLE_API_KEY ||= 'test-key';
process.env.KIMI_KEY ||= 'test-key';
process.env.OPENROUTER_KEY ||= 'test-key';

import { randomUUID } from 'node:crypto';

const chatModule = (await import('../api/paths/agents/{agentId}/chat.js')).default;
const { getChatSession } = await import('../lib/text-chat.js');
const { Agent, Organisation } = await import('../lib/database.js');

const mockLogger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return this; },
};

const agentChat = chatModule(mockLogger).POST;

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
  status(code) { this._status = code; return this; },
  send(data) { this._body = data; return this; },
  json(data) { this._body = data; return this; },
});

const asUser = (extra = {}) => ({
  user: { id: 'user-mo-1', role: 'owner', organisationId: 'org-mo-1', ...extra },
});

beforeAll(async () => {
  await setupRealDatabase();
});

afterAll(async () => {
  await teardownRealDatabase();
});

describe('POST /agents/{agentId}/chat model override', () => {
  test('unknown model is rejected with 400', async () => {
    const res = createMockResponse(asUser());
    await agentChat(createMockRequest({
      params: { agentId: 'builtin:set-builder' },
      body: { model: 'text:openai/not-a-model' },
    }), res);
    expect(res._status).toBe(400);
    expect(res._body.message).toMatch(/Unknown text model/);
  });

  test('a model outside the caller allow-list is rejected with 403', async () => {
    const res = createMockResponse(asUser({
      _allowedModels: ['builtin:set-builder', 'text:anthropic/claude-sonnet-5'],
    }));
    await agentChat(createMockRequest({
      params: { agentId: 'builtin:set-builder' },
      body: { model: 'text:openai/gpt-5.6-terra' },
    }), res);
    expect(res._status).toBe(403);
    expect(res._body.message).toMatch(/not permitted/);
  });

  test('an allowed catalogue model overrides the session model', async () => {
    const res = createMockResponse(asUser());
    await agentChat(createMockRequest({
      params: { agentId: 'builtin:set-builder' },
      body: { model: 'text:kimi/kimi-k2.6' },
    }), res);
    expect(res._status).toBeNull(); // 200 via plain send
    expect(res._body.id).toBeDefined();
    const session = getChatSession(res._body.id);
    expect(session.agent.modelName).toBe('text:kimi/kimi-k2.6');
    session.teardown();
  });

  test('no model key leaves the builder default untouched', async () => {
    const { SET_BUILDER_MODEL } = await import('../lib/set-builder-agent.js');
    const res = createMockResponse(asUser());
    await agentChat(createMockRequest({
      params: { agentId: 'builtin:set-builder' },
      body: {},
    }), res);
    expect(res._body.id).toBeDefined();
    const session = getChatSession(res._body.id);
    expect(session.agent.modelName).toBe(SET_BUILDER_MODEL);
    session.teardown();
  });

  test('a stored (DB-row) agent takes the override in-memory and the ROW is never saved', async () => {
    const orgId = randomUUID();
    await Organisation.create({ id: orgId, name: 'model-override-org' });
    const row = await Agent.create({
      name: 'stored text agent',
      type: 'text',
      modelName: 'text:anthropic/claude-sonnet-5',
      prompt: 'You are a test agent.',
      organisationId: orgId,
    });
    try {
      const res = createMockResponse(asUser({ organisationId: orgId }));
      await agentChat(createMockRequest({
        params: { agentId: row.id },
        body: { model: 'text:kimi/kimi-k2.6' },
      }), res);
      expect(res._body.id).toBeDefined();
      const session = getChatSession(res._body.id);
      // The session runs the override…
      expect(session.agent.modelName).toBe('text:kimi/kimi-k2.6');
      session.teardown();
      // …but the stored definition is untouched (the mutation is in-memory only).
      const reloaded = await Agent.findByPk(row.id);
      expect(reloaded.modelName).toBe('text:anthropic/claude-sonnet-5');
    } finally {
      await Agent.destroy({ where: { id: row.id } });
      await Organisation.destroy({ where: { id: orgId } });
    }
  });
});
