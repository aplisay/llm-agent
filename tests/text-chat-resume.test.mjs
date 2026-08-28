// database-test-wrapper sets the POSTGRES_* env for the standard test container
// BEFORE lib/database.js is imported (text-chat.js pulls it in transitively),
// and its teardown closes the import-time connections so jest can exit.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

const { createChatSession, sanitizeHistory } = await import('../lib/text-chat.js');

// RESUME seeding (2026-08-28 beta session s_85a0afe1): a session that replaces
// one lost to a server restart is started with the prior conversation as
// `history`, and its hidden opening turn becomes a resume — continue the
// embedded transcript, don't re-greet, don't re-ask answered questions, agreed
// names stand. These tests pin the sanitiser's caps, the resume prompt's
// contract, and the named-placeholder rule that stops a restarted build
// re-proposing names for a team the predecessor already named.

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

describe('sanitizeHistory', () => {
  test('keeps user/agent/system entries and drops everything else', () => {
    const out = sanitizeHistory([
      { role: 'user', text: 'hello' },
      { role: 'agent', text: 'hi' },
      { role: 'system', text: 'note' },
      { role: 'review', text: 'nope' },
      { role: 'user', text: '' },
      'garbage',
      null,
    ]);
    expect(out).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'agent', text: 'hi' },
      { role: 'system', text: 'note' },
    ]);
  });

  test('returns null for non-arrays and for arrays with nothing usable', () => {
    expect(sanitizeHistory(undefined)).toBeNull();
    expect(sanitizeHistory('hello')).toBeNull();
    expect(sanitizeHistory([{ role: 'user', text: '' }])).toBeNull();
  });

  test('caps entry count keeping the newest, with an elision marker', () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ role: 'user', text: `m${i}` }));
    const out = sanitizeHistory(many);
    // 200 kept + 1 marker.
    expect(out).toHaveLength(201);
    expect(out[0]).toEqual({ role: 'system', text: '[… earlier conversation trimmed …]' });
    expect(out[1].text).toBe('m50');
    expect(out[out.length - 1].text).toBe('m249');
  });

  test('caps total characters by dropping the oldest entries', () => {
    const big = 'x'.repeat(4000);
    const entries = Array.from({ length: 20 }, () => ({ role: 'agent', text: big }));
    const out = sanitizeHistory(entries);
    const total = out.reduce((n, e) => n + e.text.length, 0);
    expect(total).toBeLessThanOrEqual(40000 + out[0].text.length);
    expect(out[0]).toEqual({ role: 'system', text: '[… earlier conversation trimmed …]' });
  });

  test('truncates a single oversized entry', () => {
    const out = sanitizeHistory([{ role: 'user', text: 'y'.repeat(9000) }]);
    expect(out).toHaveLength(1);
    expect(out[0].text).toHaveLength(4000);
  });
});

describe('resume seeding', () => {
  const history = [
    { role: 'user', text: 'article summaries' },
    { role: 'agent', text: 'Here’s the proposed one-agent design: Article Guide with the Olivia voice.' },
    { role: 'agent', text: 'Should I build this Article Guide? (options: Yes — build as proposed / Change it)' },
  ];

  test('a session seeded with history opens with the resume prompt', () => {
    const session = createChatSession({
      agent,
      set: { id: 'set-1', name: 'Article Summary Line', agents: [] },
      history,
      resumedFrom: '09d05a62-28aa-4a3f-add3-62389fc4bf9b',
      logger,
    });
    expect(session.seedHistory).toHaveLength(3);
    expect(session.resumedFrom).toBe('09d05a62-28aa-4a3f-add3-62389fc4bf9b');
    const prompt = session.resumePrompt();
    expect(prompt).toContain('RESUMING');
    expect(prompt).toContain('CONVERSATION SO FAR');
    expect(prompt).toContain('USER: article summaries');
    expect(prompt).toContain('ASSISTANT: Should I build this Article Guide?');
    expect(prompt).toContain('CURRENT SET (JSON)');
    // The predecessor already named the team — the resume must not reopen it.
    expect(prompt).toContain('already named “Article Summary Line”');
    // Empty placeholder: build into it, never create a new set.
    expect(prompt).toContain('NEVER call create_agent_set');
  });

  test('a non-uuid resumedFrom is dropped (the column is UUID-typed)', () => {
    const session = createChatSession({ agent, history, resumedFrom: 'not-a-uuid', logger });
    expect(session.resumedFrom).toBeNull();
  });

  test('a set with members resumes with patch-style save rules', () => {
    const session = createChatSession({
      agent,
      set: { id: 'set-1', name: 'Team', agents: [{ label: 'reception', name: 'Reception' }] },
      history,
      logger,
    });
    const prompt = session.resumePrompt();
    expect(prompt).toContain('patch_agent_set');
    expect(prompt).not.toContain('NEVER call create_agent_set');
  });

  test('a troubleshoot resume re-embeds the test result', () => {
    const session = createChatSession({
      agent,
      testResult: { legs: [{ agentLabel: 'reception', transcript: [] }] },
      history,
      logger,
    });
    const prompt = session.resumePrompt();
    expect(prompt).toContain('TEST RESULT (JSON');
    expect(prompt).toContain('CONVERSATION SO FAR');
  });
});

describe('named-placeholder opening prompt (no resume)', () => {
  test('an already-named empty set keeps its name instead of the name dance', () => {
    const session = createChatSession({
      agent,
      set: { id: 'set-1', name: 'Article Summary Line', agents: [] },
      logger,
    });
    const prompt = session.openingPrompt();
    expect(prompt).toContain('already named “Article Summary Line”');
    expect(prompt).not.toContain('propose a real name');
  });

  test('an Untitled placeholder still gets the name proposal instruction', () => {
    const session = createChatSession({
      agent,
      set: { id: 'set-1', name: 'Untitled team', agents: [] },
      logger,
    });
    const prompt = session.openingPrompt();
    expect(prompt).toContain('propose a real name');
    expect(prompt).not.toContain('already named');
  });
});
