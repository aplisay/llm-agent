import {
  setupRealDatabase, teardownRealDatabase,
  Agent, AgentSet, User, Organisation, UsageRecord,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import { readFileSync } from 'node:fs';

// The key makes the row load; the driver never reaches the network here (fetch is stubbed).
process.env.TYPESAFE_API_KEY ||= 'test-key';
const { default: Typesafe } = await import('../lib/models/typesafe.js');

/**
 * The decision row at agent save time (docs/typesafe-jev.md): a pinned id
 * with one answerable `result` function saves as a text agent; every other
 * shape, tool, MCP server and voice option is refused with the fix in the
 * message; `options.decision` is refused elsewhere; a decision agent is
 * refused as a `delegate` target and as a hand-back `summaryAgent`, and by
 * the chat route; `GET /models` carries `kind`; and `/invoke` returns the
 * documented result and meters it under provider typesafe. The pure rules are
 * tests/typesafe-model.test.mjs.
 */

const SIX = JSON.parse(readFileSync(new URL('./fixtures/typesafe/six-questions.json', import.meta.url), 'utf8'));

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

const JEV = 'text:typesafe/jev-1.13.0';
const TEXT_MODEL = 'text:openai/gpt-5.6-luna';
const GPT_LIVE = 'pipecat:openai/gpt-live-1';
const PIPELINE = 'pipecat:openai/gpt-4o';

const SIX_PROPERTIES = {
  outcome: {
    type: 'string', description: 'How did the call end for the caller?',
    enum: ['resolved', 'partially_resolved', 'unresolved', 'transferred', 'abandoned', 'wrong_number'],
    'x-descriptions': {
      resolved: 'The caller got what they called for',
      transferred: 'The call was handed to a person or another agent',
      abandoned: 'The caller gave up or hung up before the matter was dealt with',
    },
  },
  needs_followup: { type: 'boolean', description: 'Does someone need to contact this caller again?' },
  caller_sentiment: { type: 'string', description: "The caller's tone by the end of the call", 'x-levels': ['angry', 'frustrated', 'neutral', 'satisfied', 'delighted'] },
  agent_error: { type: 'boolean', description: 'Did the agent give wrong or misleading information?' },
  policy_breach: { type: 'boolean', description: 'Did the agent do something its instructions forbid?' },
  escalation_missed: {
    type: 'boolean', description: 'Did the caller ask for a human and not get one?',
    'x-criteria': { true: 'The caller asked for a person and the call ended without a transfer', false: 'No request for a person, or the caller was transferred' },
  },
};

const resultFunction = (properties = SIX_PROPERTIES, name = 'analyse') => ({
  name, implementation: 'builtin', platform: 'result', description: 'The answers',
  input_schema: { type: 'object', properties },
});
const restFunction = (name) => ({
  name, implementation: 'rest', url: 'https://example.com/hook', description: name,
  input_schema: { type: 'object', properties: {} },
});
const delegateFunction = (target) => ({
  name: 'brain', implementation: 'builtin', platform: 'delegate', description: 'The backend',
  input_schema: { type: 'object', properties: { agent: { type: 'string', source: 'static', from: target } } },
});

async function waitFor(check, { attempts = 50, delayMs = 20 } = {}) {
  for (let i = 0; i < attempts; i++) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return check();
}

describe('decision models at agent save time', () => {
  let createAgent, agentChat, agentInvoke, modelList, createAgentSet;
  let user, org, decisionAgent, textAgent, voiceAgent;

  beforeAll(async () => {
    await setupRealDatabase();
    createAgent = (await import('../api/paths/agents.js')).default(mockLogger, {}, {}).POST;
    agentChat = (await import('../api/paths/agents/{agentId}/chat.js')).default(mockLogger).POST;
    agentInvoke = (await import('../api/paths/agents/{agentId}/invoke.js')).default(mockLogger).POST;
    modelList = (await import('../api/paths/models.js')).default(mockLogger).GET;
    createAgentSet = (await import('../api/paths/agent-sets.js')).default(mockLogger, {}, {}).POST;
    org = await Organisation.create({ id: randomUUID(), name: 'Jev Test Org' });
    const dbUser = await User.create({
      id: randomUUID(),
      name: 'Jev Tester',
      email: `jev-${randomUUID()}@example.com`,
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
      name: 'Voice', modelName: PIPELINE, type: 'interactive-audio', prompt: 'You are a voice agent.',
      userId: user.id, organisationId: org.id,
    });
  }, 60000);

  afterAll(async () => {
    await UsageRecord.destroy({ where: { organisationId: org.id } });
    await Agent.destroy({ where: { organisationId: org.id } });
    await AgentSet.destroy({ where: { organisationId: org.id } });
    await User.destroy({ where: { organisationId: org.id } });
    await Organisation.destroy({ where: { id: org.id } });
    await teardownRealDatabase();
  }, 60000);

  const create = async (body) => {
    const res = makeRes(user);
    await createAgent(makeReq({ name: 'Analyst', prompt: SIX.request.state.instructions, ...body }), res);
    return res;
  };
  const errorText = (res) => (Array.isArray(res.body) ? res.body.join('; ') : `${res.body?.message ?? JSON.stringify(res.body)}`);
  const expectRejected = async (body, pattern) => {
    const res = await create(body);
    expect(res.statusCode).toBe(400);
    expect(errorText(res)).toMatch(pattern);
  };

  test('the spec question set saves as a text agent, with and without options.decision', async () => {
    const res = await create({ modelName: JEV, functions: [resultFunction()] });
    expect(res.statusCode).toBe(200);
    expect(res.body.type).toBe('text');
    decisionAgent = res.body;
    const gated = await create({ modelName: JEV, functions: [resultFunction()], options: { decision: { minConfidence: 0.7 } } });
    expect(gated.statusCode).toBe(200);
    expect(gated.body.options.decision.minConfidence).toBe(0.7);
    // functions as an object keyed by name save too
    const keyed = await create({ modelName: JEV, functions: { analyse: resultFunction() } });
    expect(keyed.statusCode).toBe(200);
  });

  test('a free-string property is refused with the message', async () => {
    await expectRejected({ modelName: JEV, functions: [resultFunction({ ...SIX_PROPERTIES, notes: { type: 'string', description: 'Notes' } })] },
      /notes: a decision model can answer an enum \(Choice\), a boolean \(Noul\) or x-levels \(Score\); a free string is not answerable/);
    await expectRejected({ modelName: JEV, functions: [resultFunction({ score: { type: 'number', description: 'n' } })] }, /type "number" is not answerable/);
    await expectRejected({ modelName: JEV, functions: [resultFunction({ mood: { type: 'string', description: 'm', enum: ['a', 'b'], 'x-levels': ['a', 'b'] } })] }, /cannot both be set/);
    await expectRejected({ modelName: JEV, functions: [resultFunction({ mood: { type: 'string', description: 'm', enum: ['only'] } })] }, /between 2 and 255/);
    await expectRejected({ modelName: JEV, functions: [resultFunction({ mood: { type: 'string', description: 'm', 'x-levels': Array.from({ length: 11 }, (_, i) => `l${i}`) } })] }, /between 2 and 10/);
    await expectRejected({ modelName: JEV, functions: [resultFunction({ confidence: { type: 'boolean', description: 'c' } })] }, /confidence: reserved/);
    await expectRejected({ modelName: JEV, functions: [resultFunction({ urgent: { type: 'boolean' } })] }, /description is required/);
    await expectRejected({ modelName: JEV, functions: [resultFunction({ urgent: { type: 'boolean', description: 'u', source: 'static', from: 'x' } })] }, /source must be "generated"/);
  });

  test('pinned ids only: jev-latest is refused', async () => {
    await expectRejected({ modelName: 'text:typesafe/jev-latest', functions: [resultFunction()] }, /not an offered decision model: pinned ids only/);
  });

  test('other functions, a second result function and MCP servers are refused', async () => {
    await expectRejected({ modelName: JEV, functions: [resultFunction(), restFunction('lookup')] }, /has no tool loop.*remove "lookup"/);
    await expectRejected({ modelName: JEV, functions: [resultFunction(SIX_PROPERTIES, 'a'), resultFunction(SIX_PROPERTIES, 'b')] }, /exactly one builtin function with platform "result"/);
    await expectRejected({ modelName: JEV, functions: [] }, /exactly one builtin function/);
    await expectRejected({ modelName: JEV, functions: [resultFunction()], mcpServers: [{ name: 'kb', url: 'https://example.com/mcp' }] }, /mcpServers are not accepted/);
  });

  test('voice options and a malformed options.decision are refused', async () => {
    await expectRejected({ modelName: JEV, functions: [resultFunction()], options: { greeting: { text: 'Hello' } } }, /options.greeting is not accepted on a decision model/);
    await expectRejected({ modelName: JEV, functions: [resultFunction()], options: { tts: { vendor: 'elevenlabs' } } }, /options.tts is not accepted/);
    await expectRejected({ modelName: JEV, functions: [resultFunction()], options: { callHook: { url: 'https://example.com/hook' } } }, /options.callHook is not accepted/);
    await expectRejected({ modelName: JEV, functions: [resultFunction()], options: { decision: { minConfidence: 2 } } }, /minConfidence must be a number between 0 and 1/);
    await expectRejected({ modelName: JEV, functions: [resultFunction()], options: { decision: { threshold: 0.5 } } }, /unknown field\(s\) threshold/);
  });

  test('options.decision is refused on a generative model', async () => {
    await expectRejected({ modelName: TEXT_MODEL, options: { decision: { minConfidence: 0.5 } } }, /options.decision is accepted only on decision models/);
    const plain = await create({ modelName: TEXT_MODEL, functions: [resultFunction({ notes: { type: 'string', description: 'free' } })] });
    expect(plain.statusCode).toBe(200);
  });

  test('a decision agent is refused as a delegate target and as a hand-back summaryAgent, accepted as a subagent target', async () => {
    const delegate = await create({ modelName: GPT_LIVE, prompt: 'You are Sam.', functions: [delegateFunction(decisionAgent.id)] });
    expect(delegate.statusCode).toBe(400);
    expect(errorText(delegate)).toMatch(/cannot target a decision model agent/);
    const ok = await create({ modelName: GPT_LIVE, prompt: 'You are Sam.', functions: [delegateFunction(textAgent.id)] });
    expect(ok.statusCode).toBe(200);

    const handback = (summaryAgent) => ({
      modelName: PIPELINE, prompt: 'You are Sam.',
      options: { bridgedTransferToAgent: { 1: { agent: voiceAgent.id, summaryAgent } } },
    });
    const summary = await create(handback(decisionAgent.id));
    expect(summary.statusCode).toBe(400);
    expect(errorText(summary)).toMatch(/summaryAgent cannot target a decision model agent/);
    const summaryOk = await create(handback(textAgent.id));
    expect(summaryOk.statusCode).toBe(200);

    const subagent = await create({
      modelName: PIPELINE, prompt: 'You are Sam.',
      functions: [{
        name: 'classify', implementation: 'builtin', platform: 'subagent', description: 'Classify the caller',
        input_schema: { type: 'object', properties: { agent: { type: 'string', source: 'static', from: decisionAgent.id }, transcript: { type: 'string', description: 'The conversation so far', required: true } } },
      }],
    });
    expect(subagent.statusCode).toBe(200);
  });

  test('inside an agent set a decision member is refused as a delegate target by label', async () => {
    const res = makeRes(user);
    await createAgentSet(makeReq({
      name: 'Reception',
      agents: [
        { label: 'voice', name: 'Sam', modelName: GPT_LIVE, prompt: 'You are Sam.', functions: [{ ...delegateFunction('label:classifier') }] },
        { label: 'classifier', name: 'Classifier', type: 'text', modelName: JEV, prompt: 'Judge the call.', functions: [resultFunction()] },
      ],
    }), res);
    expect(res.statusCode).toBe(400);
    expect(errorText(res)).toMatch(/cannot target a decision model agent/);
  });

  test('the chat route refuses a decision agent and a decision model override', async () => {
    const res = makeRes(user);
    await agentChat(makeReq({}, { agentId: decisionAgent.id }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/decision model .* has no chat; invoke it with POST \/agents\//);
    const override = makeRes(user);
    await agentChat(makeReq({ model: JEV }, { agentId: textAgent.id }), override);
    expect(override.statusCode).toBe(400);
    expect(override.body.message).toMatch(/Decision models have no chat/);
  });

  test('GET /models carries kind on every row and marks the Jev row decision', async () => {
    const res = makeRes(user);
    await modelList(makeReq(), res);
    expect(res.statusCode).toBe(200);
    for (const row of Object.values(res.body)) {
      expect(['generative', 'decision']).toContain(row.kind);
    }
    expect(res.body[JEV]).toMatchObject({ kind: 'decision', supportsFunctions: true, supportsMcp: false, description: 'TypeSafe Jev 1.13 (decision model)' });
    expect(res.body[TEXT_MODEL].kind).toBe('generative');
  });

  test('POST /agents/{id}/invoke returns the documented result and meters it under provider typesafe', async () => {
    const calls = [];
    Typesafe.fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, headers: new Headers({ 'x-typesafe-request-id': 'req_invoke' }), text: async () => JSON.stringify(SIX.response) };
    };
    try {
      const res = makeRes(user);
      await agentInvoke(makeReq({ input: SIX.request.state.input }, { agentId: decisionAgent.id }), res);
      expect(res.statusCode).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].body.questions).toEqual(SIX.request.questions);
      expect(res.body.complete).toBe(true);
      const answers = SIX.response.answers;
      expect(res.body.result).toMatchObject({ outcome: answers.outcome.choice, escalation_missed: answers.escalation_missed.noul });
      expect(res.body.result.confidence).toEqual({ outcome: answers.outcome.confidence, caller_sentiment: answers.caller_sentiment.confidence });
      expect(Object.keys(res.body.result.probabilities.caller_sentiment)).toEqual(SIX_PROPERTIES.caller_sentiment['x-levels']);
      expect(res.body.result).not.toHaveProperty('decision');
      expect(res.body.transcript).toEqual([{ function_calls: [{ name: 'analyse', input: res.body.result }] }]);
      const rows = await waitFor(async () => {
        const found = await UsageRecord.findAll({ where: { organisationId: org.id, provider: 'typesafe' } });
        return found.length === 2 ? found : null;
      });
      expect(rows).toHaveLength(2);
      // quantity is a BIGINT column, read back as a string.
      const byUnit = Object.fromEntries(rows.map((r) => [r.unit, { ...r.get({ plain: true }), quantity: Number(r.quantity) }]));
      expect(byUnit.input_tokens).toMatchObject({ technology: 'llm', provider: 'typesafe', detail: 'jev-1.13.0', quantity: SIX.response.usage.input_tokens, finalised: true, agentId: decisionAgent.id, organisationId: org.id });
      expect(byUnit.output_tokens).toMatchObject({ technology: 'llm', provider: 'typesafe', detail: 'jev-1.13.0', quantity: SIX.response.usage.output_tokens, finalised: true });
    } finally {
      Typesafe.fetchImpl = undefined;
    }
  });

  test('POST /agents/{id}/invoke answers 502 with the vendor detail when the exchange fails', async () => {
    Typesafe.fetchImpl = async () => ({ ok: false, status: 422, headers: new Headers({ 'x-typesafe-request-id': 'req_bad' }), text: async () => JSON.stringify({ detail: [{ loc: ['body', 'state'], msg: 'Field required', type: 'missing' }] }) });
    try {
      const res = makeRes(user);
      await agentInvoke(makeReq({ input: SIX.request.state.input }, { agentId: decisionAgent.id }), res);
      expect(res.statusCode).toBe(502);
      expect(res.body.message).toMatch(/HTTP 422: .*Field required/);
    } finally {
      Typesafe.fetchImpl = undefined;
    }
  });
});
