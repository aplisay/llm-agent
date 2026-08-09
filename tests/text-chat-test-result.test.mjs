// database-test-wrapper sets the POSTGRES_* env for the standard test container
// BEFORE lib/database.js is imported (text-chat.js pulls it in transitively),
// and its teardown closes the import-time connections so jest can exit.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

const { createChatSession } = await import('../lib/text-chat.js');

// The explicit `test_result` websocket frame ({type:'test_result', id, result})
// that resolves a pending test_agent tool call — the unambiguous channel used
// by clients that drive their own in-browser test flow (polite-ai). The legacy
// protocol (next plain `user` message resumes the pending call) is untouched.
// These tests pin the guard rails: strict id match, no-op without a pending
// call, claim-at-ENQUEUE semantics (a pending is consumed when its answering
// frame arrives, so a pending created by an intervening turn can never capture
// a message that predates it), and resumption as a hidden turn.

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

function makeSession() {
  const session = createChatSession({ agent, logger });
  const turns = [];
  // turn() claims the pending and enqueues runTurn — stub the run itself so
  // the claim semantics are exercised without an LLM.
  session.runTurn = (text, send, hidden = false, claimed = null) => {
    turns.push({ text, hidden, claimed });
    return Promise.resolve();
  };
  return { session, turns };
}

describe('text-chat test_result frame', () => {
  test('matching id claims the pending at enqueue and resumes as a hidden turn', async () => {
    const { session, turns } = makeSession();
    session.pending = { toolUseId: 'toolu_1', otherResults: [], platform: 'test_agent' };
    await session.testResult({ type: 'test_result', id: 'toolu_1', result: '{"ok":true,"legs":[]}' }, () => {});
    expect(turns).toEqual([
      {
        text: '{"ok":true,"legs":[]}',
        hidden: true,
        claimed: { toolUseId: 'toolu_1', otherResults: [], platform: 'test_agent' },
      },
    ]);
    // Claimed at enqueue: a duplicate frame or a later user message can no
    // longer capture this pending.
    expect(session.pending).toBeNull();
  });

  test('mismatched id is ignored (a stale frame cannot hijack another turn)', async () => {
    const { session, turns } = makeSession();
    session.pending = { toolUseId: 'toolu_1', otherResults: [], platform: 'test_agent' };
    await session.testResult({ type: 'test_result', id: 'toolu_2', result: '{"ok":true}' }, () => {});
    expect(turns).toEqual([]);
    expect(session.pending).toEqual({ toolUseId: 'toolu_1', otherResults: [], platform: 'test_agent' });
  });

  test('missing id is ignored', async () => {
    const { session, turns } = makeSession();
    session.pending = { toolUseId: 'toolu_1', otherResults: [], platform: 'test_agent' };
    await session.testResult({ type: 'test_result', result: '{"ok":true}' }, () => {});
    expect(turns).toEqual([]);
  });

  test('no pending tool call is a no-op', async () => {
    const { session, turns } = makeSession();
    await session.testResult({ type: 'test_result', id: 'toolu_1', result: '{"ok":false}' }, () => {});
    expect(turns).toEqual([]);
  });

  test('duplicate frame after the claim is ignored', async () => {
    const { session, turns } = makeSession();
    session.pending = { toolUseId: 'toolu_1', otherResults: [], platform: 'test_agent' };
    await session.testResult({ type: 'test_result', id: 'toolu_1', result: '{"ok":true}' }, () => {});
    await session.testResult({ type: 'test_result', id: 'toolu_1', result: '{"ok":true}' }, () => {});
    expect(turns).toHaveLength(1);
  });

  test('legacy protocol: a plain user turn claims the pending at enqueue', async () => {
    const { session, turns } = makeSession();
    session.pending = { toolUseId: 'toolu_9', otherResults: [], platform: 'ask_user' };
    await session.turn('the answer', () => {});
    expect(turns).toEqual([
      {
        text: 'the answer',
        hidden: false,
        claimed: { toolUseId: 'toolu_9', otherResults: [], platform: 'ask_user' },
      },
    ]);
    expect(session.pending).toBeNull();
  });
});

describe('text-chat slimResults', () => {
  const setAgent = {
    ...agent,
    functions: [
      { name: 'create_agent_set', platform: 'create_agent_set' },
      { name: 'list_voices', platform: 'list_voices' },
    ],
  };
  const fullSet = JSON.stringify({
    id: 'set-1',
    name: 'Team',
    description: 'a team',
    agents: [
      { id: 'a-1', label: 'main', name: 'Main', prompt: 'x'.repeat(4000), functions: [] },
      { id: 'a-2', label: 'sales', name: 'Sales', prompt: 'y'.repeat(4000), functions: [] },
    ],
  });

  test('a save result is replaced with a stub carrying the post-save identities', () => {
    const session = createChatSession({ agent: setAgent, logger });
    const [slim] = session.slimResults([{ name: 'create_agent_set', result: fullSet }]);
    const parsed = JSON.parse(slim.result);
    expect(parsed).toEqual({
      saved: true,
      id: 'set-1',
      name: 'Team',
      members: [
        { label: 'main', id: 'a-1', name: 'Main' },
        { label: 'sales', id: 'a-2', name: 'Sales' },
      ],
    });
    expect(slim.result.length).toBeLessThan(fullSet.length / 10);
  });

  test('save FAILURES and non-set tools pass through verbatim', () => {
    const session = createChatSession({ agent: setAgent, logger });
    const error = JSON.stringify({ error: 'validation failed: agents[0].functions[0] …' });
    const voices = JSON.stringify({ locales: ['en-GB'] });
    const results = session.slimResults([
      { name: 'create_agent_set', result: error },
      { name: 'list_voices', result: voices },
      { name: 'create_agent_set', result: 'not json' },
    ]);
    expect(results[0].result).toBe(error);
    expect(results[1].result).toBe(voices);
    expect(results[2].result).toBe('not json');
  });
});
