// database-test-wrapper sets the POSTGRES_* env for the standard test container
// BEFORE lib/database.js is imported (text-chat.js pulls it in transitively),
// and its teardown closes the import-time connections so jest can exit.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

const { createChatSession } = await import('../lib/text-chat.js');

// The `review_result` websocket frame ({type:'review_result', id, result}) that
// resolves a paused `request_review` tool call — the channel polite-ai uses to
// hand the builder its independent-review findings. Mirrors the test_result
// guard rails: strict id match, no-op without a pending call, claim-at-ENQUEUE,
// and resumption as a HIDDEN turn (findings ride the tool-call context). Unlike
// test_result there is deliberately NO id-less form.

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
  session.runTurn = (text, send, hidden = false, claimed = null) => {
    turns.push({ text, hidden, claimed });
    return Promise.resolve();
  };
  return { session, turns };
}

const findings = '{"overall":"Solid, but no transfers.","findings":[{"severity":"high","area":"Transfers"}]}';

describe('text-chat review_result frame', () => {
  test('matching id claims the pending at enqueue and resumes as a hidden turn', async () => {
    const { session, turns } = makeSession();
    session.pending = { toolUseId: 'toolu_1', otherResults: [], platform: 'request_review' };
    await session.reviewResult({ type: 'review_result', id: 'toolu_1', result: findings }, () => {});
    expect(turns).toEqual([
      {
        text: findings,
        hidden: true,
        claimed: { toolUseId: 'toolu_1', otherResults: [], platform: 'request_review' },
      },
    ]);
    // Claimed at enqueue: a duplicate frame or later user message can't recapture it.
    expect(session.pending).toBeNull();
  });

  test('mismatched id is ignored (a stale frame cannot hijack another turn)', async () => {
    const { session, turns } = makeSession();
    session.pending = { toolUseId: 'toolu_1', otherResults: [], platform: 'request_review' };
    await session.reviewResult({ type: 'review_result', id: 'toolu_2', result: findings }, () => {});
    expect(turns).toEqual([]);
    expect(session.pending).toEqual({ toolUseId: 'toolu_1', otherResults: [], platform: 'request_review' });
  });

  test('missing id is ignored (no id-less form for reviews)', async () => {
    const { session, turns } = makeSession();
    session.pending = { toolUseId: 'toolu_1', otherResults: [], platform: 'request_review' };
    await session.reviewResult({ type: 'review_result', result: findings }, () => {});
    expect(turns).toEqual([]);
  });

  test('no pending tool call is a no-op', async () => {
    const { session, turns } = makeSession();
    await session.reviewResult({ type: 'review_result', id: 'toolu_1', result: findings }, () => {});
    expect(turns).toEqual([]);
  });

  test('duplicate frame after the claim is ignored', async () => {
    const { session, turns } = makeSession();
    session.pending = { toolUseId: 'toolu_1', otherResults: [], platform: 'request_review' };
    await session.reviewResult({ type: 'review_result', id: 'toolu_1', result: findings }, () => {});
    await session.reviewResult({ type: 'review_result', id: 'toolu_1', result: findings }, () => {});
    expect(turns).toHaveLength(1);
  });
});
