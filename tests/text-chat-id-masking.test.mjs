// database-test-wrapper sets the POSTGRES_* env for the standard test container
// BEFORE lib/database.js is imported (text-chat.js pulls it in transitively),
// and its teardown closes the import-time connections so jest can exit.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

const { createChatSession } = await import('../lib/text-chat.js');

// slimResults is the ONE seam every tool result crosses to reach the LLM
// conversation, and therefore where an internal id stops being something the
// model can quote at a user. lib/mask-ids.js owns the rewriting and is pinned
// on its own in mask-ids.test.mjs; these pin the WIRING — that a failed save is
// masked in place, and that a successful one keeps the ids the builder needs.
//
// The regression: a builder session whose placeholder set had been deleted
// mid-conversation told the user "Agent set <uuid> not found."

const ID = '00000000-0000-4000-8000-000000000001';
const ID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

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

/** A session whose function list names the set tools, so platformOf resolves. */
function makeSession() {
  const session = createChatSession({ agent, logger });
  session.functions = [
    { name: 'patch_agent_set', platform: 'patch_agent_set' },
    { name: 'notify_email_team', platform: 'notify' },
  ];
  return session;
}

describe('slimResults keeps internal ids out of the conversation', () => {
  test('a failed save reaches the model without the id', () => {
    const session = makeSession();
    const [out] = session.slimResults([
      { name: 'patch_agent_set', result: JSON.stringify({ error: `Agent set ${ID} not found` }) },
    ]);
    expect(out.result).not.toMatch(ID_SHAPE);
    // The failure itself still arrives — the model has to read it to recover.
    expect(JSON.parse(out.result).error).toBe('Agent set not found');
  });

  test('a successful save keeps the ids label resolution produced', () => {
    // test_agent resolves a label to an agent id from exactly this stub.
    const session = makeSession();
    const [out] = session.slimResults([
      {
        name: 'patch_agent_set',
        result: JSON.stringify({
          id: ID,
          name: 'Reception',
          agents: [{ label: 'front', id: '00000000-0000-4000-8000-000000000002', name: 'Front desk' }],
        }),
      },
    ]);
    const parsed = JSON.parse(out.result);
    expect(parsed).toMatchObject({ saved: true, id: ID, name: 'Reception' });
    expect(parsed.members[0]).toMatchObject({ label: 'front', id: '00000000-0000-4000-8000-000000000002' });
  });

  test('a failure from a NON-set tool is masked too', () => {
    // The leak is not specific to set saves: any tool error the model reads is
    // one it can relay. Masking runs before the set-platform branch.
    const session = makeSession();
    const [out] = session.slimResults([
      { name: 'notify_email_team', result: JSON.stringify({ error: `agent ${ID} has no verified members` }) },
    ]);
    expect(out.result).not.toMatch(ID_SHAPE);
  });

  test('results with nothing to mask are passed through by identity', () => {
    // Rebuilding every result would churn the array for no reason.
    const session = makeSession();
    const input = [{ name: 'notify_email_team', result: JSON.stringify({ ok: true }) }];
    expect(session.slimResults(input)[0]).toBe(input[0]);
  });
});
