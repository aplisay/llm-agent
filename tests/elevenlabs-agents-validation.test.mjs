import {
  setupRealDatabase, teardownRealDatabase,
  Agent, User, Organisation,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import { ELEVENLABS_DEFAULT_VOICE } from '../lib/elevenlabs-agents.js';
import { mapXiLabsVoices, seedXiLabsVoices, resetXiLabsVoicesCache } from '../lib/voices/xilabs.js';

// The ElevenLabs catalogue is fetched from api.elevenlabs.io when a key is set;
// seed it so this suite never touches the network.
process.env.ELEVENLABS_API_KEY ||= 'test-key';
seedXiLabsVoices(mapXiLabsVoices([
  { voice_id: 'v-brit', name: 'Alice', labels: { accent: 'british', gender: 'female' } },
  { voice_id: ELEVENLABS_DEFAULT_VOICE, name: 'Chris', labels: { accent: 'american', gender: 'male' } },
]));

/**
 * The ElevenLabs Agents rows at agent save time (docs/elevenlabs-agents.md): a
 * reserved function name and the platform-owned settings in
 * `vendorSpecific.elevenlabs` are rejected; the voice is validated against the
 * ElevenLabs catalogue and the TTS vendor must be elevenlabs; the voices
 * endpoints list the ElevenLabs block for the rows and nothing else. The pure
 * rules are tests/elevenlabs-agents-model.test.mjs.
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
    elevenlabs: { 'en-GB': [{ name: 'v-brit', description: 'Alice' }] },
    cartesia: { 'en-GB': [{ name: 'c-1', description: 'Cart' }] },
  }),
};

const ROW = 'pipecat:elevenlabs/gemini-2.5-flash';
const restFunction = (name) => ({
  name, implementation: 'rest', url: 'https://example.com/hook', description: name,
  input_schema: { type: 'object', properties: {} },
});

describe('ElevenLabs Agents rows at agent save time', () => {
  let createAgent, voicesGet, localesGet;
  let user, org;

  beforeAll(async () => {
    await setupRealDatabase();
    createAgent = (await import('../api/paths/agents.js')).default(mockLogger, {}, {}).POST;
    localesGet = (await import('../api/paths/models/{modelName}/voices.js')).default(mockLogger, mockVoices).GET;
    voicesGet = (await import('../api/paths/models/{modelName}/voices/{locale}.js')).default(mockLogger, mockVoices).GET;
    org = await Organisation.create({ id: randomUUID(), name: 'ElevenLabs Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'ElevenLabs Tester',
      email: `elevenlabs-${randomUUID()}@example.com`,
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
    resetXiLabsVoicesCache();
  }, 60000);

  const create = async (body) => {
    const res = makeRes(user);
    await createAgent(makeReq({ name: 'Sam', prompt: 'You are Sam.', ...body }), res);
    return res;
  };
  const errorText = (res) => (Array.isArray(res.body) ? res.body.join('; ') : `${res.body?.message ?? JSON.stringify(res.body)}`);

  test('a plain ElevenLabs agent with a catalogue voice, functions and MCP saves', async () => {
    const res = await create({
      modelName: ROW,
      options: { tts: { voice: 'v-brit' }, greeting: { text: 'Acme Dental, Sam speaking.' }, inactivity: { timeout: 10, message: 'Still there?' } },
      functions: [restFunction('get_slots'), { name: 'hangup', implementation: 'builtin', platform: 'hangup', input_schema: { properties: {} } }],
      mcpServers: [{ name: 'crm', url: 'https://example.com/mcp' }],
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
  });

  test('rejects a reserved function name on the row, and allows it on another row', async () => {
    const res = await create({ modelName: ROW, functions: [restFunction('end_call')] });
    expect(res.statusCode).toBe(400);
    expect(errorText(res)).toMatch(/"end_call" reserved by ElevenLabs/);
    const other = await create({ modelName: 'pipecat:openai/gpt-realtime', functions: [restFunction('end_call')] });
    expect(other.statusCode).toBe(200);
  });

  test('rejects platform-owned settings in vendorSpecific.elevenlabs and accepts tuning', async () => {
    const llm = await create({ modelName: ROW, options: { vendorSpecific: { elevenlabs: { conversation_config: { agent: { prompt: { llm: 'gpt-4o' } } } } } } });
    expect(llm.statusCode).toBe(400);
    expect(errorText(llm)).toMatch(/agent\.prompt\.llm is set by the platform/);
    const auth = await create({ modelName: ROW, options: { vendorSpecific: { elevenlabs: { platform_settings: { auth: { enable_auth: false } } } } } });
    expect(auth.statusCode).toBe(400);
    expect(errorText(auth)).toMatch(/platform_settings is not accepted/);
    const ok = await create({
      modelName: ROW,
      options: { vendorSpecific: { elevenlabs: { conversation_config: { turn: { turn_eagerness: 'eager' }, tts: { stability: 0.4 } } } } },
    });
    expect(ok.statusCode).toBe(200);
  });

  test('validates the voice against the ElevenLabs catalogue and accepts only the elevenlabs vendor', async () => {
    const unknown = await create({ modelName: ROW, options: { tts: { voice: 'alloy' } } });
    expect(unknown.statusCode).toBe(400);
    expect(errorText(unknown)).toMatch(/Voice alloy not supported/);
    const external = await create({ modelName: ROW, options: { tts: { vendor: 'cartesia', voice: 'c-1' } } });
    expect(external.statusCode).toBe(400);
    expect(errorText(external)).toMatch(/not supported by pipecat:elevenlabs\/gemini-2.5-flash/);
    const native = await create({ modelName: ROW, options: { tts: { vendor: 'elevenlabs', voice: ELEVENLABS_DEFAULT_VOICE } } });
    expect(native.statusCode).toBe(200);
  });

  test('the voices endpoints list the ElevenLabs block for the row and nothing else', async () => {
    const locales = makeRes();
    await localesGet(makeReq({}, { modelName: ROW }), locales);
    expect(locales.statusCode).toBe(200);
    expect(locales.body.voiceStack).toBe('realtime');
    expect(locales.body.locales.sort()).toEqual(['en-GB', 'en-US']);
    const res = makeRes();
    await voicesGet(makeReq({}, { modelName: ROW, locale: 'en-GB' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.voiceStack).toBe('realtime');
    expect(Object.keys(res.body.vendors)).toEqual(['elevenlabs']);
    expect(res.body.vendors.elevenlabs.map((v) => v.name)).toEqual(['v-brit']);
    // the Grok row never sees the ElevenLabs block
    const grok = makeRes();
    await voicesGet(makeReq({}, { modelName: 'pipecat:xai/grok-voice-think-fast-2.0', locale: 'any' }), grok);
    expect(Object.keys(grok.body.vendors)).toEqual(['xAI']);
  });
});
