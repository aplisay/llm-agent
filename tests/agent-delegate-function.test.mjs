import {
  setupRealDatabase, teardownRealDatabase,
  Agent, AgentSet, User, Organisation,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * The `delegate` builtin at agent save time (docs/gpt-live.md): accepted on a
 * GPT-Live row with one `agent` parameter targeting a text agent, rejected
 * everywhere else and in every other shape; the GPT-Live voice list and vendor
 * rule; and the agent-set collision check between a voice member and its
 * in-set delegate. The pure helpers are tests/gpt-live-model.test.mjs.
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

const GPT_LIVE = 'pipecat:openai/gpt-live-1';
const REALTIME = 'pipecat:openai/gpt-realtime';
const TEXT_MODEL = 'text:openai/gpt-5.6-luna';

function delegateFunction(target, { name = 'brain', extra = {}, source = 'static' } = {}) {
  return {
    name,
    implementation: 'builtin',
    platform: 'delegate',
    description: 'The backend',
    input_schema: {
      type: 'object',
      properties: { agent: { type: 'string', source, from: target }, ...extra },
    },
  };
}

describe('delegate builtin validation', () => {
  let createAgent, createAgentSet;
  let user, org, textAgent, voiceAgent;

  beforeAll(async () => {
    await setupRealDatabase();
    const agents = (await import('../api/paths/agents.js')).default(mockLogger, {}, {});
    createAgent = agents.POST;
    const sets = (await import('../api/paths/agent-sets.js')).default(mockLogger, {}, {});
    createAgentSet = sets.POST;

    org = await Organisation.create({ id: randomUUID(), name: 'Delegate Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'Delegate Tester',
      email: `delegate-${randomUUID()}@example.com`,
      emailVerified: true,
      phone: '',
      phoneVerified: false,
      picture: '',
      role: 'owner',
      organisationId: org.id,
    });
    user = { id: dbUser.id, organisationId: org.id, role: 'owner' };
    textAgent = await Agent.create({
      name: 'Brain', modelName: TEXT_MODEL, type: 'text', prompt: 'You are the backend.',
      userId: user.id, organisationId: org.id,
    });
    voiceAgent = await Agent.create({
      name: 'Voice', modelName: REALTIME, type: 'interactive-audio', prompt: 'You are a voice agent.',
      userId: user.id, organisationId: org.id,
    });
  }, 60000);

  afterAll(async () => {
    await Agent.destroy({ where: { organisationId: org.id } });
    await AgentSet.destroy({ where: { organisationId: org.id } });
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

  test('accepts one delegate targeting a text agent on a GPT-Live row', async () => {
    const res = await create({ modelName: GPT_LIVE, functions: [delegateFunction(textAgent.id)] });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBeDefined();
  });

  test('accepts a metadata-sourced delegate target', async () => {
    const res = await create({ modelName: GPT_LIVE, functions: [delegateFunction('aplisay.backend', { source: 'metadata' })] });
    expect(res.statusCode).toBe(200);
  });

  test('rejects a delegate on a model without hasDelegation', async () => {
    const res = await create({ modelName: REALTIME, functions: [delegateFunction(textAgent.id)] });
    expect(res.statusCode).toBe(400);
    expect(errorText(res)).toMatch(/does not delegate to a backend agent/);
  });

  test('rejects a second delegate', async () => {
    const res = await create({
      modelName: GPT_LIVE,
      functions: [delegateFunction(textAgent.id, { name: 'brain' }), delegateFunction(textAgent.id, { name: 'brain2' })],
    });
    expect(res.statusCode).toBe(400);
    expect(errorText(res)).toMatch(/at most one delegate function/);
  });

  test('rejects any parameter other than agent', async () => {
    const res = await create({
      modelName: GPT_LIVE,
      functions: [delegateFunction(textAgent.id, { extra: { question: { type: 'string', description: 'q' } } })],
    });
    expect(res.statusCode).toBe(400);
    expect(errorText(res)).toMatch(/takes only the "agent" parameter/);
  });

  test('rejects a generated agent target and a label outside a set', async () => {
    const generated = await create({ modelName: GPT_LIVE, functions: [delegateFunction(textAgent.id, { source: 'generated' })] });
    expect(generated.statusCode).toBe(400);
    expect(errorText(generated)).toMatch(/cannot be generated/);
    const label = await create({ modelName: GPT_LIVE, functions: [delegateFunction('label:brain')] });
    expect(label.statusCode).toBe(400);
    expect(errorText(label)).toMatch(/must be an agent UUID/);
  });

  test('rejects a delegate targeting a voice agent', async () => {
    const res = await create({ modelName: GPT_LIVE, functions: [delegateFunction(voiceAgent.id)] });
    expect(res.statusCode).toBe(400);
    expect(errorText(res)).toMatch(/must target a text agent/);
  });

  test('validates the voice against the GPT-Live list and accepts only the openai vendor', async () => {
    const marin = await create({ modelName: GPT_LIVE, options: { tts: { voice: 'marin' } } });
    expect(marin.statusCode).toBe(200);
    const openai = await create({ modelName: GPT_LIVE, options: { tts: { vendor: 'openai', voice: 'cedar' } } });
    expect(openai.statusCode).toBe(200);
    // A Realtime-only voice name is not accepted by the Live API.
    const onyx = await create({ modelName: GPT_LIVE, options: { tts: { voice: 'onyx' } } });
    expect(onyx.statusCode).toBe(400);
    expect(errorText(onyx)).toMatch(/Voice onyx not supported/);
    // No text-output mode: an external TTS vendor is rejected with the fix in the message.
    const external = await create({ modelName: GPT_LIVE, options: { tts: { vendor: 'elevenlabs', voice: 'Rachel' } } });
    expect(external.statusCode).toBe(400);
    expect(errorText(external)).toMatch(/set it to "openai"/);
  });

  describe('agent sets', () => {
    const setDocument = ({ voiceFunctions = [], brainFunctions = [] } = {}) => ({
      name: 'Acme Dental reception',
      agents: [
        {
          label: 'voice',
          name: 'Sam',
          modelName: GPT_LIVE,
          prompt: 'You are Sam.',
          functions: [delegateFunction('label:brain'), ...voiceFunctions],
        },
        {
          label: 'brain',
          name: 'Brain',
          type: 'text',
          modelName: TEXT_MODEL,
          prompt: 'You book appointments.',
          functions: brainFunctions,
        },
      ],
    });
    const restFunction = (name) => ({ name, implementation: 'rest', url: 'https://example.com/x', description: name, input_schema: { type: 'object', properties: {} } });

    test('resolves a label: delegate reference to the text member', async () => {
      const res = makeRes(user);
      await createAgentSet(makeReq(setDocument({ voiceFunctions: [restFunction('get_slots')], brainFunctions: [restFunction('book_slot')] })), res);
      expect(res.statusCode).toBe(200);
      const voice = res.body.agents.find((a) => a.label === 'voice');
      const brain = res.body.agents.find((a) => a.label === 'brain');
      const param = voice.functions.find((f) => f.platform === 'delegate').input_schema.properties.agent;
      expect(param.from).toBe(brain.id);
      expect(param.fromLabel).toBe('brain');
    });

    test('rejects a voice member and its delegate declaring the same function name', async () => {
      const res = makeRes(user);
      await createAgentSet(makeReq(setDocument({ voiceFunctions: [restFunction('get_slots')], brainFunctions: [restFunction('get_slots')] })), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/both agents declare a function named "get_slots"/);
    });

    test('rejects a delegate reference to a voice member', async () => {
      const doc = setDocument();
      doc.agents[1] = { label: 'brain', name: 'Other voice', modelName: REALTIME, prompt: 'Voice.' };
      const res = makeRes(user);
      await createAgentSet(makeReq(doc), res);
      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/must target a text agent/);
    });
  });
});
