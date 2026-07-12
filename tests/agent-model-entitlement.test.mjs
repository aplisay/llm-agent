// R1 model-entitlement gates on the RUN endpoints (chat / invoke / internal
// subagent): reading an agent was already gated on its model (agentGet), but
// running one was not — a tightened allow-list could keep executing a
// now-disallowed model on the org's bill. These tests pin the new gates.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';
import { randomUUID } from 'node:crypto';

process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.GROQ_API_KEY ||= 'test-key';
process.env.GOOGLE_API_KEY ||= 'test-key';
process.env.KIMI_KEY ||= 'test-key';
process.env.OPENROUTER_KEY ||= 'test-key';

const chatModule = (await import('../api/paths/agents/{agentId}/chat.js')).default;
const invokeModule = (await import('../api/paths/agents/{agentId}/invoke.js')).default;
const subagentModule = (await import('../api/paths/agent-db/subagent.js')).default;
const { getChatSession } = await import('../lib/text-chat.js');
const { runSubagentById, SubagentError } = await import('../lib/subagent.js');
const { Agent, Organisation } = await import('../lib/database.js');

const mockLogger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return this; },
};

const agentChat = chatModule(mockLogger).POST;
const agentInvoke = invokeModule(mockLogger).POST;
const subagentInvoke = subagentModule(mockLogger).POST;

const createMockRequest = (overrides = {}) => ({
  body: {}, params: {}, query: {}, headers: {}, log: mockLogger, ...overrides,
});
const createMockResponse = (locals = {}) => ({
  _status: null, _body: null, locals,
  status(code) { this._status = code; return this; },
  send(data) { this._body = data; return this; },
  json(data) { this._body = data; return this; },
});

let orgId; let agentRow;

beforeAll(async () => {
  await setupRealDatabase();
  orgId = randomUUID();
  await Organisation.create({ id: orgId, name: 'entitlement-org' });
  agentRow = await Agent.create({
    name: 'opus text agent',
    type: 'text',
    modelName: 'text:anthropic/claude-opus-4-8',
    prompt: 'You are a test agent.',
    organisationId: orgId,
  });
});

let builderRow;

afterAll(async () => {
  await Agent.destroy({ where: { id: agentRow.id } });
  if (builderRow) await Agent.destroy({ where: { id: builderRow.id } });
  await Organisation.destroy({ where: { id: orgId } });
  await teardownRealDatabase();
});

const MARKER = '[polite:agent-builder]';

// A user in the agent's org whose personal allow-list excludes its model.
const restrictedUser = () => ({
  user: {
    id: 'user-ent-1', role: 'owner', organisationId: orgId,
    _allowedModels: ['text:kimi', 'builtin:set-builder'],
  },
});
const unrestrictedUser = () => ({
  user: { id: 'user-ent-1', role: 'owner', organisationId: orgId, _allowedModels: null },
});

describe('chat endpoint model entitlement', () => {
  test('a stored agent on a disallowed model is refused with 403 model_not_permitted', async () => {
    const res = createMockResponse(restrictedUser());
    await agentChat(createMockRequest({ params: { agentId: agentRow.id }, body: {} }), res);
    expect(res._status).toBe(403);
    expect(res._body.message).toBe('model_not_permitted');
  });

  test('a per-session override cannot rescue a disallowed base agent', async () => {
    const res = createMockResponse(restrictedUser());
    await agentChat(createMockRequest({
      params: { agentId: agentRow.id },
      body: { model: 'text:kimi/kimi-k2.6' }, // allowed model, disallowed agent
    }), res);
    expect(res._status).toBe(403);
    expect(res._body.message).toBe('model_not_permitted');
  });

  test('an unrestricted user still chats the same agent', async () => {
    const res = createMockResponse(unrestrictedUser());
    await agentChat(createMockRequest({ params: { agentId: agentRow.id }, body: {} }), res);
    expect(res._body.id).toBeDefined();
    getChatSession(res._body.id).teardown();
  });

  test('builtins stay gated by their builtin: id, not their model', async () => {
    // The restricted list includes builtin:set-builder — the builtin runs even
    // though its DEFAULT model (text:openai/...) is outside the user's list.
    const res = createMockResponse(restrictedUser());
    await agentChat(createMockRequest({ params: { agentId: 'builtin:set-builder' }, body: {} }), res);
    expect(res._body.id).toBeDefined();
    getChatSession(res._body.id).teardown();
  });

  test('the org-pushed builder row is NOT exempt: its description marker is tenant-forgeable, so it is gated like any stored agent', async () => {
    // A pushed org builder (marker in description) on a disallowed model is
    // gated the same as any stored agent — trusting the tenant-settable marker
    // would be a bypass. A restricted org reaches the builder via the BUILTIN
    // (polite-ai retries against builtin:set-builder on this 403), not by
    // exempting the org row.
    builderRow = await Agent.create({
      name: 'Polite Agent Builder',
      description: `Org builder ${MARKER}`,
      type: 'text',
      modelName: 'text:openai/gpt-5.6-terra', // outside the restricted list
      prompt: 'You are the builder.',
      organisationId: orgId,
    });
    const res = createMockResponse(restrictedUser());
    await agentChat(createMockRequest({ params: { agentId: builderRow.id }, body: {} }), res);
    expect(res._status).toBe(403);
    expect(res._body.message).toBe('model_not_permitted');
  });
});

describe('invoke endpoint model entitlement', () => {
  test('a stored agent on a disallowed model is refused with 403 before any LLM call', async () => {
    const res = createMockResponse(restrictedUser());
    await agentInvoke(createMockRequest({ params: { agentId: agentRow.id }, body: { input: {} } }), res);
    expect(res._status).toBe(403);
    expect(res._body.message).toBe('model_not_permitted');
  });
});

describe('internal subagent endpoint org-level entitlement', () => {
  test('an org allow-list excluding the target model refuses with 403', async () => {
    await Organisation.update({ allowedModels: ['text:kimi'] }, { where: { id: orgId } });
    try {
      const res = createMockResponse({});
      await subagentInvoke(createMockRequest({
        body: { agentId: agentRow.id, organisationId: orgId, input: {} },
      }), res);
      expect(res._status).toBe(403);
      expect(res._body.error).toMatch(/model_not_permitted/);
    } finally {
      await Organisation.update({ allowedModels: null }, { where: { id: orgId } });
    }
  });

  test('an org with NO allow-list (unrestricted) is not blocked by the gate', async () => {
    // Reaches past the gate into the real runSubagentById — with a test key
    // the LLM call fails, which proves the 403 short-circuit did NOT fire.
    const res = createMockResponse({});
    await subagentInvoke(createMockRequest({
      body: { agentId: agentRow.id, organisationId: orgId, input: {} },
    }), res);
    expect(res._status === 403 ? res._body.error : '').not.toMatch(/model_not_permitted/);
  });
});

describe('runSubagentById gates EVERY delegation path (in-process + nested)', () => {
  // The gate lives in runSubagentById, not just the REST endpoint, so an
  // in-process invokeSubagent / nested subagent→subagent chain is covered too.
  test('a disallowed model throws SubagentError(403) when called directly', async () => {
    await Organisation.update({ allowedModels: ['text:kimi'] }, { where: { id: orgId } });
    try {
      await expect(
        runSubagentById({ agentId: agentRow.id, input: {}, organisationId: orgId, logger: mockLogger }),
      ).rejects.toMatchObject({ status: 403, message: expect.stringMatching(/model_not_permitted/) });
    } finally {
      await Organisation.update({ allowedModels: null }, { where: { id: orgId } });
    }
    expect(SubagentError).toBeDefined();
  });
});
