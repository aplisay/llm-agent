import { setupRealDatabase, teardownRealDatabase, Organisation, User, Agent, Instance } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * Organisation BYOK provider keys (docs/byok.md):
 *  - PUT /api/organisations/{id}/provider-keys/{provider} → upsert, encrypted at
 *    rest, hint = last 4 chars, fail-closed writes.
 *  - GET /api/organisations/{id}/provider-keys → masked listing + registry
 *    catalogue; values NEVER returned.
 *  - DELETE → 204 / 404.
 *  - RBAC organisation:providerKeys + targetInScope (own org for owner, any org
 *    for superAdmin, out-of-scope is 404).
 *  - agent-db distribution: instance/agent responses carry decrypted
 *    organisationKeys filtered to providersForAgent(agent).
 */
describe('Organisation BYOK provider keys', () => {
  let listKeys;
  let putKey;
  let deleteKey;
  let instanceGet;
  let agentGet;
  let OrganisationKey;
  let providersForAgent;
  let resolveOrganisationKeys;

  let orgId;

  const mockLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, child: () => mockLogger };
  const req = (data = {}) => ({ body: data.body || {}, params: data.params || {}, query: data.query || {}, headers: {}, log: mockLogger, ...data });
  const res = () => ({
    locals: { user: null },
    _status: null,
    _body: null,
    status(c) { this._status = c; return this; },
    send(b) { this._body = b; this._status = this._status || 200; return this; },
    json(b) { this._body = b; this._status = this._status || 200; return this; },
  });

  const superUser = () => ({ role: 'superAdmin' });
  const ownerUser = (org = orgId) => ({ role: 'owner', organisationId: org });
  const memberUser = () => ({ role: 'member', organisationId: orgId });

  beforeAll(async () => {
    await setupRealDatabase();
    // Same already-initialised module instance the wrapper imported; the
    // wrapper does not (yet) re-export OrganisationKey.
    ({ OrganisationKey } = await import('../lib/database.js'));
    ({ providersForAgent, resolveOrganisationKeys } = await import('../lib/org-keys.js'));
    listKeys = (await import('../api/paths/organisations/{organisationId}/provider-keys.js')).default(mockLogger).GET;
    const itemModule = (await import('../api/paths/organisations/{organisationId}/provider-keys/{provider}.js')).default(mockLogger);
    putKey = itemModule.PUT;
    deleteKey = itemModule.DELETE;
    instanceGet = (await import('../api/paths/agent-db/instance.js')).default(mockLogger).GET;
    agentGet = (await import('../api/paths/agent-db/agent.js')).default(mockLogger).GET;
  }, 30000);

  afterAll(async () => { await teardownRealDatabase(); }, 60000);

  beforeEach(async () => {
    orgId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Provider Keys Test Org' });
  });

  afterEach(async () => {
    await OrganisationKey.destroy({ where: { organisationId: orgId } }).catch(() => {});
    await Organisation.destroy({ where: { id: orgId } });
  });

  const put = async (provider, body, user = ownerUser(), org = orgId) => {
    const r = req({ params: { organisationId: org, provider }, body }); const s = res(); s.locals.user = user;
    await putKey(r, s); return s;
  };
  const del = async (provider, user = ownerUser(), org = orgId) => {
    const r = req({ params: { organisationId: org, provider } }); const s = res(); s.locals.user = user;
    await deleteKey(r, s); return s;
  };
  const list = async (user = ownerUser(), org = orgId) => {
    const r = req({ params: { organisationId: org } }); const s = res(); s.locals.user = user;
    await listKeys(r, s); return s;
  };

  test('PUT stores the value encrypted at rest and responds with the masking hint only', async () => {
    const s = await put('openai', { value: 'sk-test-secret-abcd1234' });
    expect(s._status).toBe(200);
    expect(s._body).toEqual({ provider: 'openai', hint: '1234' });

    const [rows] = await OrganisationKey.sequelize.query(
      'SELECT value, hint FROM organisation_keys WHERE organisation_id = :orgId AND provider = :provider',
      { replacements: { orgId, provider: 'openai' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].value.startsWith('enc:')).toBe(true);
    expect(rows[0].value).not.toContain('sk-test-secret-abcd1234');
    expect(rows[0].hint).toBe('1234');

    // The model getter round-trips the plaintext (main-server decryption).
    const row = await OrganisationKey.findOne({ where: { organisationId: orgId, provider: 'openai' } });
    expect(row.value).toBe('sk-test-secret-abcd1234');
  });

  test('GET lists masked items plus the registry catalogue, and never returns values', async () => {
    await put('openai', { value: 'sk-test-secret-abcd1234' });
    await put('elevenlabs', { value: 'el-test-secret-wxyz9876' });

    const s = await list();
    expect(s._status).toBe(200);
    expect(s._body.items).toEqual([
      { provider: 'elevenlabs', hint: '9876', updatedAt: expect.anything() },
      { provider: 'openai', hint: '1234', updatedAt: expect.anything() },
    ]);
    const catalogue = s._body.providers;
    expect(catalogue).toEqual(expect.arrayContaining([
      { id: 'openai', label: 'OpenAI', dimensions: ['llm', 'realtime'] },
      { id: 'deepgram', label: 'Deepgram', dimensions: ['stt', 'tts'] },
    ]));
    const serialised = JSON.stringify(s._body);
    expect(serialised).not.toContain('sk-test-secret-abcd1234');
    expect(serialised).not.toContain('el-test-secret-wxyz9876');
    expect(serialised).not.toContain('enc:');
  });

  test('an unknown provider slug is a 400', async () => {
    const s = await put('nonesuch', { value: 'whatever' });
    expect(s._status).toBe(400);
    expect(await OrganisationKey.count({ where: { organisationId: orgId } })).toBe(0);
  });

  test('an invalid body is a 400', async () => {
    for (const body of [{}, { value: '' }, { value: 42 }, null]) {
      const s = await put('openai', body);
      expect(s._status).toBe(400);
    }
    expect(await OrganisationKey.count({ where: { organisationId: orgId } })).toBe(0);
  });

  test('DELETE removes a stored key (204) and 404s when none is stored', async () => {
    expect((await del('openai'))._status).toBe(404);
    await put('openai', { value: 'sk-test-secret-abcd1234' });
    expect((await del('openai'))._status).toBe(204);
    expect(await OrganisationKey.count({ where: { organisationId: orgId, provider: 'openai' } })).toBe(0);
    expect((await del('openai'))._status).toBe(404);
  });

  test('PUT upserts: a second write replaces the same provider row', async () => {
    await put('openai', { value: 'sk-first-value-1111' });
    const s = await put('openai', { value: 'sk-second-value-2222' });
    expect(s._status).toBe(200);
    expect(s._body).toEqual({ provider: 'openai', hint: '2222' });

    expect(await OrganisationKey.count({ where: { organisationId: orgId, provider: 'openai' } })).toBe(1);
    const row = await OrganisationKey.findOne({ where: { organisationId: orgId, provider: 'openai' } });
    expect(row.value).toBe('sk-second-value-2222');
    expect(row.hint).toBe('2222');
  });

  test('RBAC: a member lacks organisation:providerKeys (403)', async () => {
    expect((await put('openai', { value: 'sk-x' }, memberUser()))._status).toBe(403);
    expect((await list(memberUser()))._status).toBe(403);
    expect((await del('openai', memberUser()))._status).toBe(403);
  });

  test('RBAC: an owner manages their own org but gets 404 for another org', async () => {
    expect((await put('openai', { value: 'sk-own-org-1234' }, ownerUser()))._status).toBe(200);

    const otherOrgId = randomUUID();
    await Organisation.create({ id: otherOrgId, name: 'Other Org' });
    try {
      expect((await put('openai', { value: 'sk-x' }, ownerUser(), otherOrgId))._status).toBe(404);
      expect((await list(ownerUser(), otherOrgId))._status).toBe(404);
      expect((await del('openai', ownerUser(), otherOrgId))._status).toBe(404);
      expect(await OrganisationKey.count({ where: { organisationId: otherOrgId } })).toBe(0);
    } finally {
      await Organisation.destroy({ where: { id: otherOrgId } });
    }
  });

  test('RBAC: superAdmin manages any org cross-tenant', async () => {
    expect((await put('openai', { value: 'sk-super-cross-5678' }, superUser()))._status).toBe(200);
    const s = await list(superUser());
    expect(s._status).toBe(200);
    expect(s._body.items).toEqual([{ provider: 'openai', hint: '5678', updatedAt: expect.anything() }]);
    expect((await del('openai', superUser()))._status).toBe(204);
  });

  test('agent-db instance and agent responses carry organisationKeys filtered to the agent providers', async () => {
    const userId = randomUUID();
    await User.create({
      id: userId,
      organisationId: orgId,
      name: 'Keys User',
      email: `${userId}@test.example.com`,
      emailVerified: true,
      phone: '+10000000001',
      phoneVerified: true,
      picture: 'https://example.com/p.png',
      role: 'owner',
    });
    const agent = await Agent.create({
      name: 'BYOK agent',
      modelName: 'livekit:openai/gpt-realtime',
      prompt: 'You are a test agent.',
      options: { stt: { vendor: 'deepgram' }, fallback: { model: 'livekit:google/gemini-live' } },
      userId,
      organisationId: orgId,
    });
    const instance = await Instance.create({ agentId: agent.id, type: 'livekit', key: 'k', userId, organisationId: orgId });

    try {
      await put('openai', { value: 'sk-openai-value-1111' });
      await put('deepgram', { value: 'dg-value-2222' });
      await put('anthropic', { value: 'sk-ant-value-3333' }); // NOT referenced by the agent

      const ri = req({ query: { instanceId: instance.id } }); const si = res();
      await instanceGet(ri, si);
      expect(si._status).toBe(200);
      // openai (model) + deepgram (stt vendor) delivered decrypted; anthropic is
      // outside the need-to-know set; google (fallback) has no stored key.
      expect(si._body.organisationKeys).toEqual({ openai: 'sk-openai-value-1111', deepgram: 'dg-value-2222' });

      const ra = req({ query: { agentId: agent.id } }); const sa = res();
      await agentGet(ra, sa);
      expect(sa._status).toBe(200);
      expect(sa._body.organisationKeys).toEqual({ openai: 'sk-openai-value-1111', deepgram: 'dg-value-2222' });

      // With no stored keys the property is omitted entirely.
      await OrganisationKey.destroy({ where: { organisationId: orgId } });
      const rEmpty = req({ query: { agentId: agent.id } }); const sEmpty = res();
      await agentGet(rEmpty, sEmpty);
      expect(sEmpty._status).toBe(200);
      expect(sEmpty._body.organisationKeys).toBeUndefined();
    } finally {
      await Instance.destroy({ where: { id: instance.id } });
      await Agent.destroy({ where: { id: agent.id } });
      await User.destroy({ where: { id: userId } });
    }
  });

  test('providersForAgent maps model / stt / tts / fallback references to canonical slugs', () => {
    // Voice families ship the worker-side vendor DEFAULTS when options don't
    // pin a vendor (STT defaults to deepgram; TTS is defaulted/inferred per
    // worker; bridged-transfer transcription taps use STT even on realtime
    // models), so an unset vendor ships every key the worker could consume.
    expect(providersForAgent({ modelName: 'livekit:openai/gpt-realtime' }))
      .toEqual(new Set(['openai', 'deepgram', 'cartesia', 'elevenlabs']));
    expect(providersForAgent({ modelName: 'pipecat:gemini/gemini-2.0-flash' }).has('google')).toBe(true);
    expect(providersForAgent({ modelName: 'livekit:fixie-ai/ultravox-70B' }).has('ultravox')).toBe(true);
    expect(providersForAgent({ modelName: 'text:moonshot/kimi-k2.6' }).has('kimi')).toBe(true);
    expect(providersForAgent({ modelName: 'Text:OpenRouter/some-model' }).has('openrouter')).toBe(true); // case-insensitive
    expect(providersForAgent({ modelName: 'ultravox' }).has('ultravox')).toBe(true); // bare family name
    // text: families have no STT/TTS dimension — only the model (and any fallback) ships.
    expect(providersForAgent({ modelName: 'text:moonshot/kimi-k2.6' }).size).toBe(1);

    // Explicit vendors narrow the voice-family set to those vendors' providers
    // (model-scoped vendor strings split on '/').
    const full = providersForAgent({
      modelName: 'pipecat:anthropic/claude-sonnet-5',
      options: { stt: { vendor: 'deepgram/nova-3' }, tts: { vendor: 'cartesia' }, fallback: { model: 'text:deepseek/deepseek-chat' } },
    });
    expect(full).toEqual(new Set(['anthropic', 'deepgram', 'cartesia', 'deepseek']));

    // Not BYOK-injectable: an explicit unknown stt vendor and google TTS
    // (service-account auth) contribute nothing beyond the model's provider...
    expect(providersForAgent({
      modelName: 'pipecat:openai/gpt-4o',
      options: { stt: { vendor: 'azure' }, tts: { vendor: 'google' } },
    })).toEqual(new Set(['openai']));
    // ...and the jambonz family is out of BYOK scope entirely: nothing ships.
    expect(providersForAgent({
      modelName: 'jambonz:openai/gpt-4o',
      options: { stt: { vendor: 'deepgram' } },
    }).size).toBe(0);
    expect(providersForAgent({}).size).toBe(0);
  });

  test('resolveOrganisationKeys returns {} for an empty org or provider set', async () => {
    expect(await resolveOrganisationKeys(null, new Set(['openai']))).toEqual({});
    expect(await resolveOrganisationKeys(orgId, new Set())).toEqual({});
    expect(await resolveOrganisationKeys(orgId, new Set(['openai']))).toEqual({});
  });
});
