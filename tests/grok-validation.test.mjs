import {
  setupRealDatabase, teardownRealDatabase,
  Agent, User, Organisation,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import Xai from '../lib/models/xai.js';
import { xaiVoiceTree } from '../lib/voices/xai.js';

// The xAI voice catalogue is fetched from api.x.ai when a key is set; seed it
// so this suite never touches the network. The key makes the text rows load.
process.env.XAI_API_KEY ||= 'test-key';
Xai._voices = Promise.resolve(xaiVoiceTree());

/**
 * The Grok rows at agent save time (docs/grok.md): a reserved function name
 * and server-side tools in `vendorSpecific.xai.session` are rejected on the
 * voice row; the voice is validated against the xAI list and the TTS vendor
 * must be xai; the text row saves as a text agent. The voices endpoints list
 * the xAI block for the voice row and nothing else. The pure rules are
 * tests/grok-model.test.mjs.
 */

const mockLogger = {
  info: () => { }, warn: () => { }, error: () => { }, debug: () => { }, child: () => mockLogger,
};

function makeReq(body = {}, params = {}, query = {}) {
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

// Stands in for lib/voices: the discrete TTS catalogue the pipeline rows use.
const mockVoices = {
  listVoices: async () => ({
    elevenlabs: { 'en-GB': [{ name: 'Rachel', description: 'Rachel' }] },
  }),
};

const GROK_VOICE = 'pipecat:xai/grok-voice-think-fast-2.0';
const restFunction = (name) => ({
  name, implementation: 'rest', url: 'https://example.com/hook', description: name,
  input_schema: { type: 'object', properties: {} },
});

describe('Grok rows at agent save time', () => {
  let createAgent, voicesGet, localesGet;
  let user, org;

  beforeAll(async () => {
    await setupRealDatabase();
    createAgent = (await import('../api/paths/agents.js')).default(mockLogger, {}, {}).POST;
    localesGet = (await import('../api/paths/models/{modelName}/voices.js')).default(mockLogger, mockVoices).GET;
    voicesGet = (await import('../api/paths/models/{modelName}/voices/{locale}.js')).default(mockLogger, mockVoices).GET;
    org = await Organisation.create({ id: randomUUID(), name: 'Grok Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'Grok Tester',
      email: `grok-${randomUUID()}@example.com`,
      emailVerified: true,
      phone: '',
      phoneVerified: false,
      picture: '',
      role: 'owner',
      organisationId: org.id,
    });
    user = { id: dbUser.id, organisationId: org.id, role: 'owner' };
  }, 60000);

  afterAll(async () => {
    await Agent.destroy({ where: { organisationId: org.id } });
    await User.destroy({ where: { organisationId: org.id } });
    await Organisation.destroy({ where: { id: org.id } });
    await teardownRealDatabase();
  }, 60000);

  const create = async (body) => {
    const res = makeRes(user);
    await createAgent(makeReq({ name: 'Sam', prompt: 'You are Sam.', ...body }), res);
    return res;
  };
  const errorText = (res) => (Array.isArray(res.body) ? res.body.join('; ') : `${res.body?.message ?? JSON.stringify(res.body)}`);

  test('a plain Grok voice agent with a valid voice and functions saves', async () => {
    const res = await create({
      modelName: GROK_VOICE,
      options: { tts: { voice: 'rex' }, greeting: { text: 'Acme Dental, Sam speaking.' } },
      functions: [restFunction('get_slots'), { name: 'hangup', implementation: 'builtin', platform: 'hangup', input_schema: { properties: {} } }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
  });

  test('rejects a reserved function name on the voice row, and allows it on another row', async () => {
    const res = await create({ modelName: GROK_VOICE, functions: [restFunction('web_search')] });
    expect(res.statusCode).toBe(400);
    expect(errorText(res)).toMatch(/"web_search" reserved by xAI/);
    const other = await create({ modelName: 'pipecat:openai/gpt-realtime', functions: [restFunction('web_search')] });
    expect(other.statusCode).toBe(200);
  });

  test('rejects server-side tools in vendorSpecific.xai.session and accepts tuning fields', async () => {
    const tools = await create({ modelName: GROK_VOICE, options: { vendorSpecific: { xai: { session: { tools: [] } } } } });
    expect(tools.statusCode).toBe(400);
    expect(errorText(tools)).toMatch(/session\.tools is not accepted/);
    const mcp = await create({ modelName: GROK_VOICE, options: { vendorSpecific: { xai: { session: { extra: [{ type: 'mcp', server_url: 'https://x' }] } } } } });
    expect(mcp.statusCode).toBe(400);
    expect(errorText(mcp)).toMatch(/type "mcp"/);
    const ok = await create({
      modelName: GROK_VOICE,
      options: { vendorSpecific: { xai: { session: { turn_detection: { type: 'server_vad', silence_duration_ms: 350 }, replace: { Aplisay: 'Appli-say' } } } } },
    });
    expect(ok.statusCode).toBe(200);
  });

  test('validates the voice against the xAI list and accepts only the xai vendor', async () => {
    const unknown = await create({ modelName: GROK_VOICE, options: { tts: { voice: 'alloy' } } });
    expect(unknown.statusCode).toBe(400);
    expect(errorText(unknown)).toMatch(/Voice alloy not supported/);
    const external = await create({ modelName: GROK_VOICE, options: { tts: { vendor: 'elevenlabs', voice: 'Rachel' } } });
    expect(external.statusCode).toBe(400);
    expect(errorText(external)).toMatch(/not supported by pipecat:xai\/grok-voice-think-fast-2.0/);
    const native = await create({ modelName: GROK_VOICE, options: { tts: { vendor: 'xai', voice: 'eve' } } });
    expect(native.statusCode).toBe(200);
    const liora = await create({ modelName: GROK_VOICE, options: { tts: { voice: 'liora' } } });
    expect(liora.statusCode).toBe(200);
  });

  test('a Grok text agent saves as a text agent', async () => {
    const res = await create({ modelName: 'text:xai/grok-4.3', options: { effort: 'low' } });
    expect(res.statusCode).toBe(200);
    expect(res.body.type).toBe('text');
  });

  test('the voices endpoints list the xAI block for the voice row and nothing else', async () => {
    const locales = makeRes();
    await localesGet(makeReq({}, { modelName: GROK_VOICE }), locales);
    expect(locales.statusCode).toBe(200);
    expect(locales.body).toEqual({ locales: ['any'], voiceStack: 'realtime' });
    const res = makeRes();
    await voicesGet(makeReq({}, { modelName: GROK_VOICE, locale: 'any' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.voiceStack).toBe('realtime');
    expect(Object.keys(res.body.vendors)).toEqual(['xAI']);
    const names = res.body.vendors.xAI.map((v) => v.name);
    expect(names).toHaveLength(28);
    expect(names).toEqual(expect.arrayContaining(['eve', 'rex', 'ara', 'aurora', 'liora']));
    expect(names).not.toContain('alloy');
    // no text-output mode, so no discrete TTS catalogue at a real locale either
    const gb = makeRes();
    await voicesGet(makeReq({}, { modelName: GROK_VOICE, locale: 'en-GB' }), gb);
    expect(Object.keys(gb.body.vendors)).toEqual(['xAI']);
    expect(gb.body.vendors.xAI.map((v) => v.name)).toEqual(names);
    // the OpenAI Realtime row never sees the xAI block
    const openai = makeRes();
    await voicesGet(makeReq({}, { modelName: 'pipecat:openai/gpt-realtime', locale: 'any' }), openai);
    expect(Object.keys(openai.body.vendors)).toEqual(['OpenAI']);
  });
});
