// database-test-wrapper sets the POSTGRES_* env for the standard test container
// BEFORE lib/database.js is imported (text-chat.js pulls it in transitively),
// and its teardown closes the import-time connections so jest can exit.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

const { createChatSession } = await import('../lib/text-chat.js');

// Verify failed tool results are masked at slimResults while successful saves retain ids needed by later tools. See
// PR #257.

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
async function makeSession() {
  const session = await createChatSession({ agent, logger });
  session.functions = [
    { name: 'patch_agent_set', platform: 'patch_agent_set' },
    { name: 'notify_email_team', platform: 'notify' },
  ];
  return session;
}

describe('slimResults keeps internal ids out of the conversation', () => {
  test('a failed save reaches the model without the id', async () => {
    const session = await makeSession();
    const [out] = session.slimResults([
      { name: 'patch_agent_set', result: JSON.stringify({ error: `Agent set ${ID} not found` }) },
    ]);
    expect(out.result).not.toMatch(ID_SHAPE);
    // The failure itself still arrives — the model has to read it to recover.
    expect(JSON.parse(out.result).error).toBe('Agent set not found');
  });

  test('a successful save keeps the ids label resolution produced', async () => {
    // test_agent resolves a label to an agent id from exactly this stub.
    const session = await makeSession();
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

  test('the stub names each member\'s resulting functions, options and mcpServers', async () => {
    // Report replaced field names so the model can detect lost functions, options or MCP servers after a save.
    // Exercise both function storage shapes; see PRs #332, #333 and #334.
    const session = await makeSession();
    const [out] = session.slimResults([
      {
        name: 'patch_agent_set',
        result: JSON.stringify({
          id: ID,
          name: 'Reception',
          agents: [
            { label: 'front', id: '00000000-0000-4000-8000-000000000002', name: 'Front desk',
              functions: [{ name: 'end_call' }, { name: 'to_engineer' }],
              options: { transferTone: true, maxDuration: 900, inactivity: { hangup: true } } },
            { label: 'backend', id: '00000000-0000-4000-8000-000000000003', name: 'Backend',
              functions: { search_docs: { implementation: 'rest' } },
              options: { effort: 'medium', fallback: null },
              mcpServers: [{ name: 'knowledge', url: 'https://k.example.com/mcp' },
                { name: 'crm', url: 'https://c.example.com/mcp' }] },
            { label: 'bare', id: '00000000-0000-4000-8000-000000000004', name: 'Bare' },
          ],
        }),
      },
    ]);
    const { members } = JSON.parse(out.result);
    expect(members.map((m) => m.functions)).toEqual([
      ['end_call', 'to_engineer'],
      ['search_docs'],
      [],
    ]);
    // Sorted, so two saves diff cleanly; an option set to null is not set.
    expect(members.map((m) => m.options)).toEqual([
      ['inactivity', 'maxDuration', 'transferTone'],
      ['effort'],
      [],
    ]);
    // Tool servers in document order: the name is what namespaces their tools.
    expect(members.map((m) => m.mcpServers)).toEqual([[], ['knowledge', 'crm'], []]);
  });

  test('an option or mcpServers VALUE never reaches the conversation', async () => {
    // Return names only: option values, MCP URLs and headers may contain credentials or phone numbers. See PR #334.
    const session = await makeSession();
    const [out] = session.slimResults([
      {
        name: 'patch_agent_set',
        result: JSON.stringify({
          id: ID,
          name: 'Reception',
          agents: [
            { label: 'front', id: '00000000-0000-4000-8000-000000000002', name: 'Front desk',
              options: { fallback: { number: '+441632960123' }, recording: { enabled: true, key: 'enc:abc123' } },
              mcpServers: [{ name: 'crm', url: 'https://c.example.com/mcp?t=urltoken',
                headers: { Authorization: 'Bearer inlinetoken' }, key: 'POLITE_MCP' }] },
          ],
        }),
      },
    ]);
    expect(out.result).not.toContain('441632960123');
    expect(out.result).not.toContain('enc:abc123');
    expect(out.result).not.toContain('inlinetoken');
    expect(out.result).not.toContain('urltoken');
    const [member] = JSON.parse(out.result).members;
    expect(member.options).toEqual(['fallback', 'recording']);
    expect(member.mcpServers).toEqual(['crm']);
  });

  test('a failure from a NON-set tool is masked too', async () => {
    // The leak is not specific to set saves: any tool error the model reads is
    // one it can relay. Masking runs before the set-platform branch.
    const session = await makeSession();
    const [out] = session.slimResults([
      { name: 'notify_email_team', result: JSON.stringify({ error: `agent ${ID} has no verified members` }) },
    ]);
    expect(out.result).not.toMatch(ID_SHAPE);
  });

  test('results with nothing to mask are passed through by identity', async () => {
    // Rebuilding every result would churn the array for no reason.
    const session = await makeSession();
    const input = [{ name: 'notify_email_team', result: JSON.stringify({ ok: true }) }];
    expect(session.slimResults(input)[0]).toBe(input[0]);
  });
});
