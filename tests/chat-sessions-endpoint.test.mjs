import { setupRealDatabase, teardownRealDatabase, Organisation, User } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

// Persisted chat sessions (schema v55) back the builder's session history:
// text-chat writes a row per session (transcript, set linkage, mode) and the
// /chat-sessions endpoints list/fetch them org-scoped with LLM token usage
// joined from usage_records on the shared session id.
describe('Chat session persistence + history endpoints', () => {
  let ChatSession;
  let recordLlmTokens;
  let listSessions;
  let getSession;

  let testOrgId;
  let testUserId;

  const mockLogger = {
    info: () => {}, error: () => {}, warn: () => {}, debug: () => {},
    child: () => mockLogger,
  };

  const createMockRequest = (overrides = {}) => ({
    body: {}, params: {}, query: {}, headers: {}, log: mockLogger, ...overrides,
  });

  const createMockResponse = (locals = {}) => ({
    _status: null,
    _body: null,
    locals,
    status(code) { this._status = code; return this; },
    send(data) { this._body = data; return this; },
    json(data) { this._body = data; return this; },
  });

  const asUser = () => ({ user: { id: testUserId, role: 'owner', organisationId: testOrgId } });

  beforeAll(async () => {
    await setupRealDatabase();
    ({ ChatSession } = await import('../lib/database.js'));
    ({ recordLlmTokens } = await import('../lib/usage.js'));
    listSessions = (await import('../api/paths/chat-sessions.js')).default(mockLogger).GET;
    getSession = (await import('../api/paths/chat-sessions/{sessionId}.js')).default(mockLogger).GET;
    await ChatSession.sync({ alter: true });
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    testOrgId = randomUUID();
    testUserId = randomUUID();
    await Organisation.create({ id: testOrgId, name: 'Test Org (chat sessions)' });
    await User.create({
      id: testUserId, organisationId: testOrgId,
      name: 'Test User', email: 'chat-sessions@example.com',
    });
  }, 30000);

  afterEach(async () => {
    try {
      await ChatSession.destroy({ where: { organisationId: testOrgId } });
      await User.destroy({ where: { id: testUserId } });
      await Organisation.destroy({ where: { id: testOrgId } });
    } catch { /* best-effort */ }
  });

  const makeSessionRow = async (over = {}) => {
    const id = randomUUID();
    await ChatSession.create({
      id,
      agentId: 'builtin:set-builder',
      organisationId: testOrgId,
      userId: testUserId,
      setId: over.setId ?? null,
      mode: over.mode ?? 'new',
      title: over.title ?? null,
      modelName: 'text:anthropic/claude-sonnet-5',
      startedAt: over.startedAt ?? new Date(),
      turns: over.turns ?? 3,
      transcript: over.transcript ?? [{ role: 'user', text: 'build me a team', at: new Date().toISOString() }],
      ...over,
    });
    return id;
  };

  test('list is org-scoped, newest first, filters by setId and joins usage', async () => {
    const setId = randomUUID();
    const s1 = await makeSessionRow({ setId, startedAt: new Date(Date.now() - 60_000), mode: 'edit', title: 'Team A' });
    const s2 = await makeSessionRow({ setId, startedAt: new Date(), mode: 'troubleshoot', title: 'Team A' });
    await makeSessionRow({}); // different (no) set — filtered out
    // Another org's session must never appear.
    const otherOrg = randomUUID();
    await Organisation.create({ id: otherOrg, name: 'Other Org' });
    await ChatSession.create({
      id: randomUUID(), agentId: 'builtin:set-builder', organisationId: otherOrg,
      setId, startedAt: new Date(), transcript: [],
    });

    await recordLlmTokens({
      sessionId: s2, organisationId: testOrgId, userId: testUserId,
      provider: 'anthropic', model: 'claude-sonnet-5',
      inputTokens: 100, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 400,
      log: mockLogger,
    });

    const res = createMockResponse(asUser());
    await listSessions(createMockRequest({ query: { setId } }), res);
    expect(res._body.sessions).toHaveLength(2);
    expect(res._body.sessions.map((s) => s.id)).toEqual([s2, s1]); // newest first
    expect(res._body.sessions[0].usage).toMatchObject({
      inputTokens: 100, outputTokens: 200, cacheReadTokens: 3000, cacheWriteTokens: 400,
    });
    expect(res._body.sessions[1].usage).toBeNull();
    // List responses stay light: no transcript field.
    expect(res._body.sessions[0]).not.toHaveProperty('transcript');
  });

  test('detail returns the transcript and 404s outside the caller scope', async () => {
    const transcript = [
      { role: 'user', text: 'hello', at: new Date().toISOString() },
      { role: 'agent', text: 'hi — what shall we build?', at: new Date().toISOString() },
    ];
    const id = await makeSessionRow({ transcript, title: 'Team B' });

    const res = createMockResponse(asUser());
    await getSession(createMockRequest({ params: { sessionId: id } }), res);
    expect(res._body.transcript).toEqual(transcript);
    expect(res._body.usage).toMatchObject({ inputTokens: 0, outputTokens: 0 });

    const stranger = createMockResponse({ user: { id: randomUUID(), role: 'owner', organisationId: randomUUID() } });
    await getSession(createMockRequest({ params: { sessionId: id } }), stranger);
    expect(stranger._status).toBe(404);
  });
});
