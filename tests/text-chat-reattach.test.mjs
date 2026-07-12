// database-test-wrapper sets the POSTGRES_* env for the standard test container
// BEFORE lib/database.js is imported (text-chat.js pulls it in transitively),
// and its teardown closes the import-time connections so jest can exit.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

const { createChatSession, getChatSession } = await import('../lib/text-chat.js');
const { trimVoicesResult } = await import('../lib/function-handler.js');

// Session re-attach: after the websocket drops, the session (and its whole LLM
// conversation) lingers for a grace window; a new socket for the same id
// rebinds instead of the client re-paying the full seed + playbook in a fresh
// session. These tests pin the lifecycle: first attach runs the opening turn,
// re-attach doesn't; frames produced while detached flush from the outbox; a
// pending interactive ask is re-emitted; and a second concurrent socket is
// rejected.

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

/** Minimal ws double: records sent frames, exposes its handlers. */
function makeWs() {
  const ws = {
    OPEN: 1,
    readyState: 1,
    sent: [],
    handlers: {},
    send(raw) { this.sent.push(JSON.parse(raw)); },
    on(ev, fn) { this.handlers[ev] = fn; },
    close() { this.readyState = 3; },
  };
  return ws;
}

function makeSession() {
  const session = createChatSession({ agent, logger });
  const turns = [];
  session.buildLlm = async () => {}; // no LLM in these tests
  session.runTurn = (text, send, hidden = false, claimed = null) => {
    turns.push({ text, hidden, claimed });
    return Promise.resolve();
  };
  return { session, turns };
}

describe('text-chat session re-attach', () => {
  test('first attach announces itself and runs the opening turn once', async () => {
    const { session, turns } = makeSession();
    const ws = makeWs();
    await session.handleChat(ws);
    expect(ws.sent[0]).toEqual({ type: 'attached', resumed: false, busy: false });
    expect(turns).toHaveLength(1);
    expect(turns[0].hidden).toBe(true);
  });

  test('re-attach after a drop rebinds without a new opening turn and flushes the outbox', async () => {
    const { session, turns } = makeSession();
    const ws1 = makeWs();
    await session.handleChat(ws1);
    expect(turns).toHaveLength(1);

    // Drop the socket: the session lingers (grace) rather than being deleted.
    ws1.readyState = 3;
    ws1.handlers.close();
    expect(getChatSession(session.id)).toBe(session);

    // A frame produced while detached is buffered, not lost.
    session.send({ type: 'agent', text: 'finished while you were away' });

    const ws2 = makeWs();
    await session.handleChat(ws2);
    expect(turns).toHaveLength(1); // no second opening turn
    expect(ws2.sent[0]).toEqual({ type: 'attached', resumed: true, busy: false });
    expect(ws2.sent[1]).toEqual({ type: 'agent', text: 'finished while you were away' });
  });

  test('re-attach re-emits a pending interactive ask', async () => {
    const { session } = makeSession();
    const ws1 = makeWs();
    await session.handleChat(ws1);
    const frame = { type: 'question', id: 'toolu_q', question: 'Which channel?', options: [], multiSelect: false };
    session.pending = { toolUseId: 'toolu_q', otherResults: [], platform: 'ask_user', frame };

    ws1.readyState = 3;
    ws1.handlers.close();
    const ws2 = makeWs();
    await session.handleChat(ws2);
    expect(ws2.sent).toContainEqual(frame);
  });

  test('a second concurrent socket TAKES OVER (newest wins; half-open old sockets must not block)', async () => {
    const { session, turns } = makeSession();
    const ws1 = makeWs();
    await session.handleChat(ws1);
    const ws2 = makeWs();
    await session.handleChat(ws2);
    // The old socket is told and closed; the session now speaks to the new one.
    expect(ws1.sent.at(-1)?.type).toBe('error');
    expect(ws1.readyState).toBe(3); // closed
    expect(session.ws).toBe(ws2);
    expect(ws2.sent[0]).toEqual({ type: 'attached', resumed: true, busy: false });
    expect(turns).toHaveLength(1); // still no second opening turn
  });

  test('a pause reached while detached is delivered exactly once on re-attach', async () => {
    const { session } = makeSession();
    const ws1 = makeWs();
    await session.handleChat(ws1);
    ws1.readyState = 3;
    ws1.handlers.close();
    // The pause frame goes through send() while detached (outbox) AND onto
    // this.pending — re-attach must not deliver it twice.
    const frame = { type: 'question', id: 'toolu_q', question: 'Which?', options: [], multiSelect: false };
    session.pending = { toolUseId: 'toolu_q', otherResults: [], platform: 'ask_user', frame };
    session.send(frame);
    const ws2 = makeWs();
    await session.handleChat(ws2);
    expect(ws2.sent.filter((f) => f.type === 'question')).toHaveLength(1);
  });

  test('buildLlm failure tears the session down instead of leaving a zombie', async () => {
    const { session } = makeSession();
    session.buildLlm = async () => { throw new Error('no such model'); };
    const ws = makeWs();
    await session.handleChat(ws);
    expect(getChatSession(session.id)).toBeUndefined();
  });

  test('teardown finalises and removes the session', async () => {
    const { session } = makeSession();
    const ws = makeWs();
    await session.handleChat(ws);
    session.teardown();
    expect(getChatSession(session.id)).toBeUndefined();
  });
});

describe('list_voices payload bound', () => {
  test('long descriptions are capped and oversized vendor lists truncated with a note', () => {
    const voices = Array.from({ length: 70 }, (_, i) => ({
      name: `voice-${i}`,
      gender: 'female',
      description: 'd'.repeat(300),
    }));
    const out = trimVoicesResult({ vendors: { elevenlabs: voices, cartesia: voices.slice(0, 3) }, voiceStack: 'pipeline' });
    expect(out.vendors.elevenlabs).toHaveLength(61); // 60 + trailing note
    expect(out.vendors.elevenlabs[60].note).toMatch(/10 more elevenlabs voices/);
    expect(out.vendors.elevenlabs[0].description.length).toBeLessThanOrEqual(101);
    expect(out.vendors.cartesia).toHaveLength(3);
    expect(out.voiceStack).toBe('pipeline');
  });

  test('locale-list results (no vendors) pass through untouched', () => {
    const result = { locales: ['en-GB', 'any'], voiceStack: 'realtime' };
    expect(trimVoicesResult(result)).toBe(result);
  });
});
