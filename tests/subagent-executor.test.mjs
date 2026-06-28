import { jest } from '@jest/globals';
import { runSubagent, SubagentError } from '../lib/subagent.js';
import { functionHandler } from '../lib/function-handler.js';

/**
 * Headless text-agent executor: drives a scripted fake LLM through the
 * tool-use loop and checks termination via the builtin `result` platform
 * function, plus the function-handler `subagent` builtin dispatch.
 */

const mockLogger = {
  info: () => { },
  warn: () => { },
  error: () => { },
  debug: () => { },
  child: () => mockLogger
};

/** Build a fake Llm implementation that replays a script of turns. */
function fakeImplementation(script) {
  const seen = { completions: [], callResults: [] };
  class FakeLlm {
    constructor({ prompt, functions }) {
      seen.prompt = prompt;
      seen.functions = functions;
    }
    async completion(input) {
      seen.completions.push(input);
      return script.shift();
    }
    async callResult(results) {
      seen.callResults.push(results);
      return script.shift();
    }
  }
  return { FakeLlm, seen };
}

const textAgent = (functions) => ({
  id: '11111111-2222-3333-4444-555555555555',
  type: 'text',
  modelName: 'text:openai/gpt-4o',
  organisationId: 'org-1',
  prompt: 'You are a researcher.',
  keys: [],
  functions
});

const resultFunction = {
  name: 'deliver_result',
  implementation: 'builtin',
  platform: 'result',
  description: 'Deliver the answer',
  input_schema: {
    type: 'object',
    properties: {
      answer: { type: 'string', description: 'the answer', required: true }
    }
  }
};

const stubFunction = {
  name: 'lookup',
  implementation: 'stub',
  description: 'Look something up',
  result: 'the answer to {q} is 42',
  input_schema: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'query', required: true }
    }
  }
};

describe('subagent executor', () => {
  test('terminates when the agent calls its result function', async () => {
    const { FakeLlm, seen } = fakeImplementation([
      { text: 'Let me look that up.', calls: [{ name: 'lookup', id: '1', input: { q: 'meaning' } }] },
      { calls: [{ name: 'deliver_result', id: '2', input: { answer: '42' } }] }
    ]);

    const { result, complete, transcript } = await runSubagent({
      agent: textAgent([resultFunction, stubFunction]),
      input: { question: 'what is the meaning of life?' },
      logger: mockLogger,
      implementationOverride: FakeLlm
    });

    expect(complete).toBe(true);
    expect(result).toEqual({ answer: '42' });
    // The stub function was dispatched through the shared function handler
    expect(seen.callResults).toHaveLength(1);
    expect(seen.callResults[0][0].result).toBe('the answer to meaning is 42');
    // Task input was delivered as the first user message
    expect(seen.completions[0]).toMatch(/what is the meaning of life/);
    // The harness told the model how to terminate
    expect(seen.prompt).toMatch(/deliver_result/);
    // The LLM-facing function list hides the platform/result plumbing details
    expect(seen.functions.find((f) => f.name === 'deliver_result').input_schema.required).toEqual(['answer']);
    expect(transcript.length).toBeGreaterThan(0);
  });

  test('falls back to plain text when the agent has no result function', async () => {
    const { FakeLlm } = fakeImplementation([
      { text: 'The answer is 42.' }
    ]);
    const { result, complete } = await runSubagent({
      agent: textAgent([]),
      input: 'what is the answer?',
      logger: mockLogger,
      implementationOverride: FakeLlm
    });
    expect(complete).toBe(true);
    expect(result).toEqual({ text: 'The answer is 42.' });
  });

  test('nudges a stalled agent, then gives up incomplete at the turn limit', async () => {
    const { FakeLlm, seen } = fakeImplementation([
      { text: 'Working on it...' },
      { text: 'Still thinking...' },
      { text: 'Nearly there...' }
    ]);
    const { result, complete } = await runSubagent({
      agent: textAgent([resultFunction]),
      input: { question: 'q' },
      logger: mockLogger,
      maxTurns: 3,
      implementationOverride: FakeLlm
    });
    expect(complete).toBe(false);
    expect(result).toEqual({ text: 'Nearly there...' });
    // The first turn was the task, the rest were nudges
    expect(seen.completions).toHaveLength(3);
    expect(seen.completions[1]).toMatch(/result function/);
  });

  test('refuses to run a non-text agent', async () => {
    await expect(runSubagent({
      agent: { ...textAgent([]), type: 'interactive-audio', modelName: 'livekit:ultravox/ultravox-70b' },
      input: {},
      logger: mockLogger
    })).rejects.toThrow(SubagentError);
  });
});

describe('function-handler subagent builtin', () => {
  const subagentFunction = {
    name: 'ask_researcher',
    implementation: 'builtin',
    platform: 'subagent',
    description: 'Ask the researcher',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', source: 'static', from: '99999999-8888-7777-6666-555555555555' },
        question: { type: 'string', description: 'question', required: true }
      }
    }
  };

  test('dispatches through an injected invoker with resolved parameters', async () => {
    const invokeSubagent = jest.fn(async (agentId, args) => ({ answer: `${args.question} -> 42` }));
    const messages = [];

    const { function_results } = await functionHandler(
      [{ name: 'ask_researcher', input: { question: 'meaning?' } }],
      [subagentFunction],
      [],
      (m) => messages.push(m),
      {},
      {},
      { invokeSubagent }
    );

    // Note: the third (metadata) argument is the live metadata object, which the
    // function handler also primes with toolsCalls after the invocation.
    const [agentId, args] = invokeSubagent.mock.calls[0];
    expect(agentId).toBe('99999999-8888-7777-6666-555555555555');
    expect(args).toEqual({ question: 'meaning?' });
    expect(JSON.parse(function_results[0].result)).toEqual({ answer: 'meaning? -> 42' });
  });

  test('throws (does not return to the model) when no invoker and no SERVICE_BASE_URI', async () => {
    const previous = process.env.SERVICE_BASE_URI;
    delete process.env.SERVICE_BASE_URI;
    try {
      // Missing service config is an infrastructure error the model can't fix by
      // retrying, so the handler lets it propagate and abort the turn rather than
      // feeding it back as a tool result (see lib/errors.js → InfrastructureError).
      await expect(functionHandler(
        [{ name: 'ask_researcher', input: { question: 'meaning?' } }],
        [subagentFunction],
        [],
        () => { },
        {},
        {},
        {}
      )).rejects.toThrow(/SERVICE_BASE_URI/);
    } finally {
      previous !== undefined && (process.env.SERVICE_BASE_URI = previous);
    }
  });

  test('returns model-fixable invoker failures to the model instead of throwing', async () => {
    // A plain Error from the subagent invocation (e.g. the model passed a bad
    // argument shape) is model-fixable: the handler returns it as the tool result
    // so the model can read the message, correct the call and retry.
    const invokeSubagent = jest.fn(async () => { throw new Error('bad question: expected a non-empty string'); });
    const { function_results } = await functionHandler(
      [{ name: 'ask_researcher', input: { question: 'meaning?' } }],
      [subagentFunction],
      [],
      () => { },
      {},
      {},
      { invokeSubagent }
    );
    expect(function_results).toHaveLength(1);
    expect(function_results[0].error?.message).toMatch(/bad question/);
    expect(JSON.parse(function_results[0].result)).toEqual({
      error: expect.stringMatching(/bad question/),
    });
  });
});
