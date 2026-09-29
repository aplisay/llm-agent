import {
  setupRealDatabase, teardownRealDatabase,
  Agent, User, Organisation,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * options.tts.speed at agent save time: accepted on every voice model, refused
 * outside 0.25..2, and stored as given. See docs/tts-speed.md.
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

const LIVEKIT_MODEL = 'livekit:ultravox/ultravox-70b';
const PIPECAT_MODEL = 'pipecat:openai/gpt-4o';

describe('options.tts.speed', () => {
  let createAgent, getAgent;
  let user, org;

  beforeAll(async () => {
    await setupRealDatabase();
    const agents = (await import('../api/paths/agents.js')).default(mockLogger, {}, {});
    createAgent = agents.POST;
    const item = (await import('../api/paths/agents/{agentId}.js')).default(mockLogger, {}, {});
    getAgent = item.GET;

    org = await Organisation.create({ id: randomUUID(), name: 'TTS Speed Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'TTS Speed Tester',
      email: `tts-speed-${randomUUID()}@example.com`,
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

  test('accepts 0.25..2 and round-trips the value', async () => {
    for (const [modelName, speed] of [[LIVEKIT_MODEL, 1.2], [PIPECAT_MODEL, 0.9], [LIVEKIT_MODEL, 0.25], [PIPECAT_MODEL, 2]]) {
      const res = await create({ modelName, prompt: 'front desk', options: { tts: { speed } } });
      expect([res.statusCode, JSON.stringify(res.body)]).toEqual([200, expect.any(String)]);
      const got = makeRes(user);
      await getAgent(makeReq({}, { agentId: res.body.id }), got);
      expect(got.body.options.tts.speed).toBe(speed);
    }
  });

  test('refuses values no vendor accepts', async () => {
    for (const speed of [0, 0.2, 2.5, '1.2']) {
      const res = await create({ modelName: LIVEKIT_MODEL, prompt: 'front desk', options: { tts: { speed } } });
      expect([res.statusCode, JSON.stringify(res.body)]).toEqual([400, expect.stringMatching(/options\.tts\.speed/)]);
    }
  });
});
