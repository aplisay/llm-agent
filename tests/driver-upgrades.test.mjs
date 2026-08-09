// Driver-upgrade unit tests: the pure logic of the new provider drivers —
// model-name handling for ids that contain '/', per-model effort gating,
// request-body shapes, usage normalisation and MCP bridge auth/name rules.
// No network: nothing here calls a provider.
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';
process.env.KIMI_KEY ||= 'test-key';
process.env.OPENROUTER_KEY ||= 'test-key';
process.env.GOOGLE_API_KEY ||= 'test-key';

const { default: OpenAi } = await import('../lib/models/openai.js');
const { default: Kimi } = await import('../lib/models/kimi.js');
const { default: OpenRouter } = await import('../lib/models/openrouter.js');
const { default: McpToolBridge } = await import('../lib/models/mcp-tools.js');

const logger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return this; },
};

const baseArgs = (model) => ({
  logger,
  user: 'test',
  prompt: 'You are a test agent.',
  options: { maxTokens: 12345 },
  model,
  modelName: model,
  mcpServers: [],
  keys: [],
});

describe('driver model-name handling (ids containing "/")', () => {
  test('openai-compatible strips only the leading provider segment', () => {
    const or = new OpenRouter(baseArgs('text:openrouter/moonshotai/kimi-k2.6'));
    expect(or.model).toBe('moonshotai/kimi-k2.6');
    const kimi = new Kimi(baseArgs('text:kimi/kimi-k2.6'));
    expect(kimi.model).toBe('kimi-k2.6');
  });
});

describe('OpenAi (Responses) effort gating', () => {
  test('max degrades to xhigh on gpt-5.5; passes through on 5.6; dropped on gpt-4o', () => {
    expect(OpenAi.effortFor('gpt-5.5', 'max', logger)).toBe('xhigh');
    expect(OpenAi.effortFor('gpt-5.6-sol', 'max', logger)).toBe('max');
    expect(OpenAi.effortFor('gpt-5.6-terra', 'high', logger)).toBe('high');
    expect(OpenAi.effortFor('gpt-4o', 'high', logger)).toBeUndefined();
    expect(OpenAi.effortFor('gpt-5.6-sol', 'bogus', logger)).toBeUndefined();
    expect(OpenAi.effortFor('gpt-5.6-sol', undefined, logger)).toBeUndefined();
  });

  test('function tools are the FLAT Responses shape', () => {
    const oa = new OpenAi(baseArgs('text:openai/gpt-5.6-terra'));
    oa.functions = [{ name: 'f1', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'string' } } } }];
    expect(oa.tools[0]).toEqual({
      type: 'function', name: 'f1', description: 'd',
      parameters: { type: 'object', properties: { a: { type: 'string' } } },
    });
  });
});

describe('openai-compatible request bodies', () => {
  test('maxTokens is honoured under the provider-correct parameter name', () => {
    const kimi = new Kimi(baseArgs('text:kimi/kimi-k2.6'));
    expect(kimi.requestBody([]).max_completion_tokens).toBe(12345);
    const or = new OpenRouter(baseArgs('text:openrouter/moonshotai/kimi-k2.6'));
    expect(or.requestBody([]).max_tokens).toBe(12345);
  });

  test('temperature is omitted by default (k2.x models hard-reject it)', () => {
    const kimi = new Kimi({ ...baseArgs('text:kimi/kimi-k2.6'), options: { maxTokens: 1, temperature: 0.7 } });
    expect(kimi.requestBody([])).not.toHaveProperty('temperature');
  });

  test('openrouter adds require_parameters with tools, and reasoning effort from options', () => {
    const or = new OpenRouter({ ...baseArgs('text:openrouter/qwen/qwen3.7-max'), options: { maxTokens: 1, effort: 'medium' } });
    const body = or.requestBody([{ type: 'function', function: { name: 'x' } }]);
    expect(body.provider).toEqual({ require_parameters: true });
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(or.requestBody([])).not.toHaveProperty('provider');
  });

  test('usage units are DISJOINT: cached tokens are subtracted from prompt_tokens', () => {
    const kimi = new Kimi(baseArgs('text:kimi/kimi-k2.6'));
    // prompt_tokens INCLUDES the cached subset on these providers — reporting
    // both un-split would bill cache hits at full input rate AND cache-read rate.
    expect(kimi.usageOf({ prompt_tokens: 10, completion_tokens: 5, cached_tokens: 7 }))
      .toEqual({ inputTokens: 3, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 0 });
    expect(kimi.usageOf({ prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 } }))
      .toEqual({ inputTokens: 7, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 });
  });
});

