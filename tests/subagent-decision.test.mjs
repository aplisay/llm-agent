// The decision short path in runSubagent (docs/typesafe-jev.md): a
// decision-kind driver gets the raw result function and input, is asked to
// decide() once, and its result, transcript and usage come back unchanged
// with no chat harness, no nudge loop and no function dispatch.
import { readFileSync } from 'node:fs';
import { runSubagent, SubagentError } from '../lib/subagent.js';

process.env.TYPESAFE_API_KEY ||= 'test-key';
const { default: Typesafe } = await import('../lib/models/typesafe.js');

const SIX = JSON.parse(readFileSync(new URL('./fixtures/typesafe/six-questions.json', import.meta.url), 'utf8'));

const mockLogger = {
  info: () => { }, warn: () => { }, error: () => { }, debug: () => { }, child: () => mockLogger,
};

const resultFunction = {
  name: 'analyse',
  implementation: 'builtin',
  platform: 'result',
  description: 'The answers',
  input_schema: {
    type: 'object',
    properties: {
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
    },
  },
};

const decisionAgent = (overrides = {}) => ({
  id: '11111111-2222-3333-4444-555555555555',
  type: 'text',
  modelName: 'text:typesafe/jev-1.13.0',
  organisationId: 'org-1',
  prompt: SIX.request.state.instructions,
  keys: [],
  functions: [resultFunction],
  ...overrides,
});

/** A stub decision driver that records what it was built with. */
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
    async decide() {
      seen.decideCalls = (seen.decideCalls || 0) + 1;
      return decide();
    }
    async close() {
      seen.closed = true;
      close?.();
    }
  }
  return { StubDecision, seen };
}

describe('runSubagent decision short path', () => {
  test('returns the driver result and transcript, complete, with the usage accumulated', async () => {
    const answer = { outcome: 'abandoned', needs_followup: 0.91, confidence: { outcome: 0.81 }, probabilities: { outcome: { abandoned: 0.81 } } };
    const { StubDecision, seen } = stubImplementation({
      decide: () => ({
        result: answer,
        transcript: [{ function_calls: [{ name: 'analyse', input: answer }] }],
        usage: { provider: 'typesafe', model: 'jev-1.13.0', inputTokens: 412, outputTokens: 34, cacheReadTokens: 0, cacheWriteTokens: 0 },
      }),
    });
    const agent = decisionAgent();
    const input = SIX.request.state.input;
    const out = await runSubagent({ agent, input, metadata: { aplisay: { callerId: '+441234' } }, logger: mockLogger, implementationOverride: StubDecision });
    expect(out).toEqual({
      result: answer,
      complete: true,
      transcript: [{ function_calls: [{ name: 'analyse', input: answer }] }],
      usage: [{ agentId: agent.id, provider: 'typesafe', model: 'jev-1.13.0', inputTokens: 412, outputTokens: 34, cacheReadTokens: 0, cacheWriteTokens: 0 }],
    });
    // The driver saw the bare prompt (no subagent harness), the full schema and the untouched input.
    expect(seen.args.prompt).toBe(agent.prompt);
    expect(seen.args.prompt).not.toMatch(/headlessly/);
    expect(seen.args.rawFunctions).toBe(agent.functions);
    expect(seen.args.rawInput).toBe(input);
    expect(seen.args.modelName).toBe(agent.modelName);
    expect(seen.decideCalls).toBe(1);
    expect(seen.completionCalled).toBeUndefined();
    expect(seen.closed).toBe(true);
  });

  test('a prompt-less agent passes an empty prompt, and keyed functions are listed', async () => {
    const { StubDecision, seen } = stubImplementation({ decide: () => ({ result: {}, transcript: [], usage: undefined }) });
    const agent = decisionAgent({ prompt: undefined, functions: { analyse: resultFunction } });
    const out = await runSubagent({ agent, input: 'text', logger: mockLogger, implementationOverride: StubDecision });
    expect(seen.args.prompt).toBe('');
    expect(seen.args.rawFunctions).toEqual([resultFunction]);
    expect(out.usage).toEqual([]);
  });

  test('driver errors with a status become SubagentError with that status and detail', async () => {
    const { StubDecision, seen } = stubImplementation({
      decide: () => { throw Object.assign(new Error('decision request failed with HTTP 529'), { status: 502, vendorStatus: 529, requestId: 'req_x', detail: 'overloaded' }); },
    });
    const err = await runSubagent({ agent: decisionAgent(), input: {}, logger: mockLogger, implementationOverride: StubDecision }).catch((e) => e);
    expect(err).toBeInstanceOf(SubagentError);
    expect(err).toMatchObject({ status: 502, vendorStatus: 529, requestId: 'req_x', detail: 'overloaded', usage: [] });
    expect(seen.closed).toBe(true);
    const schema = stubImplementation({ decide: () => { throw Object.assign(new Error('notes: a free string is not answerable'), { status: 400 }); } });
    await expect(runSubagent({ agent: decisionAgent(), input: {}, logger: mockLogger, implementationOverride: schema.StubDecision }))
      .rejects.toMatchObject({ status: 400, name: 'SubagentError' });
    // An error without a status is not disguised as a client or vendor failure.
    const bug = stubImplementation({ decide: () => { throw new TypeError('boom'); } });
    await expect(runSubagent({ agent: decisionAgent(), input: {}, logger: mockLogger, implementationOverride: bug.StubDecision }))
      .rejects.toMatchObject({ name: 'TypeError', message: 'boom' });
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
      expect(usage).toEqual([{
        agentId: agent.id, provider: 'typesafe', model: 'jev-1.13.0',
        inputTokens: SIX.response.usage.input_tokens, outputTokens: SIX.response.usage.output_tokens,
        cacheReadTokens: 0, cacheWriteTokens: 0,
      }]);
    } finally {
      Typesafe.fetchImpl = undefined;
    }
  });
});
