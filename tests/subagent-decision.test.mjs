// The decision short path in runSubagent (docs/typesafe-jev.md): a
// decision-kind driver is asked to decide() once with the full result
// function and the untouched input, and its result, transcript and usage
// come back unchanged with no chat harness, no nudge loop and no function
// dispatch. Errors keep their status and any usage the vendor billed.
import { runSubagent, SubagentError } from '../lib/subagent.js';

process.env.TYPESAFE_API_KEY ||= 'test-key';
const { default: Typesafe } = await import('../lib/models/typesafe.js');
const { SIX, SIX_PROPERTIES, resultFunction } = await import('./fixtures/typesafe/six-questions.mjs');

const mockLogger = {
  info: () => { }, warn: () => { }, error: () => { }, debug: () => { }, child: () => mockLogger,
};

const analyse = resultFunction(SIX_PROPERTIES);

const decisionAgent = (overrides = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  type: 'text',
  modelName: 'text:typesafe/jev-1.13.0',
  organisationId: 'org-1',
  prompt: SIX.request.state.instructions,
  keys: [],
  functions: [analyse],
  ...overrides,
});

/** A stub decision driver that records what it was built and called with. */
function stubImplementation({ decide, close } = {}) {
  const seen = {};
  class StubDecision {
    static kind = 'decision';
    constructor(args) {
      seen.args = args;
    }
    async completion() {
      seen.completionCalled = true;
      throw new Error('decision model: use decide()');
    }
    async decide(args) {
      seen.decideCalls = (seen.decideCalls || 0) + 1;
      seen.decideArgs = args;
      return decide(args);
    }
    async close() {
      seen.closed = true;
      close?.();
    }
  }
  return { StubDecision, seen };
}

const usageEntry = (inputTokens = 412, outputTokens = 34) => ({ provider: 'typesafe', model: 'jev-1.13.0', inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 });

