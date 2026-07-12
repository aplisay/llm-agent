// Streaming tool-use start events: the anthropic and openai (Responses)
// drivers now STREAM each completion and surface a client tool call's NAME the
// moment its block/item starts — `callBack({ tool_use_start: { name } })` —
// so the builder UI can veil the canvas for the whole generation window of a
// set save, not just the post-generation round trip. These tests pin that the
// event fires (with the name, before the round resolves) AND that the
// completion contract — { text, calls, truncated, usage }, history replay,
// disjoint usage units — is byte-identical to the pre-streaming drivers.
// No network: fake stream helpers stand in for the SDK stream objects.
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.ANTHROPIC_API_KEY ||= 'test-key';

const { default: OpenAi } = await import('../lib/models/openai.js');
const { default: Anthropic } = await import('../lib/models/anthropic.js');

const logger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return this; },
};

const baseArgs = (model) => ({
  logger,
  user: 'test',
  prompt: 'You are a test agent.',
  options: { maxTokens: 4096 },
  model,
  modelName: model,
  mcpServers: [],
  keys: [],
});

/**
 * Stand-in for the SDK stream helpers: listeners registered via .on() are
 * replayed the queued events when finalMessage()/finalResponse() is awaited —
 * the same relative order as the real helpers (events before resolution).
 */
function fakeStream({ events = [], final, eventName }) {
  const listeners = [];
  const finish = async () => {
    for (const e of events) listeners.forEach((cb) => cb(e));
    if (final instanceof Error) throw final;
    return final;
  };
  return {
    on(name, cb) {
      if (name === eventName) listeners.push(cb);
      return this;
    },
    abort() {},
    finalMessage: finish,
    finalResponse: finish,
  };
}

describe('anthropic streaming tool_use_start', () => {
  const finalMessage = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Saving now.' },
      { type: 'tool_use', id: 't1', name: 'update_agent_set', input: { id: 's1' } },
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 },
  };
  const streamEvents = [
    { type: 'message_start', message: {} },
    { type: 'content_block_start', content_block: { type: 'text' } },
    { type: 'content_block_start', content_block: { type: 'tool_use', name: 'update_agent_set' } },
  ];

  test('emits tool_use_start with the name at block start; round contract unchanged', async () => {
    const claude = new Anthropic(baseArgs('text:anthropic/claude-sonnet-5'));
    const streamParams = [];
    claude.client = {
      messages: {
        stream: (params) => {
          streamParams.push(params);
          return fakeStream({ events: streamEvents, final: finalMessage, eventName: 'streamEvent' });
        },
      },
      beta: { messages: { stream: () => { throw new Error('beta path must not be used without MCP servers'); } } },
    };
    const events = [];
    const round = await claude.rawCompletion('save it', (ev) => events.push(ev));

    // The early event: exactly one (the text block must not produce one), the
    // name only — arguments don't exist yet at block start.
    const starts = events.filter((e) => e.tool_use_start);
    expect(starts).toEqual([{ tool_use_start: { name: 'update_agent_set' } }]);
    // …and it arrived BEFORE the final-result callback.
    expect(events.findIndex((e) => e.tool_use_start)).toBeLessThan(events.findIndex((e) => e.calls));

    expect(round.text).toBe('Saving now.');
    expect(round.calls).toEqual([{ name: 'update_agent_set', id: 't1', input: { id: 's1' } }]);
    expect(round.truncated).toBe(false);
    expect(round.usage).toMatchObject({
      provider: 'anthropic', inputTokens: 10, outputTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 2,
    });
    // History replay: the full assistant content rides the conversation.
    expect(claude.gpt.messages.at(-1)).toEqual({ role: 'assistant', content: finalMessage.content });
    // The request itself is the familiar non-streaming shape.
    expect(streamParams[0]).toMatchObject({ model: 'claude-sonnet-5', max_tokens: 4096 });
  });

  test('pause_turn hops re-stream and accumulate usage across hops', async () => {
    const claude = new Anthropic(baseArgs('text:anthropic/claude-sonnet-5'));
    let hops = 0;
    claude.client = {
      messages: {
        stream: () => {
          hops += 1;
          return fakeStream({
            events: [],
            eventName: 'streamEvent',
            final: hops === 1
              ? { role: 'assistant', content: [], stop_reason: 'pause_turn', usage: { input_tokens: 5, output_tokens: 1 } }
              : { role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 6, output_tokens: 2 } },
          });
        },
      },
      beta: { messages: { stream: () => { throw new Error('beta path must not be used without MCP servers'); } } },
    };
    const round = await claude.rawCompletion('hi');
    expect(hops).toBe(2);
    expect(round.text).toBe('done');
    expect(round.usage).toMatchObject({ inputTokens: 11, outputTokens: 3 });
  });

  test('MCP-configured sessions stream via the beta connector path', async () => {
    const claude = new Anthropic({
      ...baseArgs('text:anthropic/claude-sonnet-5'),
      mcpServers: [{ name: 'aplisay', url: 'https://mcp.example/mcp' }],
    });
    const betaParams = [];
    claude.client = {
      messages: { stream: () => { throw new Error('non-beta path must not be used with MCP servers'); } },
      beta: {
        messages: {
          stream: (params) => {
            betaParams.push(params);
            return fakeStream({
              events: [],
              eventName: 'streamEvent',
              final: { role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: {} },
            });
          },
        },
      },
    };
    await claude.rawCompletion('hi');
    expect(betaParams[0].mcp_servers).toEqual([{ type: 'url', url: 'https://mcp.example/mcp', name: 'aplisay' }]);
    expect(betaParams[0].betas).toBeDefined();
  });
});

