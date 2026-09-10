import {
  setupRealDatabase, teardownRealDatabase,
  Agent, User, Organisation,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * External TTS on a realtime model, at agent save time (docs/realtime-external-tts.md).
 * On a realtime row flagged `hasExternalTts`, `options.tts.vendor` naming a
 * pipeline TTS vendor is accepted and its voice is validated against the
 * discrete TTS catalogue; on a realtime row without the flag the same vendor is
 * rejected with the fix in the message; the model's own vendor keeps working
 * everywhere. The Ultravox catalogue comes from the live provider, as in the
 * other voice-validation tests; the external voice is a static Deepgram one.
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

const FLAGGED = 'pipecat:ultravox/ultravox-v0.7';
const FLAGGED_LIVEKIT = 'livekit:ultravox/ultravox-v0.7';
const FLAGGED_OPENAI = 'livekit:openai/gpt-realtime';
// No Gemini Live model the API still serves accepts a TEXT modality, so its rows
// keep their own voice only.
const UNFLAGGED_REALTIME = 'pipecat:google/gemini-2.0-flash-exp';

describe('options.tts.vendor on realtime models (external TTS)', () => {
  let createAgent, getAgent;
  let user, org;

  beforeAll(async () => {
    await setupRealDatabase();
    const agents = (await import('../api/paths/agents.js')).default(mockLogger, {}, {});
    createAgent = agents.POST;
    const item = (await import('../api/paths/agents/{agentId}.js')).default(mockLogger, {}, {});
    getAgent = item.GET;

    org = await Organisation.create({ id: randomUUID(), name: 'External TTS Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'External TTS Tester',
      email: `external-tts-${randomUUID()}@example.com`,
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
    await createAgent(makeReq(body), res);
    return res;
  };

  test('a flagged Ultravox row accepts an external vendor and a voice from that catalogue', async () => {
    // Deepgram's catalogue is static (lib/voices/deepgram.js), so this does not depend on a live upstream.
    const options = { tts: { vendor: 'deepgram', voice: 'aura-athena-en', language: 'en-GB' } };
    const res = await create({ modelName: FLAGGED, prompt: 'front desk', options });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([200, expect.stringMatching(/"id"/)]);
    // Stored as given: the worker reads the same block to build the TTS.
    const got = makeRes(user);
    await getAgent(makeReq({}, { agentId: res.body.id }), got);
    expect(got.body.options.tts).toEqual(options.tts);
  }, 60000);

  test('the model\'s own vendor still works on the flagged row', async () => {
    const res = await create({
      modelName: FLAGGED, prompt: 'front desk', options: { tts: { vendor: 'ultravox', voice: 'Ciara' } },
    });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([200, expect.any(String)]);
  }, 60000);

  test('an external voice is rejected when the vendor is the model\'s own', async () => {
    // Ultravox cannot render an ElevenLabs voice: without an external vendor the
    // voice is validated against the model's own catalogue, as before.
    const res = await create({
      modelName: FLAGGED, prompt: 'front desk', options: { tts: { vendor: 'ultravox', voice: 'Rachel' } },
    });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([400, expect.stringMatching(/Voice Rachel not supported/)]);
  }, 60000);

  test('a realtime row without the flag rejects an external vendor, naming the fix', async () => {
    const res = await create({
      modelName: UNFLAGGED_REALTIME, prompt: 'front desk', options: { tts: { vendor: 'elevenlabs', voice: 'Rachel' } },
    });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([
      400,
      // The body is JSON-encoded, so the quotes around the vendor are escaped.
      expect.stringMatching(/speaks with its own voice[\s\S]*set it to \\"google\\"/),
    ]);
  }, 60000);

  test('the LiveKit Ultravox and OpenAI rows accept an external vendor too', async () => {
    for (const modelName of [FLAGGED_LIVEKIT, FLAGGED_OPENAI]) {
      const res = await create({
        modelName, prompt: 'front desk', options: { tts: { vendor: 'deepgram', voice: 'aura-athena-en' } },
      });
      expect([modelName, res.statusCode, JSON.stringify(res.body)]).toEqual([modelName, 200, expect.stringMatching(/"id"/)]);
    }
  }, 60000);

  test('a vendor the pipecat worker cannot build is rejected even on a flagged row', async () => {
    const res = await create({
      modelName: FLAGGED, prompt: 'front desk', options: { tts: { vendor: 'google', voice: 'en-GB-Wavenet-A' } },
    });
    expect([res.statusCode, JSON.stringify(res.body)]).toEqual([400, expect.stringMatching(/not supported by/)]);
  }, 60000);
});
