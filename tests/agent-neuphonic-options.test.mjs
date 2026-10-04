import {
  setupRealDatabase, teardownRealDatabase,
  Agent, User, Organisation,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import { NEUPHONIC_VOICES_URL, resetNeuphonicVoicesCache } from '../lib/voices/neuphonic.js';
import { NEUPHONIC_FIXTURE } from './fixtures/neuphonic-voices.mjs';

/**
 * Neuphonic voices at agent save time (docs/neuphonic.md), through the real catalogue
 * (lib/voices) with only the Neuphonic request stubbed: accepted on both workers'
 * pipeline rows, on the realtime rows that can run an external TTS, and for the
 * fallback announcement; refused where the model speaks with its own voice.
 */

const mockLogger = {
  info: () => { }, warn: () => { }, error: () => { }, debug: () => { }, child: () => mockLogger,
};
const makeReq = (body = {}) => ({ body, params: {}, query: {}, log: mockLogger });
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

const LIZ = 'v-liz';

describe('options.tts.vendor = neuphonic', () => {
  let createAgent;
  let user, org;
  const saved = {};

  beforeAll(async () => {
    saved.key = process.env.NEUPHONIC_API_KEY;
    saved.fetch = globalThis.fetch;
    process.env.NEUPHONIC_API_KEY = 'test-key';
    globalThis.fetch = async (url, init) => (String(url) === NEUPHONIC_VOICES_URL
      ? { ok: true, status: 200, json: async () => NEUPHONIC_FIXTURE }
      : saved.fetch(url, init));
    resetNeuphonicVoicesCache();

    await setupRealDatabase();
    createAgent = (await import('../api/paths/agents.js')).default(mockLogger, {}, {}).POST;
    org = await Organisation.create({ id: randomUUID(), name: 'Neuphonic Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'Neuphonic Tester',
      email: `neuphonic-${randomUUID()}@example.com`,
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
    globalThis.fetch = saved.fetch;
    if (saved.key === undefined) delete process.env.NEUPHONIC_API_KEY; else process.env.NEUPHONIC_API_KEY = saved.key;
    resetNeuphonicVoicesCache();
    await Agent.destroy({ where: { organisationId: org.id } });
    await User.destroy({ where: { organisationId: org.id } });
    await Organisation.destroy({ where: { id: org.id } });
    await teardownRealDatabase();
  }, 60000);

  const create = async (body) => {
    const res = makeRes(user);
    await createAgent(makeReq(body), res);
    return res;
  };

  test.each([
    'pipecat:openai/gpt-4o-mini',
    'livekit:openai/gpt-4o-mini',
    'pipecat:ultravox/ultravox-v0.7',
    'livekit:ultravox/ultravox-v0.7',
    'pipecat:openai/gpt-realtime',
    'livekit:openai/gpt-realtime',
  ])('%s accepts a Neuphonic voice', async (modelName) => {
    const options = { tts: { vendor: 'neuphonic', voice: LIZ, language: 'en-GB' } };
    const res = await create({ modelName, prompt: 'front desk', options });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([200, expect.stringMatching(/"id"/)]);
  }, 60000);

  test('a voice Neuphonic does not list is refused', async () => {
    const res = await create({
      modelName: 'pipecat:openai/gpt-4o-mini', prompt: 'front desk',
      options: { tts: { vendor: 'neuphonic', voice: 'not-a-neuphonic-voice' } },
    });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([400, expect.stringMatching(/Voice not-a-neuphonic-voice not supported/)]);
  }, 60000);

  test('the vendor alone is enough, leaving the voice to Neuphonic', async () => {
    const res = await create({
      modelName: 'livekit:openai/gpt-4o-mini', prompt: 'front desk', options: { tts: { vendor: 'neuphonic', language: 'es-ES' } },
    });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([200, expect.stringMatching(/"id"/)]);
  }, 60000);

  test('a realtime row without a text output mode refuses it, naming the fix', async () => {
    const res = await create({
      modelName: 'pipecat:xai/grok-voice-think-fast-2.0', prompt: 'front desk',
      options: { tts: { vendor: 'neuphonic', voice: LIZ } },
    });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([400, expect.stringMatching(/speaks with its own voice/)]);
  }, 60000);

  test('a realtime agent can announce its fallback message with Neuphonic', async () => {
    const res = await create({
      modelName: 'pipecat:xai/grok-voice-think-fast-2.0', prompt: 'front desk',
      options: { fallback: { message: { text: 'Sorry, we cannot take your call.', vendor: 'neuphonic', voice: LIZ, language: 'en-GB' } } },
    });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([200, expect.stringMatching(/"id"/)]);
  }, 60000);
});