describe('model fallback for handler-constructed (voice) sessions', () => {
  test('modelName is honoured when model is undefined (agent.dataValues spread)', async () => {
    // The jambonz path constructs drivers from agent.dataValues, which has
    // modelName but no model — the driver must not run the catalogue default.
    const { default: Anthropic } = await import('../lib/models/anthropic.js');
    const { default: Gemini } = await import('../lib/models/gemini.js');
    const or = new OpenRouter({ ...baseArgs(undefined), model: undefined, modelName: 'text:openrouter/moonshotai/kimi-k2.6' });
    expect(or.model).toBe('moonshotai/kimi-k2.6');
    const oa = new OpenAi({ ...baseArgs(undefined), model: undefined, modelName: 'jambonz:openai/gpt-4o' });
    expect(oa.model).toBe('gpt-4o');
    const gem = new Gemini({ ...baseArgs(undefined), model: undefined, modelName: 'jambonz:gemini/gemini-2.5-flash' });
    expect(gem.model).toBe('gemini-2.5-flash');
    const claude = new Anthropic({ ...baseArgs(undefined), model: undefined, modelName: 'jambonz:anthropic/claude-sonnet-5' });
    expect(claude.model).toBe('claude-sonnet-5');
  });
});

describe('missing provider key fails CLOSED', () => {
  test('constructor throws rather than letting the SDK fall back to OPENAI_API_KEY', () => {
    // With apiKey undefined the openai SDK reads OPENAI_API_KEY from the env
    // and would send OpenAI's secret to the other provider's host.
    const saved = process.env.KIMI_KEY;
    delete process.env.KIMI_KEY;
    try {
      expect(() => new Kimi(baseArgs('text:kimi/kimi-k2.6'))).toThrow(/KIMI_KEY is not set/);
    } finally {
      process.env.KIMI_KEY = saved;
    }
  });
});

