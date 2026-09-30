import {
  setupRealDatabase, teardownRealDatabase,
  Agent, User, Organisation,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import { CARTESIA_VOICES_URL, resetCartesiaVoicesCache } from '../lib/voices/cartesia.js';
import { CARTESIA_PAGES } from './fixtures/cartesia-voices.mjs';

/**
 * Cartesia voices at agent save time, through the real catalogue (lib/voices) with only
 * the Cartesia requests stubbed: accepted on both workers' pipeline rows and on the
 * realtime rows that can run an external TTS; unknown voices refused.
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

const GEORGE = 'c-george';

describe('options.tts.vendor = cartesia', () => {
  let createAgent;
  let user, org;
  const saved = {};

  beforeAll(async () => {
    saved.key = process.env.CARTESIA_API_KEY;
    saved.fetch = globalThis.fetch;
    process.env.CARTESIA_API_KEY = 'test-key';
    globalThis.fetch = async (url, init) => (String(url).startsWith(CARTESIA_VOICES_URL)
      ? { ok: true, status: 200, json: async () => CARTESIA_PAGES[new URL(url).searchParams.get('starting_after') ? 1 : 0] }
      : saved.fetch(url, init));
    resetCartesiaVoicesCache();

    await setupRealDatabase();
    createAgent = (await import('../api/paths/agents.js')).default(mockLogger, {}, {}).POST;
    org = await Organisation.create({ id: randomUUID(), name: 'Cartesia Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'Cartesia Tester',
      email: `cartesia-${randomUUID()}@example.com`,
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
    if (saved.key === undefined) delete process.env.CARTESIA_API_KEY; else process.env.CARTESIA_API_KEY = saved.key;
    resetCartesiaVoicesCache();
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
  ])('%s accepts a Cartesia voice', async (modelName) => {
    const options = { tts: { vendor: 'cartesia', voice: GEORGE, language: 'en-GB' } };
    const res = await create({ modelName, prompt: 'front desk', options });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([200, expect.stringMatching(/"id"/)]);
  }, 60000);

  test('a voice Cartesia does not list is refused', async () => {
    const res = await create({
      modelName: 'livekit:ultravox/ultravox-v0.7', prompt: 'front desk',
      options: { tts: { vendor: 'cartesia', voice: 'c-zara' } },
    });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([400, expect.stringMatching(/Voice c-zara not supported/)]);
  }, 60000);
});
