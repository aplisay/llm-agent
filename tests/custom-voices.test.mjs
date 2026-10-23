import {
  setupRealDatabase, teardownRealDatabase,
  Agent, User, Organisation,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * Custom voices (docs/custom-voices.md): POST /models/{modelName}/voices/{locale}
 * accepts an OpenAI prompt voice for GPT-Live and makes it in the background;
 * /custom-voices lists, reads (settling a create that went quiet) and deletes (at
 * OpenAI too); the voice lists, agent validation and the worker's agent fetch only
 * ever see the caller's own organisation's voices; and the quota holds. OpenAI is
 * a stubbed global fetch.
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
    headers: {},
    set(name, value) { this.headers[name] = value; return this; },
    status(code) { this.statusCode = code; return this; },
    send(payload) { this.body = payload; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

const GPT_LIVE = 'pipecat:openai/gpt-live-1';
const LIVEKIT_GPT_LIVE = 'livekit:openai/gpt-live-1';
const REALTIME = 'pipecat:openai/gpt-realtime';
const PROMPT = 'A warm, unhurried woman in her forties with a soft southern English accent, at a relaxed pace.';

const mockVoices = { listVoices: async () => ({}) };

describe('custom voices', () => {
  let voicesByLocale, locales, listCustomVoices, customVoiceItem, agentDbAgent, createAgent, CustomVoice, functionHandler;
  let whenCustomVoiceSettled, sweepCreatingVoices;
  let orgA, orgB, ownerA, ownerB, memberA;
  let openaiCalls, openaiResponse, openaiDeleteResponse, openaiVoices, savedFetch, savedKey, savedPlatformLimit, seq;

  const post = async (user, body, { modelName = GPT_LIVE, locale = 'en-GB' } = {}) => {
    const res = makeRes(user);
    await voicesByLocale.POST(makeReq({ body, params: { modelName, locale } }), res);
    return res;
  };
  const getOne = async (user, id) => {
    const res = makeRes(user);
    await customVoiceItem.GET(makeReq({ params: { customVoiceId: id } }), res);
    return res;
  };
  // POST, wait for the background create, then read the voice as a poll would.
  const createVoice = async (user, body, opts) => {
    const res = await post(user, body, opts);
    expect(res.statusCode).toBe(202);
    await whenCustomVoiceSettled(res.body.id);
    return { res, voice: (await getOne(user, res.body.id)).body };
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
  // The builder's list_voices builtin, called as its chat session calls it.
  const listVoices = async (input, organisationId) => {
    const { function_results } = await functionHandler(
      [{ name: 'list_voices', input }],
      [{
        name: 'list_voices', implementation: 'builtin', platform: 'list_voices',
        input_schema: { properties: { modelName: { type: 'string' }, locale: { type: 'string' }, search: { type: 'array' } } },
      }],
      [], () => { }, {}, {}, organisationId ? { voiceOrganisationId: organisationId } : {});
    return JSON.parse(function_results[0].result);
  };
  const del = async (user, id, query = {}) => {
    const res = makeRes(user);
    await customVoiceItem.DELETE(makeReq({ params: { customVoiceId: id }, query }), res);
    return res;
  };
  // A 'creating' row with no job behind it, as a restart leaves one.
  const orphanCreate = async (org, ageMs) => {
    const row = await CustomVoice.create({
      organisationId: org.id, vendor: 'openai', method: 'prompt', name: 'orphan', prompt: PROMPT, locale: 'en-GB', status: 'creating',
    });
    await CustomVoice.sequelize.query('UPDATE custom_voices SET created_at = :t WHERE id = :id',
      { replacements: { t: new Date(Date.now() - ageMs), id: row.id } });
    return row;
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
    ({ whenCustomVoiceSettled, sweepCreatingVoices } = await import('../lib/custom-voices/index.js'));
    voicesByLocale = (await import('../api/paths/models/{modelName}/voices/{locale}.js')).default(mockLogger, mockVoices);
    locales = (await import('../api/paths/models/{modelName}/voices.js')).default(mockLogger, mockVoices).GET;
    listCustomVoices = (await import('../api/paths/custom-voices.js')).default(mockLogger).GET;
    customVoiceItem = (await import('../api/paths/custom-voices/{customVoiceId}.js')).default(mockLogger);
    agentDbAgent = (await import('../api/paths/agent-db/agent.js')).default(mockLogger).GET;
    createAgent = (await import('../api/paths/agents.js')).default(mockLogger, {}, {}).POST;
    ({ functionHandler } = await import('../lib/function-handler.js'));

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
      openaiCalls.push({ url, init, method: init.method, body: init.body ? JSON.parse(init.body) : undefined });
      let r;
      if (init.method === 'DELETE') r = openaiDeleteResponse(url);
      else if (init.method === 'GET') r = { status: 200, body: { object: 'list', data: openaiVoices, has_more: false } };
      else r = await openaiResponse(JSON.parse(init.body));
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    };
  }, 60000);

  beforeEach(async () => {
    openaiCalls = [];
    openaiVoices = [];
    openaiResponse = (body) => ({
      status: 200,
      body: { object: 'audio.voice', id: `voice_test${++seq}${randomUUID().slice(0, 8)}`, name: body.name, type: 'prompt', created_at: 1, prompt: body.prompt },
    });
    openaiDeleteResponse = (url) => ({ status: 200, body: { id: url.split('/').pop(), object: 'audio.voice.deleted', deleted: true } });
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

  test('accepts an OpenAI prompt voice at once and makes it in the background', async () => {
    let release;
    openaiResponse = (body) => new Promise((resolve) => {
      release = () => resolve({ status: 200, body: { object: 'audio.voice', id: 'voice_bg1', name: body.name, type: 'prompt' } });
    });
    const res = await post(ownerA, { name: 'Concierge', prompt: `  ${PROMPT}  `, scriptHint: 'Good morning, how can I help you today?', gender: 'female' });
    expect(res.statusCode).toBe(202);
    expect(res.headers.Location).toBe(`/api/custom-voices/${res.body.id}`);
    expect(res.body).toMatchObject({
      name: 'Concierge', vendor: 'openai', method: 'prompt', locale: 'en-GB', gender: 'female',
      prompt: PROMPT, status: 'creating', voice: null,
    });
    // One OpenAI voice serves both GPT-Live rows.
    expect([...res.body.models].sort()).toEqual([LIVEKIT_GPT_LIVE, GPT_LIVE]);

    // A poll while OpenAI works; the slot is already taken.
    expect((await getOne(ownerA, res.body.id)).body.status).toBe('creating');
    expect((await list(ownerA)).body.quota).toMatchObject({ used: 1 });

    release();
    await whenCustomVoiceSettled(res.body.id);
    const ready = (await getOne(ownerA, res.body.id)).body;
    expect(ready).toMatchObject({ status: 'ready', voice: 'voice_bg1' });

    expect(openaiCalls).toHaveLength(1);
    const [call] = openaiCalls;
    expect(call.url).toBe('https://api.openai.com/v1/audio/voices');
    expect(call.init.method).toBe('POST');
    expect(call.init.headers.Authorization).toBe('Bearer sk-proj-test');
    // OpenAI gets our row id as the name, not the customer's name.
    expect(call.body).toEqual({
      type: 'prompt', name: `aplisay-${res.body.id}`, prompt: PROMPT, model: 'auto',
      script_hint: 'Good morning, how can I help you today?',
    });

    const row = await CustomVoice.findByPk(res.body.id);
    expect(row.organisationId).toBe(orgA.id);
    expect(row.createdBy).toBe(ownerA.id);
    expect(row.vendorData).toMatchObject({ id: 'voice_bg1', request: { scriptHint: 'Good morning, how can I help you today?' } });
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

  test('a vendor refusal or failure lands on the voice, which then uses no quota', async () => {
    openaiResponse = () => ({ status: 400, body: { error: { message: 'Prompts must not name a real person', type: 'invalid_request_error' } } });
    const rejected = (await createVoice(ownerA, { name: 'x', prompt: PROMPT })).voice;
    expect(rejected).toMatchObject({ status: 'failed', errorCode: 'rejected' });
    expect(rejected.error).toMatch(/OpenAI rejected the voice: Prompts must not name a real person/);

    openaiResponse = () => ({ status: 429, body: { error: { message: 'Too many voices' } } });
    expect((await createVoice(ownerA, { name: 'z', prompt: PROMPT })).voice).toMatchObject({ status: 'failed', errorCode: 'vendor_unavailable' });

    openaiResponse = () => ({ status: 500, body: { error: { message: 'internal detail' } } });
    const failed = (await createVoice(ownerA, { name: 'y', prompt: PROMPT })).voice;
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'vendor_error' });
    expect(failed.error).not.toMatch(/internal detail/);

    const listed = await list(ownerA);
    expect(listed.body.quota).toEqual({ limit: 3, used: 0, remaining: 3 });
    expect(listed.body.voices.map((v) => v.status)).toEqual(['failed', 'failed', 'failed']);
  });

  test('enforces the organisation quota, and a delete at OpenAI frees the slot', async () => {
    await Organisation.update({ customVoiceLimit: 1 }, { where: { id: orgA.id } });
    const first = (await createVoice(ownerA, { name: 'one', prompt: PROMPT })).voice;
    expect(first.status).toBe('ready');

    const second = await post(ownerA, { name: 'two', prompt: PROMPT });
    expect(second.statusCode).toBe(409);
    expect(second.body).toMatchObject({ code: 'custom_voice_quota_exceeded', quota: { limit: 1, used: 1, remaining: 0 } });

    const deleted = await del(ownerA, first.id);
    expect(deleted.statusCode).toBe(200);
    const deleteCall = openaiCalls.at(-1);
    expect(deleteCall.method).toBe('DELETE');
    expect(deleteCall.url).toBe(`https://api.openai.com/v1/audio/voices/${first.voice}`);
    expect(deleteCall.init.headers.Authorization).toBe('Bearer sk-proj-test');
    const row = await CustomVoice.findByPk(first.id);
    expect(row.vendorData.deletion).toMatchObject({ alreadyGone: false, response: { deleted: true } });

    expect((await createVoice(ownerA, { name: 'three', prompt: PROMPT })).voice.status).toBe('ready');
    expect(openaiCalls.map((c) => c.method)).toEqual(['POST', 'DELETE', 'POST']);

    // Another organisation's quota is its own.
    expect((await post(ownerB, { name: 'b', prompt: PROMPT })).statusCode).toBe(202);

    await Organisation.update({ customVoiceLimit: null }, { where: { id: orgA.id } });
    expect((await post(ownerA, { name: 'unlimited', prompt: PROMPT })).statusCode).toBe(202);
  });

  test('a voice still being created cannot be deleted', async () => {
    let release;
    openaiResponse = (body) => new Promise((resolve) => {
      release = () => resolve({ status: 200, body: { id: 'voice_slow', name: body.name } });
    });
    const res = await post(ownerA, { name: 'slow', prompt: PROMPT });
    expect((await del(ownerA, res.body.id)).statusCode).toBe(409);
    release();
    await whenCustomVoiceSettled(res.body.id);
  });

  test('a create that finishes after its row was deleted is deleted at OpenAI', async () => {
    let release;
    openaiResponse = (body) => new Promise((resolve) => {
      release = () => resolve({ status: 200, body: { id: 'voice_late', name: body.name } });
    });
    const res = await post(ownerA, { name: 'late', prompt: PROMPT });
    // As if a sweep had marked it interrupted and the user then deleted it.
    await CustomVoice.update({ status: 'deleted', deletedAt: new Date() }, { where: { id: res.body.id } });
    release();
    await whenCustomVoiceSettled(res.body.id);
    expect(openaiCalls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST https://api.openai.com/v1/audio/voices',
      'DELETE https://api.openai.com/v1/audio/voices/voice_late',
    ]);
    expect((await CustomVoice.findByPk(res.body.id)).status).toBe('deleted');
  });

  test('a poll settles a create that went quiet from OpenAI\'s list', async () => {
    const found = await orphanCreate(orgA, 100_000);
    openaiVoices = [{ id: 'voice_found', name: `aplisay-${found.id}`, object: 'audio.voice', type: 'prompt' }];
    const res = await getOne(ownerA, found.id);
    expect(res.body).toMatchObject({ status: 'ready', voice: 'voice_found' });
    expect(openaiCalls[0]).toMatchObject({ method: 'GET' });
    expect(openaiCalls[0].url).toMatch(/^https:\/\/api\.openai\.com\/v1\/audio\/voices\?limit=100/);
    expect((await CustomVoice.findByPk(found.id)).vendorData).toMatchObject({ reconciled: true });

    // Not there yet, but young enough that OpenAI may still be making it.
    openaiVoices = [];
    const young = await orphanCreate(orgA, 100_000);
    expect((await getOne(ownerA, young.id)).body.status).toBe('creating');

    // Not there after 3 minutes: interrupted, and the slot is free.
    const lost = await orphanCreate(orgA, 200_000);
    const listed = await list(ownerA);
    expect(listed.body.voices.find((v) => v.id === lost.id)).toMatchObject({ status: 'failed', errorCode: 'interrupted' });

    // A fresh create is left alone: no list call.
    openaiCalls = [];
    const fresh = await orphanCreate(orgA, 5_000);
    expect((await getOne(ownerA, fresh.id)).body.status).toBe('creating');
    expect(openaiCalls).toHaveLength(0);
  });

  test('a create that got no answer is left for the list check, which finds it', async () => {
    openaiResponse = () => { throw new TypeError('fetch failed'); };
    const res = await post(ownerA, { name: 'lost answer', prompt: PROMPT });
    await whenCustomVoiceSettled(res.body.id);
    expect((await getOne(ownerA, res.body.id)).body.status).toBe('creating');

    await CustomVoice.sequelize.query('UPDATE custom_voices SET created_at = :t WHERE id = :id',
      { replacements: { t: new Date(Date.now() - 100_000), id: res.body.id } });
    openaiVoices = [{ id: 'voice_made_anyway', name: `aplisay-${res.body.id}` }];
    expect((await getOne(ownerA, res.body.id)).body).toMatchObject({ status: 'ready', voice: 'voice_made_anyway' });
  });

  test('the sweep settles every organisation\'s quiet creates', async () => {
    const a = await orphanCreate(orgA, 100_000);
    const b = await orphanCreate(orgB, 200_000);
    openaiVoices = [{ id: 'voice_swept', name: `aplisay-${a.id}` }];
    expect(await sweepCreatingVoices({ log: mockLogger })).toBeGreaterThanOrEqual(2);
    expect((await CustomVoice.findByPk(a.id))).toMatchObject({ status: 'ready', vendorVoiceId: 'voice_swept' });
    expect((await CustomVoice.findByPk(b.id))).toMatchObject({ status: 'failed', errorCode: 'interrupted' });
  });

  test('a failed delete at OpenAI leaves the voice as it was', async () => {
    await Organisation.update({ customVoiceLimit: 1 }, { where: { id: orgA.id } });
    const voice = (await createVoice(ownerA, { name: 'one', prompt: PROMPT })).voice;

    openaiDeleteResponse = () => ({ status: 500, body: { error: { message: 'internal detail' } } });
    const failed = await del(ownerA, voice.id);
    expect(failed.statusCode).toBe(502);
    expect(failed.body.message).not.toMatch(/internal detail/);

    // A 404 that is not "no voice found" (for example no custom voice access) does not mean gone.
    openaiDeleteResponse = () => ({ status: 404, body: { error: { message: 'Your organization does not have access to this endpoint.' } } });
    expect((await del(ownerA, voice.id)).statusCode).toBe(502);

    openaiDeleteResponse = () => ({ status: 429, body: { error: { message: 'slow down' } } });
    expect((await del(ownerA, voice.id)).statusCode).toBe(503);

    expect((await getOne(ownerA, voice.id)).body.status).toBe('ready');
    expect((await list(ownerA)).body.quota).toMatchObject({ used: 1, remaining: 0 });
  });

  test('a voice OpenAI no longer has is deleted here too', async () => {
    const voice = (await createVoice(ownerA, { name: 'gone', prompt: PROMPT })).voice;
    openaiDeleteResponse = (url) => ({
      status: 404,
      body: { error: { message: `No voice found with id '${url.split('/').pop()}'.`, type: 'invalid_request_error' } },
    });
    const res = await del(ownerA, voice.id);
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('deleted');
    expect((await CustomVoice.findByPk(voice.id)).vendorData.deletion.alreadyGone).toBe(true);
  });

  test('a failed voice is deleted without calling OpenAI', async () => {
    openaiResponse = () => ({ status: 400, body: { error: { message: 'no' } } });
    const failed = (await createVoice(ownerA, { name: 'x', prompt: PROMPT })).voice;
    openaiCalls = [];
    expect((await del(ownerA, failed.id)).statusCode).toBe(200);
    expect(openaiCalls).toHaveLength(0);
  });

  test('concurrent creates cannot both take the last slot', async () => {
    await Organisation.update({ customVoiceLimit: 1 }, { where: { id: orgA.id } });
    const results = await Promise.all([
      post(ownerA, { name: 'a', prompt: PROMPT }),
      post(ownerA, { name: 'b', prompt: PROMPT }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    await Promise.all(results.filter((r) => r.statusCode === 202).map((r) => whenCustomVoiceSettled(r.body.id)));
  });

  test('stops at the platform-wide cap', async () => {
    const used = await CustomVoice.count({ where: { vendor: 'openai', method: 'prompt', status: ['creating', 'ready'] } });
    process.env.OPENAI_PROMPT_VOICE_PLATFORM_LIMIT = String(used);
    const res = await post(ownerA, { name: 'x', prompt: PROMPT });
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('custom_voice_platform_limit');
    process.env.OPENAI_PROMPT_VOICE_PLATFORM_LIMIT = String(used + 1);
    expect((await createVoice(ownerA, { name: 'x', prompt: PROMPT })).res.statusCode).toBe(202);
  });

  test('voice lists show the organisation\'s own ready voices, first, and nobody else\'s', async () => {
    const gb = (await createVoice(ownerA, { name: 'GB voice', prompt: PROMPT, gender: 'female' })).voice;
    const anyLocale = (await createVoice(ownerA, { name: 'Any voice', prompt: 'A calm adult voice.' }, { locale: 'any' })).voice;

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

    // A voice still being made is not offered.
    await orphanCreate(orgA, 1_000);
    expect((await getVoices(ownerA, 'any')).body.vendors.OpenAI.filter((v) => v.custom)).toHaveLength(2);

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

  // list_voices used to give GPT-Live only the stock list, so a set builder could
  // not offer the organisation's own voice, though a save accepts it.
  test('the builder\'s list_voices offers the organisation\'s own ready voices, and nobody else\'s', async () => {
    const voice = (await createVoice(ownerA, { name: 'Northern Irish admin', prompt: PROMPT, gender: 'female' })).voice;

    expect((await listVoices({ modelName: GPT_LIVE }, orgA.id)).locales).toEqual(['any', 'en-GB']);
    expect((await listVoices({ modelName: GPT_LIVE }, orgB.id)).locales).toEqual(['any']);

    const gb = (await listVoices({ modelName: GPT_LIVE, locale: 'en-GB' }, orgA.id)).vendors.OpenAI;
    expect(gb[0]).toMatchObject({ name: voice.voice, custom: true, label: 'Northern Irish admin' });
    expect(gb.some((v) => v.name === 'marin')).toBe(true);

    const found = await listVoices({ modelName: GPT_LIVE, search: ['northern', 'irish', 'admin'] }, orgA.id);
    expect(found.vendors.OpenAI[0]).toMatchObject({ name: voice.voice, custom: true, matchedTerms: ['northern', 'irish', 'admin'] });
    expect(found.unmatchedTerms).toEqual([]);

    const otherOrg = await listVoices({ modelName: GPT_LIVE, search: ['northern', 'irish', 'admin'] }, orgB.id);
    expect(JSON.stringify(otherOrg)).not.toContain(voice.voice);
    expect(otherOrg.unmatchedTerms).toEqual(['northern', 'admin']);
    // No organisation in the call options (a subagent's tool plane): the stock list only.
    expect(JSON.stringify(await listVoices({ modelName: GPT_LIVE, locale: 'any' }))).not.toContain(voice.voice);
  });

  // An id the registry lacks (here a text id with the prefix swapped) used to be read
  // as a realtime row of an unknown provider and offered every vendor's voices.
  test('the builder\'s list_voices refuses a model id the handler does not list', async () => {
    const { error } = await listVoices({ modelName: 'pipecat:anthropic/claude-sonnet-4-6', search: ['british'] }, orgA.id);
    expect(error).toMatch(/^Unknown model pipecat:anthropic\/claude-sonnet-4-6/);
    expect(error).toContain('pipecat:anthropic/claude-sonnet-4-5');
    expect(error).toContain('pipecat:openai/gpt-live-1');
    expect((await listVoices({ modelName: 'livekit:openai/no-such-model' }, orgA.id)).error).toMatch(/^Unknown model livekit:/);
  });

  // The refusal reads the model id maps, while GET /models serves the allModels rows.
  // Check those rows, so a row added to one list but not the other is caught.
  test('the builder\'s list_voices accepts every model GET /models offers', async () => {
    const { unknownVoiceModelMessage } = await import('../lib/model-voices.js');
    const { default: PipecatModel } = await import('../lib/models/pipecat.js');
    const { default: LiveKitModel } = await import('../lib/models/livekit.js');
    const offered = [
      ...PipecatModel.allModels.map(([id]) => `pipecat:${id}`),
      ...LiveKitModel.allModels.map(([id]) => `livekit:${id}`),
    ];
    const elevenLabs = ['pipecat:elevenlabs/gemini-2.5-flash', 'livekit:elevenlabs/claude-sonnet-5-5'];
    expect(offered).toEqual(expect.arrayContaining([GPT_LIVE, LIVEKIT_GPT_LIVE, ...elevenLabs]));
    expect(offered.filter((id) => unknownVoiceModelMessage(id) !== null)).toEqual([]);
    for (const id of elevenLabs) expect(unknownVoiceModelMessage(id)).toBeNull();
  });

  test('another organisation cannot read, delete or list a voice', async () => {
    const voice = (await createVoice(ownerA, { name: 'mine', prompt: PROMPT })).voice;
    expect((await getOne(ownerA, voice.id)).statusCode).toBe(200);
    expect((await getOne(ownerB, voice.id)).statusCode).toBe(404);
    expect((await del(ownerB, voice.id)).statusCode).toBe(404);
    expect(openaiCalls.filter((c) => c.method === 'DELETE')).toHaveLength(0);
    expect((await getOne(ownerB, 'not-a-uuid')).statusCode).toBe(404);
    expect((await list(ownerB)).body.voices).toEqual([]);
    expect((await list(memberA)).body.voices.map((v) => v.id)).toEqual([voice.id]);
  });

  test('only the owning organisation can put a ready voice on an agent', async () => {
    const voice = (await createVoice(ownerA, { name: 'mine', prompt: PROMPT })).voice;
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

  test('GPT-Live on LiveKit takes the same custom voices as the Pipecat row', async () => {
    const voice = (await createVoice(ownerA, { name: 'lk', prompt: PROMPT }, { modelName: LIVEKIT_GPT_LIVE })).voice;
    expect(voice).toMatchObject({ status: 'ready', vendor: 'openai' });
    const listed = (await getVoices(ownerA, 'en-GB', LIVEKIT_GPT_LIVE)).body.vendors.OpenAI;
    expect(listed[0]).toMatchObject({ name: voice.voice, custom: true, label: 'lk' });
    for (const modelName of [LIVEKIT_GPT_LIVE, GPT_LIVE]) {
      const res = makeRes(ownerA);
      await createAgent(makeReq({
        body: { name: 'Live', modelName, prompt: 'Be helpful.', options: { tts: { voice: voice.voice } } },
      }), res);
      expect(res.statusCode).toBe(200);
    }
  });

  test('the worker fetch carries the voice id and prompt, and drops them after a delete', async () => {
    const voice = (await createVoice(ownerA, { name: 'mine', prompt: PROMPT })).voice;
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
