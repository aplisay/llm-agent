// database-test-wrapper sets the POSTGRES_* env for the standard test container
// BEFORE lib/database.js is imported (text-chat.js pulls it in transitively),
// and its teardown closes the import-time connections so jest can exit.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

const { createChatSession } = await import('../lib/text-chat.js');

// The early `tool_call` ws frame: streaming drivers surface a client tool
// call's NAME the moment its block starts (callBack({ tool_use_start })),
// tens of seconds before a big set save's arguments finish generating. The
// chat loop forwards it as { type:'tool_call', calls:[{ name }], streaming:
// true } so the builder UI can veil the canvas for the whole generation
// window (polite-ai PR #115); the definitive post-generation tool_call frame
// (with input) is unchanged. These tests pin the frame shape, its ordering
// (before the agent reply), and that malformed/absent events emit nothing.

const logger = {
  info() {}, warn() {}, error() {}, debug() {},
  child() { return this; },
};

const agent = {
  id: 'agent-1',
  organisationId: 'org-1',
  userId: 'user-1',
  modelName: 'text:anthropic/claude-sonnet-5',
  functions: [],
  keys: [],
  options: {},
  mcpServers: [],
};

beforeAll(async () => {
  await setupRealDatabase();
});

afterAll(async () => {
  await teardownRealDatabase();
});

function sessionWithLlm(rawCompletion) {
  const session = createChatSession({ agent, logger });
  session.llm = { rawCompletion };
  return session;
}

describe('streaming tool_use_start → early tool_call frame', () => {
  test('a driver tool_use_start emits {type:tool_call, streaming:true} before the reply', async () => {
    const session = sessionWithLlm(async (text, cb) => {
      cb({ tool_use_start: { name: 'update_agent_set' } });
      return { text: 'Saved the team.', calls: [] };
    });
    const frames = [];
    await session.runTurn('add a bookings agent', (f) => frames.push(f));

    const early = frames.findIndex((f) => f.type === 'tool_call' && f.streaming);
    const reply = frames.findIndex((f) => f.type === 'agent');
    expect(frames[early]).toEqual({
      type: 'tool_call',
      calls: [{ name: 'update_agent_set' }],
      streaming: true,
    });
    expect(early).toBeGreaterThan(-1);
    expect(reply).toBeGreaterThan(early);
    expect(frames.at(-1)).toEqual({ type: 'turn_complete' });
  });

  test('a nameless tool_use_start and the final-result callback emit no frame', async () => {
    const session = sessionWithLlm(async (text, cb) => {
      cb({ tool_use_start: {} }); // malformed — no name
      const round = { text: 'ok', calls: [] };
      cb(round); // drivers echo the final round through the same callback
      return round;
    });
    const frames = [];
    await session.runTurn('hello', (f) => frames.push(f));
    expect(frames.filter((f) => f.type === 'tool_call')).toEqual([]);
  });

  test('mcp_tool_use events keep their existing frame shape alongside', async () => {
    const session = sessionWithLlm(async (text, cb) => {
      cb({ mcp_tool_use: { name: 'read_doc', server: 'aplisay' } });
      cb({ tool_use_start: { name: 'patch_agent_set' } });
      return { text: 'done', calls: [] };
    });
    const frames = [];
    await session.runTurn('tweak it', (f) => frames.push(f));
    const toolFrames = frames.filter((f) => f.type === 'tool_call');
    expect(toolFrames).toEqual([
      { type: 'tool_call', calls: [{ name: 'read_doc', server: 'aplisay', mcp: true }] },
      { type: 'tool_call', calls: [{ name: 'patch_agent_set' }], streaming: true },
    ]);
  });
});
