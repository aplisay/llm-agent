// Hosted-MCP replay retention: the Responses API ACCEPTS a replayed
// `mcp_call` input item but silently DISCARDS its `output` — the model never
// sees the content again and it is not token-charged (verified against the
// live API: a replayed mcp_call whose output named a magic token got "NONE"
// back at 46 input tokens; the same content as a function_call/
// function_call_output pair was quoted back at 90). With store:false that
// made every MCP result amnesic one request later — the builder's playbook
// gate then re-fetched get_playbook on every turn and could loop without
// ever reaching its save. These tests pin the driver-side cure: each
// completed mcp_call is rewritten into a retained function pair when pushed
// onto the replay history; everything else replays verbatim.
// No network: fake stream helpers stand in for the SDK stream objects.
process.env.OPENAI_API_KEY ||= 'test-key';

const { default: OpenAi } = await import('../lib/models/openai.js');

const logger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return this; },
};

const baseArgs = {
  logger,
  user: 'test',
  prompt: 'You are a test agent.',
  options: { maxTokens: 4096 },
  model: 'text:openai/gpt-5.6-terra',
  modelName: 'text:openai/gpt-5.6-terra',
  mcpServers: [],
  keys: [],
};

/** Stand-in for the SDK stream helper (events replayed, then the final). */
function fakeStream({ events = [], final }) {
  const listeners = [];
  const finish = async () => {
    for (const e of events) listeners.forEach((cb) => cb(e));
    return final;
  };
  return {
    on(name, cb) {
      if (name === 'event') listeners.push(cb);
      return this;
    },
    abort() {},
    finalResponse: finish,
  };
}

const driverWith = (final) => {
  const oa = new OpenAi(baseArgs);
  oa.client = { responses: { stream: () => fakeStream({ final }) } };
  return oa;
};

describe('openai (Responses) hosted-MCP replay retention', () => {
  test('a completed mcp_call is replayed as a function pair carrying its output', async () => {
    const oa = driverWith({
      status: 'completed',
      output: [
        {
          type: 'mcp_call',
          id: 'mcp_abc123',
          name: 'get_playbook',
          server_label: 'polite',
          arguments: '{}',
          output: 'PLAYBOOK CONTENT',
        },
        { type: 'message', content: [{ type: 'output_text', text: 'Read it.' }] },
      ],
      usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
    });
    const events = [];
    const round = await oa.rawCompletion('fetch the playbook', (ev) => events.push(ev));

    // No mcp_call item survives into the replay history…
    expect(oa.gpt.input.some((i) => i?.type === 'mcp_call')).toBe(false);
    // …its content rides a retained function pair instead, keyed by the mcp id.
    expect(oa.gpt.input).toEqual(expect.arrayContaining([
      { type: 'function_call', call_id: 'mcp_abc123', name: 'get_playbook', arguments: '{}' },
      { type: 'function_call_output', call_id: 'mcp_abc123', output: 'PLAYBOOK CONTENT' },
    ]));
    // The pair sits where the mcp_call sat: before the assistant message.
    const callIdx = oa.gpt.input.findIndex((i) => i?.type === 'function_call');
    const outIdx = oa.gpt.input.findIndex((i) => i?.type === 'function_call_output');
    const msgIdx = oa.gpt.input.findIndex((i) => i?.type === 'message');
    expect(callIdx).toBeLessThan(outIdx);
    expect(outIdx).toBeLessThan(msgIdx);

    // The round contract is untouched: hosted calls are not client calls…
    expect(round.calls).toEqual([]);
    expect(round.text).toBe('Read it.');
    // …and the mcp completion still surfaces to the client callback.
    expect(events.some((e) => e.mcp_tool_use?.name === 'get_playbook')).toBe(true);
  });

  test('a FAILED mcp_call replays its error, so the failure is remembered too', async () => {
    const oa = driverWith({
      status: 'completed',
      output: [
        {
          type: 'mcp_call',
          id: 'mcp_err1',
          name: 'get_playbook',
          server_label: 'polite',
          arguments: '{}',
          output: null,
          error: 'upstream 502',
        },
      ],
      usage: { input_tokens: 5, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
    });
    await oa.rawCompletion('fetch the playbook');
    expect(oa.gpt.input).toEqual(expect.arrayContaining([
      { type: 'function_call_output', call_id: 'mcp_err1', output: 'ERROR: upstream 502' },
    ]));
  });

  test('non-MCP items replay verbatim with parse artifacts stripped (unchanged contract)', async () => {
    const oa = driverWith({
      status: 'completed',
      output: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
        { type: 'function_call', call_id: 'c1', name: 'update_agent_set', arguments: '{"id":"s1"}', parsed_arguments: null },
        { type: 'mcp_list_tools', server_label: 'polite', tools: [{ name: 'get_playbook' }] },
      ],
      usage: { input_tokens: 5, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
    });
    await oa.rawCompletion('go');
    expect(oa.gpt.input).toEqual(expect.arrayContaining([
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque' },
      { type: 'function_call', call_id: 'c1', name: 'update_agent_set', arguments: '{"id":"s1"}' },
      { type: 'mcp_list_tools', server_label: 'polite', tools: [{ name: 'get_playbook' }] },
    ]));
    for (const item of oa.gpt.input) expect(item).not.toHaveProperty('parsed_arguments');
  });
});
