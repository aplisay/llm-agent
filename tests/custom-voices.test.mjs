import {
  setupRealDatabase, teardownRealDatabase,
  Agent, User, Organisation,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * Custom voices (docs/custom-voices.md): POST /models/{modelName}/voices/{locale}
 * creates an OpenAI prompt voice for GPT-Live; /custom-voices lists, reads and
 * deletes; the voice lists, agent validation and the worker's agent fetch only
 * ever see the caller's own organisation's voices; and the quota holds, deleted
 * OpenAI voices included. OpenAI is a stubbed global fetch.
 */

const mockLogger = {
  info: () => { }, warn: () => { }, error: () => { }, debug: () => { }, child: () => mockLogger,
};

function makeReq({ body = {}, params = {}, query = {} } = {}) {
  return { body, params, query, log: mockLogger };
}

function makeRes(user) {
  return {
    locals: { user },
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const GPT_LIVE = 'pipecat:openai/gpt-live-1';
const REALTIME = 'pipecat:openai/gpt-realtime';
const PROMPT = 'A warm, unhurried woman in her forties with a soft southern English accent, at a relaxed pace.';

const mockVoices = { listVoices: async () => ({}) };

describe('custom voices', () => {
  let voicesByLocale, locales, listCustomVoices, customVoiceItem, agentDbAgent, createAgent, CustomVoice;
  let orgA, orgB, ownerA, ownerB, memberA;
  let openaiCalls, openaiResponse, savedFetch, savedKey, savedPlatformLimit, seq;

  const post = async (user, body, { modelName = GPT_LIVE, locale = 'en-GB' } = {}) => {
    const res = makeRes(user);
    await voicesByLocale.POST(makeReq({ body, params: { modelName, locale } }), res);
    return res;
  };
  const getVoices = async (user, locale = 'en-GB', modelName = GPT_LIVE) => {
    const res = makeRes(user);
    await voicesByLocale.GET(makeReq({ params: { modelName, locale } }), res);
    return res;
  };
  const list = async (user, query = {}) => {
    const res = makeRes(user);
    await listCustomVoices(makeReq({ query }), res);
    return res;
  };
  const del = async (user, id, query = {}) => {
    const res = makeRes(user);
    await customVoiceItem.DELETE(makeReq({ params: { customVoiceId: id }, query }), res);
    return res;
  };
  const getOne = async (user, id) => {
    const res = makeRes(user);
    await customVoiceItem.GET(makeReq({ params: { customVoiceId: id } }), res);
    return res;
  };

  const makeUser = async (org, role) => {
    const dbUser = await User.create({
      id: randomUUID(), name: `${role} tester`, email: `cv-${randomUUID()}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '', role, organisationId: org.id,
    });
    return { id: dbUser.id, organisationId: org.id, role };
  };

  beforeAll(async () => {
    await setupRealDatabase();
    ({ CustomVoice } = await import('../lib/database.js'));
    voicesByLocale = (await import('../api/paths/models/{modelName}/voices/{locale}.js')).default(mockLogger, mockVoices);
    locales = (await import('../api/paths/models/{modelName}/voices.js')).default(mockLogger, mockVoices).GET;
    listCustomVoices = (await import('../api/paths/custom-voices.js')).default(mockLogger).GET;
    customVoiceItem = (await import('../api/paths/custom-voices/{customVoiceId}.js')).default(mockLogger);
    agentDbAgent = (await import('../api/paths/agent-db/agent.js')).default(mockLogger).GET;
    createAgent = (await import('../api/paths/agents.js')).default(mockLogger, {}, {}).POST;

    orgA = await Organisation.create({ id: randomUUID(), name: 'Custom Voice Org A' });
    orgB = await Organisation.create({ id: randomUUID(), name: 'Custom Voice Org B' });
    ownerA = await makeUser(orgA, 'owner');
    ownerB = await makeUser(orgB, 'owner');
    memberA = await makeUser(orgA, 'member');

    savedFetch = globalThis.fetch;
    savedKey = process.env.OPENAI_API_KEY;
    savedPlatformLimit = process.env.OPENAI_PROMPT_VOICE_PLATFORM_LIMIT;
    process.env.OPENAI_API_KEY = 'sk-proj-test';
    seq = 0;
    globalThis.fetch = async (url, init) => {
      openaiCalls.push({ url, init, body: JSON.parse(init.body) });
      const r = openaiResponse();
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    };
  }, 60000);

  beforeEach(async () => {
    openaiCalls = [];
    openaiResponse = () => ({
      status: 200,
      body: { object: 'audio.voice', id: `voice_test${++seq}${randomUUID().slice(0, 8)}`, name: 'x', type: 'prompt', created_at: 1, prompt: PROMPT },
    });
    delete process.env.OPENAI_PROMPT_VOICE_PLATFORM_LIMIT;
    await Agent.destroy({ where: { organisationId: [orgA.id, orgB.id] } });
    await CustomVoice.destroy({ where: { organisationId: [orgA.id, orgB.id] } });
    await Organisation.update({ customVoiceLimit: 3 }, { where: { id: [orgA.id, orgB.id] } });
  });

  afterAll(async () => {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
    if (savedPlatformLimit !== undefined) process.env.OPENAI_PROMPT_VOICE_PLATFORM_LIMIT = savedPlatformLimit;
    await Agent.destroy({ where: { organisationId: [orgA.id, orgB.id] } });
    await CustomVoice.destroy({ where: { organisationId: [orgA.id, orgB.id] } });
    await User.destroy({ where: { organisationId: [orgA.id, orgB.id] } });
    await Organisation.destroy({ where: { id: [orgA.id, orgB.id] } });
    await teardownRealDatabase();
  }, 60000);

  test('new organisations get a quota of 3', async () => {
    const org = await Organisation.create({ id: randomUUID(), name: 'Default quota org' });
    expect(org.customVoiceLimit).toBe(3);
    await org.destroy();
  });

  test('only a super admin can change the quota through the organisation PATCH', async () => {
    const patchOrganisation = (await import('../api/paths/organisations/{organisationId}.js')).default(mockLogger).PATCH;
    const patch = async (user, body) => {
      const res = makeRes(user);
      await patchOrganisation(makeReq({ params: { organisationId: orgA.id }, body }), res);
      return res;
    };
    expect((await patch({ role: 'orgAdmin', organisationId: orgA.id }, { customVoiceLimit: 50 })).statusCode).toBe(403);
    expect((await Organisation.findByPk(orgA.id)).customVoiceLimit).toBe(3);
    const superAdmin = { role: 'superAdmin', organisationId: randomUUID() };
    expect((await patch(superAdmin, { customVoiceLimit: -2 })).statusCode).toBe(400);
    expect((await patch(superAdmin, { customVoiceLimit: 7 })).statusCode).toBe(200);
    expect((await Organisation.findByPk(orgA.id)).customVoiceLimit).toBe(7);
    expect((await list(ownerA)).body.quota).toEqual({ limit: 7, used: 0, remaining: 7 });
  });

  test('creates an OpenAI prompt voice for GPT-Live', async () => {
    const res = await post(ownerA, { name: 'Concierge', prompt: `  ${PROMPT}  `, scriptHint: 'Good morning, how can I help you today?', gender: 'female' });
    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Concierge', vendor: 'openai', method: 'prompt', locale: 'en-GB', gender: 'female',
      prompt: PROMPT, status: 'ready', models: [GPT_LIVE],
    });
    expect(res.body.voice).toMatch(/^voice_test/);

    expect(openaiCalls).toHaveLength(1);
    const [call] = openaiCalls;
    expect(call.url).toBe('https://api.openai.com/v1/audio/voices');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers.Authorization).toBe('Bearer sk-proj-test');
    expect(call.body).toEqual({
      type: 'prompt', name: 'Concierge', prompt: PROMPT, model: 'auto',
      script_hint: 'Good morning, how can I help you today?',
    });

    const row = await CustomVoice.findByPk(res.body.id);
    expect(row.organisationId).toBe(orgA.id);
    expect(row.createdBy).toBe(ownerA.id);
    expect(row.vendorVoiceId).toBe(res.body.voice);
  });

  test('refuses a model with no custom voices, and the recording method', async () => {
    const realtime = await post(ownerA, { name: 'x', prompt: PROMPT }, { modelName: REALTIME });
    expect(realtime.statusCode).toBe(400);
    expect(realtime.body.message).toMatch(/does not support prompt custom voices/);

    const recording = await post(ownerA, { name: 'x', method: 'recording' });
    expect(recording.statusCode).toBe(501);

    const vendor = await post(ownerA, { name: 'x', prompt: PROMPT, vendor: 'elevenlabs' });
    expect(vendor.statusCode).toBe(400);
    expect(openaiCalls).toHaveLength(0);
  });

  test.each([
    [{ prompt: PROMPT }, /name is required/],
    [{ name: 'x' }, /prompt is required/],
    [{ name: 'x', prompt: '   ' }, /prompt must not be blank/],
    [{ name: 'x', prompt: 'p'.repeat(2001) }, /at most 2000/],
    [{ name: 'x', prompt: PROMPT, scriptHint: ' ' }, /scriptHint must not be blank/],
    [{ name: 'x', prompt: PROMPT, gender: 'robot' }, /gender must be one of/],
  ])('rejects bad input %#', async (body, message) => {
    const res = await post(ownerA, body);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(message);
    expect(openaiCalls).toHaveLength(0);
  });

  test('rejects a bad locale', async () => {
    const res = await post(ownerA, { name: 'x', prompt: PROMPT }, { locale: 'en GB' });
    expect(res.statusCode).toBe(400);
  });

  test('needs voice:create, and a configured key', async () => {
    const member = await post(memberA, { name: 'x', prompt: PROMPT });
    expect(member.statusCode).toBe(403);

    delete process.env.OPENAI_API_KEY;
    try {
      const res = await post(ownerA, { name: 'x', prompt: PROMPT });
      expect(res.statusCode).toBe(503);
    }
    finally {
      process.env.OPENAI_API_KEY = 'sk-proj-test';
    }
    expect(openaiCalls).toHaveLength(0);
  });

  test('a vendor rejection is passed on and the failed voice does not use quota', async () => {
    openaiResponse = () => ({ status: 400, body: { error: { message: 'Prompts must not name a real person', type: 'invalid_request_error' } } });
    const res = await post(ownerA, { name: 'x', prompt: PROMPT });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/OpenAI rejected the voice: Prompts must not name a real person/);
    expect(res.body.voice.status).toBe('failed');

    openaiResponse = () => ({ status: 429, body: { error: { message: 'Too many voices' } } });
    expect((await post(ownerA, { name: 'z', prompt: PROMPT })).statusCode).toBe(503);

    openaiResponse = () => ({ status: 500, body: { error: { message: 'internal detail' } } });
    const failed = await post(ownerA, { name: 'y', prompt: PROMPT });
    expect(failed.statusCode).toBe(502);
    expect(failed.body.message).not.toMatch(/internal detail/);

    const listed = await list(ownerA);
    expect(listed.body.quota).toEqual({ limit: 3, used: 0, remaining: 3 });
    expect(listed.body.voices.map((v) => v.status)).toEqual(['failed', 'failed', 'failed']);
  });

  test('enforces the organisation quota, and a deleted OpenAI voice still counts', async () => {
    await Organisation.update({ customVoiceLimit: 1 }, { where: { id: orgA.id } });
    const first = await post(ownerA, { name: 'one', prompt: PROMPT });
    expect(first.statusCode).toBe(201);

    const second = await post(ownerA, { name: 'two', prompt: PROMPT });
    expect(second.statusCode).toBe(409);
    expect(second.body).toMatchObject({ code: 'custom_voice_quota_exceeded', quota: { limit: 1, used: 1, remaining: 0 } });

    expect((await del(ownerA, first.body.id)).statusCode).toBe(200);
    const third = await post(ownerA, { name: 'three', prompt: PROMPT });
    expect(third.statusCode).toBe(409);
    expect(openaiCalls).toHaveLength(1);

    // Another organisation's quota is its own.
    expect((await post(ownerB, { name: 'b', prompt: PROMPT })).statusCode).toBe(201);

    await Organisation.update({ customVoiceLimit: null }, { where: { id: orgA.id } });
    expect((await post(ownerA, { name: 'unlimited', prompt: PROMPT })).statusCode).toBe(201);
  });

  test('concurrent creates cannot both take the last slot', async () => {
    await Organisation.update({ customVoiceLimit: 1 }, { where: { id: orgA.id } });
    const results = await Promise.all([
      post(ownerA, { name: 'a', prompt: PROMPT }),
      post(ownerA, { name: 'b', prompt: PROMPT }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
  });

  test('stops at the platform-wide cap', async () => {
    const used = await CustomVoice.count({ where: { vendor: 'openai', method: 'prompt', status: ['creating', 'ready', 'deleted'] } });
    process.env.OPENAI_PROMPT_VOICE_PLATFORM_LIMIT = String(used);
    const res = await post(ownerA, { name: 'x', prompt: PROMPT });
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('custom_voice_platform_limit');
    process.env.OPENAI_PROMPT_VOICE_PLATFORM_LIMIT = String(used + 1);
    expect((await post(ownerA, { name: 'x', prompt: PROMPT })).statusCode).toBe(201);
  });

  test('voice lists show the organisation\'s own voices, first, and nobody else\'s', async () => {
    const gb = (await post(ownerA, { name: 'GB voice', prompt: PROMPT, gender: 'female' })).body;
    const anyLocale = (await post(ownerA, { name: 'Any voice', prompt: 'A calm adult voice.' }, { locale: 'any' })).body;

    const gbList = await getVoices(ownerA, 'en-GB');
    expect(gbList.statusCode).toBe(200);
    const openai = gbList.body.vendors.OpenAI;
    expect(openai.slice(0, 2).map((v) => v.name)).toEqual([gb.voice, anyLocale.voice]);
    expect(openai[0]).toMatchObject({ custom: true, customVoiceId: gb.id, label: 'GB voice', gender: 'female', locale: 'en-GB' });
    expect(openai.some((v) => v.name === 'marin')).toBe(true);

    const frList = await getVoices(ownerA, 'fr-FR');
    expect(frList.body.vendors.OpenAI.filter((v) => v.custom).map((v) => v.name)).toEqual([anyLocale.voice]);
    const anyList = await getVoices(ownerA, 'any');
    expect(anyList.body.vendors.OpenAI.filter((v) => v.custom)).toHaveLength(2);

    const other = await getVoices(ownerB, 'en-GB');
    expect(other.body.vendors.OpenAI.some((v) => v.custom)).toBe(false);
    const realtime = await getVoices(ownerA, 'en-GB', REALTIME);
    expect(JSON.stringify(realtime.body)).not.toMatch(/custom/);

    const loc = makeRes(ownerA);
    await locales(makeReq({ params: { modelName: GPT_LIVE } }), loc);
    expect(loc.body.locales).toEqual(['any', 'en-GB']);
    const locB = makeRes(ownerB);
    await locales(makeReq({ params: { modelName: GPT_LIVE } }), locB);
    expect(locB.body.locales).toEqual(['any']);
  });

  test('another organisation cannot read, delete or list a voice', async () => {
    const voice = (await post(ownerA, { name: 'mine', prompt: PROMPT })).body;
    expect((await getOne(ownerA, voice.id)).statusCode).toBe(200);
    expect((await getOne(ownerB, voice.id)).statusCode).toBe(404);
    expect((await del(ownerB, voice.id)).statusCode).toBe(404);
    expect((await getOne(ownerB, 'not-a-uuid')).statusCode).toBe(404);
    expect((await list(ownerB)).body.voices).toEqual([]);
    expect((await list(memberA)).body.voices.map((v) => v.id)).toEqual([voice.id]);
  });

  test('only the owning organisation can put the voice on an agent', async () => {
    const voice = (await post(ownerA, { name: 'mine', prompt: PROMPT })).body;
    const agentBody = { name: 'Live', modelName: GPT_LIVE, prompt: 'Be helpful.', options: { tts: { voice: voice.voice } } };

    const own = makeRes(ownerA);
    await createAgent(makeReq({ body: agentBody }), own);
    expect(own.statusCode).toBe(200);

    const foreign = makeRes(ownerB);
    await createAgent(makeReq({ body: agentBody }), foreign);
    expect(foreign.statusCode).toBe(400);
    expect(JSON.stringify(foreign.body)).toMatch(/not supported/);

    // A model that cannot speak the voice refuses it too.
    const realtime = makeRes(ownerA);
    await createAgent(makeReq({ body: { ...agentBody, modelName: REALTIME } }), realtime);
    expect(realtime.statusCode).toBe(400);
  });

  test('the worker fetch carries the voice id and prompt, and drops them after a delete', async () => {
    const voice = (await post(ownerA, { name: 'mine', prompt: PROMPT })).body;
    const agent = await Agent.create({
      name: 'Live', modelName: GPT_LIVE, prompt: 'Be helpful.', options: { tts: { voice: voice.voice } },
      userId: ownerA.id, organisationId: orgA.id,
    });
    const fetchAgent = async () => {
      const res = makeRes({ isSystem: true });
      await agentDbAgent(makeReq({ query: { agentId: agent.id } }), res);
      return res.body;
    };
    expect((await fetchAgent()).customVoice).toEqual({
      id: voice.id, vendor: 'openai', method: 'prompt', voice: voice.voice, name: 'mine', prompt: PROMPT, locale: 'en-GB',
    });

    const inUse = await del(ownerA, voice.id);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.body).toMatchObject({ code: 'custom_voice_in_use', agents: [{ id: agent.id, name: 'Live' }] });

    const forced = await del(ownerA, voice.id, { force: 'true' });
    expect(forced.statusCode).toBe(200);
    expect(forced.body.status).toBe('deleted');
    expect((await fetchAgent()).customVoice).toBeUndefined();

    expect((await list(ownerA)).body.voices).toEqual([]);
    expect((await list(ownerA, { includeDeleted: 'true' })).body.voices.map((v) => v.id)).toEqual([voice.id]);
    expect((await del(ownerA, voice.id)).statusCode).toBe(404);
  });
});