describe('usage attached to errors from partially-completed hop loops', () => {
  test('a throw after a completed MCP hop rides the accumulated usage on the error', async () => {
    const kimi = new Kimi(baseArgs('text:kimi/kimi-k2.6'));
    kimi.mcp = { ensure: async () => [], isMcpTool: (n) => n === 'srv_tool', call: async () => 'ok' };
    let n = 0;
    // The driver streams (streamOnce): the mock returns an async-iterable
    // "stream" of delta chunks with usage in a final empty-choices chunk.
    kimi.client = { chat: { completions: { create: async () => {
      n += 1;
      if (n === 2) throw new Error('boom');
      return {
        controller: new AbortController(),
        async *[Symbol.asyncIterator]() {
          yield { choices: [{ delta: { tool_calls: [{ index: 0, id: 'x', function: { name: 'srv_tool', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] };
          yield { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } };
        },
      };
    } } } };
    await expect(kimi.rawCompletion('hi')).rejects.toMatchObject({
      message: 'boom',
      usage: expect.objectContaining({ inputTokens: 100, outputTokens: 10 }),
    });
  });
});

describe('gemini history integrity', () => {
  const gemArgs = () => ({ ...baseArgs('text:gemini/gemini-2.5-flash') });
  let Gemini;
  beforeAll(async () => {
    ({ default: Gemini } = await import('../lib/models/gemini.js'));
  });

  test('callResult prefers the supplied name and never matches text/thought parts', async () => {
    const gem = new Gemini(gemArgs());
    // Model turn: prose BEFORE an id-less functionCall (the common ask_user shape).
    gem.contents = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [{ text: 'let me ask' }, { functionCall: { name: 'ask_user', args: {} } }] },
    ];
    let sent;
    gem.rawCompletion = async () => { sent = gem.contents[gem.contents.length - 1]; return { text: '', calls: [], truncated: false, usage: {} }; };
    // Named result (the pause-resume path now passes the name through).
    await gem.callResult([{ id: undefined, name: 'ask_user', result: 'blue' }]);
    expect(sent.parts[0].functionResponse.name).toBe('ask_user');
    // Defensive fallback: no name, id-less — positional match must skip the
    // text part (the old code matched it and threw reading .name).
    gem.contents.pop();
    await gem.callResult([{ id: undefined, result: 'green' }]);
    expect(sent.parts[0].functionResponse.name).toBe('ask_user');
  });

  test('abandonTurn (owner-invoked) answers dangling functionCalls, merging held MCP results', async () => {
    const gem = new Gemini(gemArgs());
    gem.contents = [
      { role: 'user', parts: [{ text: 'hi' }] },
      { role: 'model', parts: [
        { functionCall: { name: 'srv_lookup', args: {} } },
        { functionCall: { name: 'save_thing', args: {} } },
      ] },
    ];
    // A bridged-MCP result was held for the aborted mixed batch.
    gem.pendingParts = [{ functionResponse: { name: 'srv_lookup', response: { result: 'found' } } }];
    gem.abandonTurn();
    const last = gem.contents[gem.contents.length - 1];
    expect(last.role).toBe('user');
    expect(last.parts.map((p) => p.functionResponse.name)).toEqual(['srv_lookup', 'save_thing']);
    expect(last.parts[0].functionResponse.response.result).toBe('found');
    expect(last.parts[1].functionResponse.response.result).toMatch(/aborted/);
    expect(gem.pendingParts).toBeNull();
    // Idempotent: a clean history is untouched.
    const len = gem.contents.length;
    gem.abandonTurn();
    expect(gem.contents.length).toBe(len);
  });
});

describe('abandonTurn across the other drivers', () => {
  test('openai-compatible answers only UNANSWERED dangling tool_calls', () => {
    const kimi = new Kimi(baseArgs('text:kimi/kimi-k2.6'));
    kimi.gpt.messages.push(
      { role: 'assistant', tool_calls: [
        { id: 'a', function: { name: 'f1' } },
        { id: 'b', function: { name: 'f2' } },
      ] },
      { role: 'tool', tool_call_id: 'a', content: 'done' },
    );
    kimi.abandonTurn();
    const last = kimi.gpt.messages[kimi.gpt.messages.length - 1];
    expect(last).toMatchObject({ role: 'tool', tool_call_id: 'b' });
    expect(last.content).toMatch(/aborted/);
    // Idempotent once everything is answered.
    const len = kimi.gpt.messages.length;
    kimi.abandonTurn();
    expect(kimi.gpt.messages.length).toBe(len);
  });

  test('anthropic answers dangling tool_use blocks with is_error tool_results', async () => {
    const { default: Anthropic } = await import('../lib/models/anthropic.js');
    const claude = new Anthropic(baseArgs('text:anthropic/claude-sonnet-5'));
    claude.gpt.messages.push({ role: 'assistant', content: [
      { type: 'text', text: 'calling' },
      { type: 'tool_use', id: 't1', name: 'f1', input: {} },
    ] });
    claude.abandonTurn();
    const last = claude.gpt.messages[claude.gpt.messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', is_error: true });
    const len = claude.gpt.messages.length;
    claude.abandonTurn();
    expect(claude.gpt.messages.length).toBe(len);
  });

  test('openai (Responses) answers dangling function_call items', () => {
    const oa = new OpenAi(baseArgs('text:openai/gpt-5.6-terra'));
    oa.gpt.input.push(
      { type: 'function_call', call_id: 'c1', name: 'f1', arguments: '{}' },
      { type: 'function_call', call_id: 'c2', name: 'f2', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'done' },
    );
    oa.abandonTurn();
    const outputs = oa.gpt.input.filter((i) => i.type === 'function_call_output');
    expect(outputs.map((o) => o.call_id).sort()).toEqual(['c1', 'c2']);
    const len = oa.gpt.input.length;
    oa.abandonTurn();
    expect(oa.gpt.input.length).toBe(len);
  });
});

describe('driver close() releases the MCP bridge', () => {
  test('close() delegates to the bridge for bridged drivers', async () => {
    const kimi = new Kimi(baseArgs('text:kimi/kimi-k2.6'));
    let closed = false;
    kimi.mcp = { close: async () => { closed = true; } };
    await kimi.close();
    expect(closed).toBe(true);
  });
});

describe('McpToolBridge auth resolution', () => {
  test('explicit token wins; key resolves from bearer entries; unresolvable is null', () => {
    const bridge = new McpToolBridge({
      mcpServers: [],
      keys: [
        { name: 'GOOD', in: 'bearer', value: 'sk-good' },
        { name: 'WRONG_KIND', in: 'header', value: 'x' },
      ],
      logger,
    });
    expect(bridge.authFor({ authorization_token: 'explicit' })).toBe('explicit');
    expect(bridge.authFor({ key: 'GOOD' })).toBe('sk-good');
    expect(bridge.authFor({ key: 'WRONG_KIND' })).toBeNull();
    expect(bridge.authFor({ key: 'MISSING' })).toBeNull();
    expect(bridge.authFor({})).toBeUndefined();
  });
});