describe('runSubagent decision short path', () => {
  test('returns the driver result and transcript, complete, with the usage accumulated', async () => {
    const answer = { outcome: 'abandoned', needs_followup: 0.91, confidence: { outcome: 0.81 }, probabilities: { outcome: { abandoned: 0.81 } } };
    const { StubDecision, seen } = stubImplementation({
      decide: () => ({ result: answer, transcript: [{ function_calls: [{ name: 'analyse', input: answer }] }], usage: usageEntry() }),
    });
    const agent = decisionAgent();
    const input = SIX.request.state.input;
    const out = await runSubagent({ agent, input, metadata: { aplisay: { callerId: '+441234' } }, logger: mockLogger, implementationOverride: StubDecision });
    expect(out).toEqual({
      result: answer,
      complete: true,
      transcript: [{ function_calls: [{ name: 'analyse', input: answer }] }],
      usage: [{ agentId: agent.id, ...usageEntry() }],
    });
    // The driver saw the bare prompt (no subagent harness) and was asked to decide on the full schema and the untouched input.
    expect(seen.args.prompt).toBe(agent.prompt);
    expect(seen.args.prompt).not.toMatch(/headlessly/);
    expect(seen.args).not.toHaveProperty('rawFunctions');
    expect(seen.args).not.toHaveProperty('rawInput');
    expect(seen.args.modelName).toBe(agent.modelName);
    expect(seen.decideArgs).toEqual({ functions: [analyse], input });
    expect(seen.decideCalls).toBe(1);
    expect(seen.completionCalled).toBeUndefined();
    expect(seen.closed).toBe(true);
  });

  test('a prompt-less agent passes an empty prompt, and keyed functions carry their key as the name', async () => {
    const { StubDecision, seen } = stubImplementation({ decide: () => ({ result: {}, transcript: [], usage: undefined }) });
    const { name, ...nameless } = analyse;
    const agent = decisionAgent({ prompt: undefined, functions: { analyse: nameless } });
    const out = await runSubagent({ agent, input: 'text', logger: mockLogger, implementationOverride: StubDecision });
    expect(seen.args.prompt).toBe('');
    expect(seen.decideArgs.functions).toEqual([{ ...nameless, name: 'analyse' }]);
    expect(seen.decideArgs.input).toBe('text');
    expect(out.usage).toEqual([]);
  });

  test('driver errors with a status become SubagentError with that status and request id', async () => {
    const { StubDecision, seen } = stubImplementation({
      decide: () => { throw Object.assign(new Error('decision request failed with HTTP 529'), { status: 502, vendorStatus: 529, requestId: 'req_x' }); },
    });
    const err = await runSubagent({ agent: decisionAgent(), input: {}, logger: mockLogger, implementationOverride: StubDecision }).catch((e) => e);
    expect(err).toBeInstanceOf(SubagentError);
    expect(err).toMatchObject({ status: 502, requestId: 'req_x', usage: [] });
    expect(seen.closed).toBe(true);
    const schema = stubImplementation({ decide: () => { throw Object.assign(new Error('notes: a free string is not answerable'), { status: 400 }); } });
    await expect(runSubagent({ agent: decisionAgent(), input: {}, logger: mockLogger, implementationOverride: schema.StubDecision }))
      .rejects.toMatchObject({ status: 400, name: 'SubagentError' });
    // An error without a status is not disguised as a client or vendor failure.
    const bug = stubImplementation({ decide: () => { throw new TypeError('boom'); } });
    await expect(runSubagent({ agent: decisionAgent(), input: {}, logger: mockLogger, implementationOverride: bug.StubDecision }))
      .rejects.toMatchObject({ name: 'TypeError', message: 'boom' });
  });

  test('usage the driver attaches to an error is metered on the error', async () => {
    const { StubDecision } = stubImplementation({
      decide: () => { throw Object.assign(new Error('the decision model chose "x"'), { status: 502, usage: usageEntry(77, 5) }); },
    });
    const agent = decisionAgent();
    const err = await runSubagent({ agent, input: {}, logger: mockLogger, implementationOverride: StubDecision }).catch((e) => e);
    expect(err).toBeInstanceOf(SubagentError);
    expect(err.usage).toEqual([{ agentId: agent.id, ...usageEntry(77, 5) }]);
  });

  test('the real driver through the runner: one POST, the documented result, usage under the stripped id', async () => {
    const calls = [];
    Typesafe.fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { ok: true, status: 200, headers: new Headers({ 'x-typesafe-request-id': 'req_run' }), text: async () => JSON.stringify(SIX.response) };
    };
    try {
      const answers = SIX.response.answers;
      // Gate the Choice only: just above its confidence.
      const agent = decisionAgent({ options: { decision: { minConfidence: answers.outcome.confidence + 0.001 } } });
      const { result, complete, transcript, usage } = await runSubagent({
        agent, input: SIX.request.state.input, logger: mockLogger, implementationOverride: Typesafe,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({ model: 'jev-1.13.0', state: SIX.request.state, questions: SIX.request.questions });
      expect(complete).toBe(true);
      expect(result).toMatchObject({ outcome: null, escalation_missed: answers.escalation_missed.noul, decision: 'review' });
      expect(result.confidence.outcome).toBe(answers.outcome.confidence);
      expect(transcript).toEqual([{ function_calls: [{ name: 'analyse', input: result }] }]);
      expect(usage).toEqual([{ agentId: agent.id, ...usageEntry(SIX.response.usage.input_tokens, SIX.response.usage.output_tokens) }]);
    } finally {
      Typesafe.fetchImpl = undefined;
    }
  });

  test('the real driver through the runner: a billed body whose answers do not fit meters the tokens on the error', async () => {
    const answers = { ...SIX.response.answers, outcome: { ...SIX.response.answers.outcome, choice: 'elsewhere' } };
    Typesafe.fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify({ ...SIX.response, answers }) });
    try {
      const agent = decisionAgent();
      const err = await runSubagent({ agent, input: SIX.request.state.input, logger: mockLogger, implementationOverride: Typesafe }).catch((e) => e);
      expect(err).toMatchObject({ name: 'SubagentError', status: 502, message: /chose "elsewhere"/ });
      expect(err.usage).toEqual([{ agentId: agent.id, ...usageEntry(SIX.response.usage.input_tokens, SIX.response.usage.output_tokens) }]);
    } finally {
      Typesafe.fetchImpl = undefined;
    }
  });
});