describe('openai (Responses) streaming tool_use_start', () => {
  // finalResponse() runs the SDK parse pass, which annotates function_call
  // items with parsed_arguments and output_text parts with parsed — exactly
  // as the real helper returns them (caught live: replaying them 400s with
  // "Unknown parameter: 'input[N].parsed_arguments'").
  const finalResponse = {
    status: 'completed',
    output: [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
      { type: 'message', content: [{ type: 'output_text', text: 'Done.', parsed: null }] },
      { type: 'function_call', call_id: 'c1', name: 'update_agent_set', arguments: '{"id":"s1"}', parsed_arguments: null },
    ],
    usage: { input_tokens: 100, output_tokens: 9, input_tokens_details: { cached_tokens: 40 } },
  };
  const streamEvents = [
    { type: 'response.created', response: {} },
    { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_1' } },
    { type: 'response.output_item.added', item: { type: 'function_call', name: 'update_agent_set' } },
  ];

  test('emits tool_use_start when the function_call item is added; round contract unchanged', async () => {
    const oa = new OpenAi(baseArgs('text:openai/gpt-5.6-terra'));
    const streamParams = [];
    oa.client = {
      responses: {
        stream: (params) => {
          streamParams.push(params);
          return fakeStream({ events: streamEvents, final: finalResponse, eventName: 'event' });
        },
      },
    };
    const events = [];
    const round = await oa.rawCompletion('save it', (ev) => events.push(ev));

    const starts = events.filter((e) => e.tool_use_start);
    expect(starts).toEqual([{ tool_use_start: { name: 'update_agent_set' } }]);
    expect(events.findIndex((e) => e.tool_use_start)).toBeLessThan(events.findIndex((e) => e.calls));

    expect(round.text).toBe('Done.');
    expect(round.calls).toEqual([{ id: 'c1', name: 'update_agent_set', input: { id: 's1' } }]);
    expect(round.truncated).toBe(false);
    // Disjoint usage units: cached tokens subtracted from input_tokens.
    expect(round.usage).toMatchObject({ inputTokens: 60, outputTokens: 9, cacheReadTokens: 40 });
    // Stateless replay: EVERY output item (encrypted reasoning included) is
    // appended to the input for the next request, with the parse-pass
    // annotations STRIPPED (the API rejects them as unknown parameters).
    expect(oa.gpt.input).toEqual(expect.arrayContaining([
      finalResponse.output[0],
      { type: 'message', content: [{ type: 'output_text', text: 'Done.' }] },
      { type: 'function_call', call_id: 'c1', name: 'update_agent_set', arguments: '{"id":"s1"}' },
    ]));
    for (const item of oa.gpt.input) {
      expect(item).not.toHaveProperty('parsed_arguments');
      for (const part of item?.content || []) expect(part).not.toHaveProperty('parsed');
    }
    // The request keeps the statefulness contract of the non-streaming driver.
    expect(streamParams[0]).toMatchObject({ store: false, include: ['reasoning.encrypted_content'] });
  });
});
