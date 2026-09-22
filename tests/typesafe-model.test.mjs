// The TypeSafe Jev decision driver and its pure mapping (docs/typesafe-jev.md):
// key resolution, route and wire id, every accepted and rejected result
// property shape, the state, answers to the result shape, minConfidence,
// usage, and the retry and deadline rules. No network: fetch is injected.
import { readFileSync } from 'node:fs';

process.env.TYPESAFE_API_KEY ||= 'test-key';

const { default: Typesafe, DecisionRequestError } = await import('../lib/models/typesafe.js');
const {
  questionsFromResultFunction, questionFromProperty, resultFromAnswers,
  DecisionSchemaError, DecisionAnswerError, MAX_QUESTIONS,
} = await import('../lib/decision-questions.js');
const { modelKind, isDecisionModelName, decisionModelOffered, validateDecisionAgent } = await import('../lib/decision-limits.js');

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/typesafe/${name}.json`, import.meta.url), 'utf8'));
const SIX = fixture('six-questions');
const TWO = fixture('score-two-levels');
const TEN = fixture('score-ten-levels');
const E422 = fixture('error-422');

// Expectations are derived from the fixture bodies, so a recorded fixture with
// other numbers still exercises the same mapping.
const argmaxLevel = (answer) => {
  let best;
  for (const [index, p] of Object.entries(answer.probabilities)) {
    if (!best || p > best[1]) best = [index, p];
  }
  return answer.legend[best[0]];
};
const byLevelName = (answer) => Object.fromEntries(Object.entries(answer.probabilities).map(([index, p]) => [answer.legend[index], p]));
const expectedSix = (answers = SIX.response.answers) => ({
  outcome: answers.outcome.choice,
  needs_followup: answers.needs_followup.noul,
  caller_sentiment: argmaxLevel(answers.caller_sentiment),
  agent_error: answers.agent_error.noul,
  policy_breach: answers.policy_breach.noul,
  escalation_missed: answers.escalation_missed.noul,
  confidence: { outcome: answers.outcome.confidence, caller_sentiment: answers.caller_sentiment.confidence },
  probabilities: { outcome: answers.outcome.probabilities, caller_sentiment: byLevelName(answers.caller_sentiment) },
});

const logger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return this; },
};

const MODEL = 'text:typesafe/jev-1.13.0';

const resultFunction = (properties, name = 'analyse') => ({
  name, implementation: 'builtin', platform: 'result', description: 'The answers',
  input_schema: { type: 'object', properties },
});

/** The spec's default question set as a result schema. */
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

const driverArgs = (overrides = {}) => ({
  logger, user: 'test', prompt: SIX.request.state.instructions, options: {},
  model: MODEL, modelName: MODEL, keys: [],
  rawFunctions: [resultFunction(SIX_PROPERTIES)], rawInput: SIX.request.state.input,
  ...overrides,
});

/** A fetch stub that answers each call from a queue of { status, body, headers }. */
function fakeFetch(responses) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const next = responses.shift();
    if (!next) throw new Error('fakeFetch: no response queued');
    if (next.error) throw next.error;
    if (next.hang) {
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    }
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      headers: new Headers(next.headers || {}),
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    };
  };
  return { impl, calls };
}

const withEnv = (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

describe('key, route and wire id', () => {
  test('the roster row is decision-kind and pinned', () => {
    expect(Typesafe.kind).toBe('decision');
    expect(Typesafe.provider).toBe('typesafe');
    expect(Typesafe.allModels).toEqual([['typesafe/jev-1.13.0', 'TypeSafe Jev 1.13 (decision model)', { kind: 'decision' }]]);
    expect(Typesafe.isOffered('jev-1.13.0')).toBe(true);
    expect(Typesafe.isOffered('jev-latest')).toBe(false);
    expect(Typesafe.supportsMcp()).toBe(false);
  });

  test('TYPESAFE_API_KEY on the direct route; OPENROUTER_KEY only when the base URL is OpenRouter', () => {
    withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_KEY: 'or-key', TYPESAFE_BASE_URL: undefined }, () => {
      expect(Typesafe.route).toBe('direct');
      expect(Typesafe.baseURL).toBe('https://api.typesafe.ai');
      expect(Typesafe.canLoad).toEqual({ ok: false, need: ['TYPESAFE_API_KEY'] });
      expect(() => new Typesafe(driverArgs())).toThrow(/TYPESAFE_API_KEY is not set/);
    });
    withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_KEY: 'or-key', TYPESAFE_BASE_URL: 'https://openrouter.ai/api/' }, () => {
      expect(Typesafe.route).toBe('openrouter');
      expect(Typesafe.baseURL).toBe('https://openrouter.ai/api');
      expect(Typesafe.canLoad.ok).toBe(true);
      expect(new Typesafe(driverArgs()).apiKey).toBe('or-key');
    });
    withEnv({ TYPESAFE_API_KEY: 'ts-key', OPENROUTER_KEY: 'or-key', TYPESAFE_BASE_URL: 'https://openrouter.ai/api' }, () => {
      expect(new Typesafe(driverArgs()).apiKey).toBe('ts-key');
    });
    withEnv({ TYPESAFE_API_KEY: undefined, OPENROUTER_KEY: undefined, TYPESAFE_BASE_URL: 'https://openrouter.ai/api' }, () => {
      expect(Typesafe.canLoad.ok).toBe(false);
      expect(() => new Typesafe(driverArgs())).toThrow(/nor OPENROUTER_KEY/);
    });
  });

  test('the wire id is the pinned id on the direct route and the OpenRouter name on the OpenRouter route', () => {
    expect(Typesafe.wireId('jev-1.13.0', 'direct')).toBe('jev-1.13.0');
    expect(Typesafe.wireId('jev-1.13.0', 'openrouter')).toBe('typesafe/jev-1.13');
    expect(Typesafe.wireId('jev-2.0.0', 'openrouter')).toBe('typesafe/jev-2.0.0');
  });

  test('the model is the stripped id; an unlisted id and the alias are refused', () => {
    const driver = new Typesafe(driverArgs());
    expect(driver.model).toBe('jev-1.13.0');
    expect(() => new Typesafe(driverArgs({ model: 'text:typesafe/jev-latest', modelName: 'text:typesafe/jev-latest' }))).toThrow(/pinned ids only/);
    expect(() => new Typesafe(driverArgs({ model: undefined, modelName: 'text:typesafe/jev-1.12.0' }))).toThrow(/not an offered decision model/);
  });

  test('completion() and callResult() are not a chat', async () => {
    const driver = new Typesafe(driverArgs());
    await expect(driver.completion('hi')).rejects.toThrow(/use decide\(\)/);
    await expect(driver.callResult([])).rejects.toThrow(/use decide\(\)/);
  });

  test('the deadline comes from TYPESAFE_TIMEOUT_MS, default 5000', () => {
    withEnv({ TYPESAFE_TIMEOUT_MS: undefined }, () => expect(Typesafe.timeoutMs).toBe(5000));
    withEnv({ TYPESAFE_TIMEOUT_MS: '1500' }, () => expect(Typesafe.timeoutMs).toBe(1500));
    withEnv({ TYPESAFE_TIMEOUT_MS: 'soon' }, () => expect(Typesafe.timeoutMs).toBe(5000));
  });
});

describe('result properties to questions', () => {
  const q = (property, name = 'p') => questionFromProperty(name, property);
  const reject = (property, pattern, name = 'p') => expect(() => q(property, name)).toThrow(pattern);

  test('an enum is a Choice whose criteria lists every option, described or null', () => {
    expect(q({ type: 'string', description: 'Which?', enum: ['a', 'b'], 'x-descriptions': { a: 'The first' } }))
      .toEqual({ type: 'choice', instructions: 'Which?', criteria: { a: 'The first', b: null } });
    // type defaults to string, as it does for every function parameter
    expect(q({ description: 'Which?', enum: ['a', 'b'] }).type).toBe('choice');
  });

  test('a boolean is a Noul, with optional x-criteria passed through', () => {
    expect(q({ type: 'boolean', description: 'Is it?' })).toEqual({ type: 'noul', instructions: 'Is it?' });
    expect(q({ type: 'boolean', description: 'Is it?', 'x-criteria': { true: 'Yes when', false: 'No when' } }))
      .toEqual({ type: 'noul', instructions: 'Is it?', criteria: { true: 'Yes when', false: 'No when' } });
    expect(q({ type: 'boolean', description: 'Is it?', 'x-criteria': { true: 'Yes when' } }).criteria).toEqual({ true: 'Yes when' });
    reject({ type: 'boolean', description: 'Is it?', 'x-criteria': { maybe: 'x' } }, /accepts only "true" and "false"/);
    reject({ type: 'boolean', description: 'Is it?', enum: ['a', 'b'] }, /takes neither enum nor x-levels/);
  });

  test('x-levels is a Score whose criteria is the ordered level list', () => {
    expect(q({ type: 'string', description: 'How much?', 'x-levels': ['low', 'high'] }))
      .toEqual({ type: 'score', instructions: 'How much?', criteria: ['low', 'high'] });
  });

  test('every other shape is rejected with the fix in the message', () => {
    reject({ type: 'string', description: 'Free text' }, /a free string is not answerable/);
    reject({ type: 'number', description: 'n' }, /type "number" is not answerable/);
    reject({ type: 'integer', description: 'n', 'x-levels': ['a', 'b'] }, /type "integer" is not answerable/);
    reject({ type: 'array', description: 'n' }, /type "array" is not answerable/);
    reject({ type: 'object', description: 'n' }, /type "object" is not answerable/);
    reject({ type: 'string', description: 'Which?', enum: ['a', 'b'], 'x-levels': ['a', 'b'] }, /cannot both be set/);
  });

  test('descriptions are required, sources must be generated, names are not reserved', () => {
    reject({ type: 'boolean' }, /description is required/);
    reject({ type: 'boolean', description: '  ' }, /description is required/);
    reject({ type: 'boolean', description: 'Is it?', source: 'static', from: 'x' }, /source must be "generated" or omitted/);
    reject({ type: 'boolean', description: 'Is it?', source: 'metadata', from: 'x' }, /source must be "generated"/);
    expect(q({ type: 'boolean', description: 'Is it?', source: 'generated' }).type).toBe('noul');
    for (const name of ['confidence', 'probabilities', 'decision']) {
      reject({ type: 'boolean', description: 'Is it?' }, /reserved for the result/, name);
    }
  });

  test('option and level counts, distinctness and descriptions are checked', () => {
    reject({ type: 'string', description: 'w', enum: ['only'] }, /enum needs between 2 and 255 entries \(got 1\)/);
    reject({ type: 'string', description: 'w', enum: Array.from({ length: 256 }, (_, i) => `o${i}`) }, /between 2 and 255/);
    expect(q({ type: 'string', description: 'w', enum: Array.from({ length: 255 }, (_, i) => `o${i}`) }).type).toBe('choice');
    reject({ type: 'string', description: 'w', enum: ['a', 'a'] }, /entries must be distinct/);
    reject({ type: 'string', description: 'w', enum: ['a', 2] }, /non-empty string/);
    reject({ type: 'string', description: 'w', enum: 'a,b' }, /must be an array of strings/);
    reject({ type: 'string', description: 'w', enum: ['a', 'b'], 'x-descriptions': { c: 'x' } }, /names "c", which is not one of the enum values/);
    reject({ type: 'string', description: 'w', enum: ['a', 'b'], 'x-descriptions': { a: 3 } }, /must be a string or null/);
    reject({ type: 'string', description: 'w', enum: ['a', 'b'], 'x-descriptions': ['a'] }, /must be an object/);
    reject({ type: 'string', description: 'w', 'x-levels': ['one'] }, /x-levels needs between 2 and 10 entries \(got 1\)/);
    reject({ type: 'string', description: 'w', 'x-levels': Array.from({ length: 11 }, (_, i) => `l${i}`) }, /between 2 and 10/);
    expect(q({ type: 'string', description: 'w', 'x-levels': Array.from({ length: 10 }, (_, i) => `l${i}`) }).criteria).toHaveLength(10);
  });

  test('the function needs 1 to 32 properties, in declaration order', () => {
    expect(() => questionsFromResultFunction(resultFunction({}))).toThrow(/between 1 and 32 properties \(got 0\)/);
    expect(() => questionsFromResultFunction({ name: 'r' })).toThrow(/needs input_schema.properties/);
    const many = Object.fromEntries(Array.from({ length: MAX_QUESTIONS + 1 }, (_, i) => [`q${i}`, { type: 'boolean', description: 'x' }]));
    expect(() => questionsFromResultFunction(resultFunction(many))).toThrow(/got 33/);
    const questions = questionsFromResultFunction(resultFunction(SIX_PROPERTIES));
    expect(Object.keys(questions)).toEqual(Object.keys(SIX_PROPERTIES));
    // The fixture request is exactly what the driver sends for this schema.
    expect(questions).toEqual(SIX.request.questions);
    expect(() => questionsFromResultFunction(resultFunction({ ...SIX_PROPERTIES, notes: { type: 'string', description: 'free' } })))
      .toThrow(DecisionSchemaError);
  });
});

describe('answers to the result', () => {
  const questions = questionsFromResultFunction(resultFunction(SIX_PROPERTIES));

  test('Choice, Score and Noul map to the documented shape', () => {
    const result = resultFromAnswers(SIX.response.answers, questions);
    expect(result).toEqual(expectedSix());
    expect(Object.keys(result.probabilities.caller_sentiment)).toEqual(SIX_PROPERTIES.caller_sentiment['x-levels']);
    expect(Object.keys(result.probabilities.outcome).sort()).toEqual([...SIX_PROPERTIES.outcome.enum].sort());
    expect(result).not.toHaveProperty('decision');
    // Answers come first, in question order, then the two maps.
    expect(Object.keys(result)).toEqual([...Object.keys(SIX_PROPERTIES), 'confidence', 'probabilities']);
  });

  test('Score re-keys the distribution through the legend at 2 and 10 levels and takes the argmax', () => {
    for (const fx of [TWO, TEN]) {
      const answer = fx.response.answers.sentiment;
      const levels = fx.request.questions.sentiment.criteria;
      expect(Object.keys(answer.probabilities)).toHaveLength(levels.length);
      const out = resultFromAnswers(fx.response.answers, fx.request.questions);
      expect(out.sentiment).toBe(argmaxLevel(answer));
      expect(out.probabilities.sentiment).toEqual(byLevelName(answer));
      expect(Object.keys(out.probabilities.sentiment)).toEqual(levels);
      expect(out.confidence.sentiment).toBe(answer.confidence);
      // The vendor's expected-value float is not returned.
      expect(out).not.toHaveProperty('score');
      // Without a legend the level names come from the question.
      const noLegend = { sentiment: { ...answer, legend: undefined } };
      expect(resultFromAnswers(noLegend, fx.request.questions).probabilities.sentiment).toEqual(byLevelName(answer));
    }
  });

  test('a Score tie goes to the lower level, deterministically', () => {
    const question = { mood: { type: 'score', instructions: 'Mood', criteria: ['low', 'mid', 'high'] } };
    const answers = { mood: { type: 'score', score: 1.5, confidence: 0.4, legend: { 0: 'low', 1: 'mid', 2: 'high' }, probabilities: { 0: 0.1, 1: 0.45, 2: 0.45 } } };
    const out = resultFromAnswers(answers, question);
    expect(out.mood).toBe('mid');
    expect(out.probabilities.mood).toEqual({ low: 0.1, mid: 0.45, high: 0.45 });
  });

  test('minConfidence nulls low-confidence Choice and Score answers and sets decision', () => {
    const answers = SIX.response.answers;
    const expected = expectedSix();
    // Just above the Choice confidence: the Choice is gated, the Score follows its own confidence.
    const threshold = answers.outcome.confidence + 0.001;
    const gated = resultFromAnswers(answers, questions, { minConfidence: threshold });
    expect(gated.outcome).toBeNull();
    expect(gated.caller_sentiment).toBe(answers.caller_sentiment.confidence < threshold ? null : expected.caller_sentiment);
    expect(gated.probabilities.outcome).toEqual(answers.outcome.probabilities);
    expect(gated.confidence.outcome).toBe(answers.outcome.confidence);
    expect(gated.needs_followup).toBe(answers.needs_followup.noul);
    expect(gated.decision).toBe('review');
    // Below every confidence: nothing is gated.
    const floor = Math.min(answers.outcome.confidence, answers.caller_sentiment.confidence) - 0.001;
    const clear = resultFromAnswers(answers, questions, { minConfidence: floor });
    expect(clear).toEqual({ ...expected, decision: 'auto' });
    // Noul is never gated.
    const all = resultFromAnswers(answers, questions, { minConfidence: 1 });
    expect(all.escalation_missed).toBe(answers.escalation_missed.noul);
    expect(all.outcome).toBeNull();
    expect(all.caller_sentiment).toBeNull();
    expect(all.decision).toBe('review');
  });

  test('a body that does not fit the questions is a 502-class error', () => {
    const answers = SIX.response.answers;
    const bad = (patch) => () => resultFromAnswers({ ...answers, ...patch }, questions);
    expect(() => resultFromAnswers(undefined, questions)).toThrow(DecisionAnswerError);
    expect(bad({ outcome: undefined })).toThrow(/no answer for "outcome"/);
    expect(bad({ outcome: { ...answers.outcome, type: 'noul' } })).toThrow(/answered "outcome" as "noul", expected choice/);
    expect(bad({ outcome: { ...answers.outcome, choice: 'elsewhere' } })).toThrow(/chose "elsewhere" for "outcome", which is not an option/);
    expect(bad({ outcome: { ...answers.outcome, confidence: 'high' } })).toThrow(/no numeric confidence/);
    expect(bad({ outcome: { ...answers.outcome, probabilities: undefined } })).toThrow(/no probabilities/);
    expect(bad({ needs_followup: { type: 'noul', noul: 'yes' } })).toThrow(/no numeric noul/);
    expect(bad({ caller_sentiment: { ...answers.caller_sentiment, probabilities: { 0: 1 } } })).toThrow(/no probability for level 1 \("frustrated"\)/);
    try {
      bad({ outcome: undefined })();
    } catch (e) {
      expect(e.status).toBe(502);
    }
  });
});

describe('decide()', () => {
  test('sends the wire id, the state and the questions, and returns the result, transcript and usage', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: SIX.response, headers: { 'x-typesafe-request-id': 'req_1' } }]);
    const driver = new Typesafe(driverArgs({ fetchImpl: impl }));
    const { result, transcript, usage, model, requestId } = await driver.decide();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(calls[0].init.headers.Authorization).toBe('Bearer test-key');
    expect(calls[0].init.headers).not.toHaveProperty('HTTP-Referer');
    expect(calls[0].body).toEqual({ model: 'jev-1.13.0', state: SIX.request.state, questions: SIX.request.questions });
    expect(result).toEqual(expectedSix());
    expect(transcript).toEqual([{ function_calls: [{ name: 'analyse', input: result }] }]);
    expect(usage).toEqual({
      provider: 'typesafe', model: 'jev-1.13.0',
      inputTokens: SIX.response.usage.input_tokens, outputTokens: SIX.response.usage.output_tokens,
      cacheReadTokens: 0, cacheWriteTokens: 0,
    });
    expect(model).toBe(SIX.response.model);
    expect(requestId).toBe('req_1');
  });

  test('on the OpenRouter route the wire id and attribution headers change, nothing else', async () => {
    await withEnv({ TYPESAFE_BASE_URL: 'https://openrouter.ai/api' }, async () => {
      const { impl, calls } = fakeFetch([{ status: 200, body: SIX.response }]);
      const driver = new Typesafe(driverArgs({ fetchImpl: impl }));
      await driver.decide();
      expect(calls[0].url).toBe('https://openrouter.ai/api/v1/systemone');
      expect(calls[0].body.model).toBe('typesafe/jev-1.13');
      expect(calls[0].init.headers['HTTP-Referer']).toBe('https://aplisay.com');
      expect(calls[0].init.headers['X-OpenRouter-Title']).toBe('Aplisay llm-agent');
    });
  });

  test('the state carries the prompt as instructions, or is the input alone; metadata is never sent', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: SIX.response }, { status: 200, body: SIX.response }, { status: 200, body: SIX.response }]);
    await new Typesafe(driverArgs({ fetchImpl: impl, prompt: '' })).decide();
    expect(calls[0].body.state).toEqual(SIX.request.state.input);
    await new Typesafe(driverArgs({ fetchImpl: impl, prompt: '  Judge the call.  ', rawInput: 'a bare string' })).decide();
    expect(calls[1].body.state).toEqual({ instructions: 'Judge the call.', input: 'a bare string' });
    await new Typesafe(driverArgs({ fetchImpl: impl, rawInput: undefined })).decide();
    expect(calls[2].body.state).toEqual({ instructions: SIX.request.state.instructions, input: null });
    expect(JSON.stringify(calls[0].body)).not.toMatch(/metadata/);
    await expect(new Typesafe(driverArgs({ fetchImpl: impl, prompt: '', rawInput: {} })).decide()).rejects.toThrow(/needs input to decide on/);
  });

  test('a missing or unanswerable result function is a 400 before any request', async () => {
    const { impl, calls } = fakeFetch([]);
    await expect(new Typesafe(driverArgs({ fetchImpl: impl, rawFunctions: [] })).decide()).rejects.toMatchObject({ status: 400, message: /platform "result"/ });
    await expect(new Typesafe(driverArgs({ fetchImpl: impl, rawFunctions: [resultFunction({ notes: { type: 'string', description: 'free' } })] })).decide())
      .rejects.toMatchObject({ status: 400, message: /a free string is not answerable/ });
    // Functions stored as an object keyed by name work too.
    const { impl: impl2, calls: calls2 } = fakeFetch([{ status: 200, body: SIX.response }]);
    const keyed = { analyse: resultFunction(SIX_PROPERTIES) };
    await new Typesafe(driverArgs({ fetchImpl: impl2, rawFunctions: keyed })).decide();
    expect(calls).toHaveLength(0);
    expect(calls2).toHaveLength(1);
  });

  test('a 429 is retried once and the second answer is used', async () => {
    const { impl, calls } = fakeFetch([{ status: 429, body: { error: { message: 'slow down', code: 429 } } }, { status: 200, body: SIX.response }]);
    const { result } = await new Typesafe(driverArgs({ fetchImpl: impl })).decide();
    expect(calls).toHaveLength(2);
    expect(result.outcome).toBe(SIX.response.answers.outcome.choice);
  });

  test('a 5xx twice is a 502 carrying the vendor status and request id', async () => {
    const { impl, calls } = fakeFetch([
      { status: 503, body: 'upstream down', headers: { 'x-typesafe-request-id': 'req_a' } },
      { status: 529, body: { detail: 'overloaded' }, headers: { 'x-typesafe-request-id': 'req_b' } },
    ]);
    const err = await new Typesafe(driverArgs({ fetchImpl: impl })).decide().catch((e) => e);
    expect(err).toBeInstanceOf(DecisionRequestError);
    expect(err).toMatchObject({ status: 502, vendorStatus: 529, detail: 'overloaded', requestId: 'req_b' });
    expect(err.message).toMatch(/HTTP 529: overloaded/);
    expect(calls).toHaveLength(2);
  });

  test('a connection error is retried once, then a 502', async () => {
    const { impl, calls } = fakeFetch([{ error: new TypeError('fetch failed') }, { status: 200, body: SIX.response }]);
    await new Typesafe(driverArgs({ fetchImpl: impl })).decide();
    expect(calls).toHaveLength(2);
    const { impl: failing } = fakeFetch([{ error: new TypeError('fetch failed') }, { error: new TypeError('fetch failed') }]);
    await expect(new Typesafe(driverArgs({ fetchImpl: failing })).decide()).rejects.toMatchObject({ status: 502, message: /fetch failed/ });
  });

  test('a 422 is surfaced verbatim and never retried', async () => {
    const { impl, calls } = fakeFetch([{ status: E422.status, body: E422.body, headers: E422.headers }]);
    const err = await new Typesafe(driverArgs({ fetchImpl: impl })).decide().catch((e) => e);
    expect(calls).toHaveLength(1);
    expect(err).toMatchObject({ status: 502, vendorStatus: 422, requestId: 'req_schema_fixture_422' });
    expect(err.detail).toEqual(E422.body.detail);
    expect(err.message).toMatch(/HTTP 422: .*Field required/);
  });

  test('an OpenRouter error envelope is surfaced from its error field', async () => {
    const envelope = fixture('openrouter-error-401');
    const { impl } = fakeFetch([{ status: envelope.status, body: envelope.body }]);
    const err = await new Typesafe(driverArgs({ fetchImpl: impl })).decide().catch((e) => e);
    expect(err).toMatchObject({ status: 502, vendorStatus: 401, detail: envelope.body.error });
    expect(err.message).toMatch(/No cookie auth credentials found/);
  });

  test('the deadline expiry is a 502 and is not retried', async () => {
    await withEnv({ TYPESAFE_TIMEOUT_MS: '60' }, async () => {
      const { impl, calls } = fakeFetch([{ hang: true }, { status: 200, body: SIX.response }]);
      const err = await new Typesafe(driverArgs({ fetchImpl: impl })).decide().catch((e) => e);
      expect(err).toMatchObject({ status: 502, message: /exceeded its 60 ms deadline/ });
      expect(calls).toHaveLength(1);
    });
  });

  test('a 2xx without an answers map is a 502', async () => {
    const { impl } = fakeFetch([{ status: 200, body: 'not json at all' }]);
    await expect(new Typesafe(driverArgs({ fetchImpl: impl })).decide()).rejects.toMatchObject({ status: 502, message: /not a JSON body with answers/ });
    const { impl: noAnswers } = fakeFetch([{ status: 200, body: { model: 'x', usage: {} } }]);
    await expect(new Typesafe(driverArgs({ fetchImpl: noAnswers })).decide()).rejects.toMatchObject({ status: 502 });
  });

  test('minConfidence from options.decision reaches the result', async () => {
    const { impl } = fakeFetch([{ status: 200, body: SIX.response }]);
    const { result } = await new Typesafe(driverArgs({ fetchImpl: impl, options: { decision: { minConfidence: 1 } } })).decide();
    expect(result.outcome).toBeNull();
    expect(result.caller_sentiment).toBeNull();
    expect(result.decision).toBe('review');
  });

  test('the static fetchImpl hook stands in for global fetch', async () => {
    const { impl, calls } = fakeFetch([{ status: 200, body: SIX.response }]);
    Typesafe.fetchImpl = impl;
    try {
      await new Typesafe(driverArgs()).decide();
    } finally {
      Typesafe.fetchImpl = undefined;
    }
    expect(calls).toHaveLength(1);
  });
});

describe('save-time rules (pure)', () => {
  const base = { modelName: MODEL, functions: [resultFunction(SIX_PROPERTIES)], options: {}, mcpServers: [] };
  const rejects = (agent, pattern) => expect(() => validateDecisionAgent({ ...base, ...agent })).toThrow(pattern);

  test('kind and roster membership', () => {
    expect(modelKind(MODEL)).toBe('decision');
    expect(modelKind('text:typesafe/jev-latest')).toBe('decision');
    expect(modelKind('text:openai/gpt-5.6-luna')).toBe('generative');
    expect(modelKind('pipecat:openai/gpt-realtime')).toBe('generative');
    expect(modelKind(undefined)).toBe('generative');
    expect(isDecisionModelName(MODEL)).toBe(true);
    expect(decisionModelOffered(MODEL)).toBe(true);
    expect(decisionModelOffered('text:typesafe/jev-latest')).toBe(false);
  });

  test('a well-formed decision agent passes, with or without options.decision', () => {
    expect(() => validateDecisionAgent(base)).not.toThrow();
    expect(() => validateDecisionAgent({ ...base, options: { decision: { minConfidence: 0.7 } } })).not.toThrow();
    expect(() => validateDecisionAgent({ ...base, functions: { analyse: resultFunction(SIX_PROPERTIES) }, mcpServers: null })).not.toThrow();
  });

  test('pinned ids only, text handler only', () => {
    rejects({ modelName: 'text:typesafe/jev-latest' }, /not an offered decision model: pinned ids only \(text:typesafe\/jev-1.13.0\)/);
    rejects({ modelName: 'pipecat:typesafe/jev-1.13.0' }, /decision models are text agents/);
  });

  test('exactly one result function, no other functions, no MCP servers', () => {
    rejects({ functions: [] }, /exactly one builtin function with platform "result".*has 0/);
    rejects({ functions: [resultFunction(SIX_PROPERTIES, 'a'), resultFunction(SIX_PROPERTIES, 'b')] }, /has 2/);
    rejects({ functions: [resultFunction(SIX_PROPERTIES), { name: 'lookup', implementation: 'rest', url: 'https://x', input_schema: { properties: {} } }] },
      /has no tool loop.*remove "lookup"/);
    rejects({ functions: [resultFunction(SIX_PROPERTIES), { name: 'hangup', implementation: 'builtin', platform: 'hangup', input_schema: { properties: {} } }] },
      /remove "hangup"/);
    rejects({ mcpServers: [{ name: 'kb', url: 'https://x' }] }, /mcpServers are not accepted/);
  });

  test('the result schema is checked with the same rules the driver applies', () => {
    rejects({ functions: [resultFunction({ notes: { type: 'string', description: 'free' } })] }, /result function "analyse": notes: .*a free string is not answerable/);
    rejects({ functions: [resultFunction({ decision: { type: 'boolean', description: 'x' } })] }, /decision: reserved/);
  });

  test('voice options are refused and options.decision is shape-checked', () => {
    for (const key of ['tts', 'stt', 'greeting', 'fallback', 'inactivity', 'callHook']) {
      rejects({ options: { [key]: { any: 'thing' } } }, new RegExp(`options.${key} is not accepted on a decision model`));
    }
    rejects({ options: { decision: 'strict' } }, /options.decision must be an object/);
    rejects({ options: { decision: { threshold: 0.5 } } }, /unknown field\(s\) threshold/);
    rejects({ options: { decision: { minConfidence: 1.5 } } }, /between 0 and 1/);
    rejects({ options: { decision: { minConfidence: '0.5' } } }, /between 0 and 1/);
    expect(() => validateDecisionAgent({ ...base, options: { decision: { minConfidence: null } } })).not.toThrow();
  });

  test('options.decision is refused on every other model, and nothing else is checked there', () => {
    expect(() => validateDecisionAgent({ modelName: 'text:openai/gpt-5.6-luna', functions: [], options: { decision: { minConfidence: 0.5 } } }))
      .toThrow(/options.decision is accepted only on decision models/);
    expect(() => validateDecisionAgent({ modelName: 'text:openai/gpt-5.6-luna', functions: [{ name: 'x', implementation: 'rest' }], options: { tts: { voice: 'a' } }, mcpServers: [{}] }))
      .not.toThrow();
  });
});
