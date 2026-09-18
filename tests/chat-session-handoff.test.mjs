import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  setupRealDatabase,
  teardownRealDatabase,
  Organisation,
  User,
  Agent,
} from './setup/database-test-wrapper.js';
import { FakeChatLlm } from './fixtures/fake-chat-llm.mjs';
import { FakeWs } from './fixtures/fake-ws.mjs';

// Short handover wait so the "holder never answers" case does not dominate
// the run. Read at module load by lib/text-chat.js, in this process and in
// the peer processes it spawns (they inherit the environment).
process.env.TEXT_CHAT_HANDOFF_WAIT_MS = '3000';
const HANDOFF_WAIT_MS = 3000;
// Agent.create validates the model against the roster, which needs the key.
process.env.ANTHROPIC_API_KEY ||= 'test-key';

// A chat session is held by ONE server process at a time, and moves.
//
// The websocket for `/chat/<id>` can reach any process behind the load
// balancer, on the first attach and on every reconnect. The row in
// chat_sessions says who holds the session; a process that receives a socket
// for a session it does not hold claims the row, asking a live holder to let
// go at its next turn boundary, and carries the conversation on from the
// snapshot in the row. A holder that has died, or does not answer, has the
// row taken from it and drops the session on its next write.
//
// The other process here is real: tests/fixtures/chat-peer.mjs, a separate
// node process against the same database. A single-process stand-in could not
// show that the LISTEN/NOTIFY request, the conditional writes and the
// rehydration work across processes, which is the whole point.
describe('chat session ownership across processes', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const peer = join(here, 'fixtures', 'chat-peer.mjs');

  const mockLogger = {
    info() {}, warn() {}, error() {}, debug() {}, trace() {},
    child() { return this; },
  };

  let textChat;
  let ChatSession;
  let PROCESS_ID;
  let orgId;
  let userId;
  let agent;        // a tenant text agent: its sessions are ephemeral
  let builderAgent; // an org-pushed builder: its sessions are history

  // State carried between the ordered tests below.
  const shared = {};

  beforeAll(async () => {
    await setupRealDatabase();
    textChat = await import('../lib/text-chat.js');
    ({ ChatSession } = await import('../lib/database.js'));
    ({ PROCESS_ID } = await import('../lib/process-id.js'));
    await ChatSession.sync({ alter: true });
    textChat.setChatLlmFactory(() => new FakeChatLlm({ tag: 'A' }));
    await textChat.startChatOwnershipListener({ log: mockLogger });

    orgId = randomUUID();
    userId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Handoff Org' });
    await User.create({
      id: userId, name: 'Handoff User', email: `handoff-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '',
      role: 'owner', organisationId: orgId,
    });
    agent = await Agent.create({
      name: 'Handoff agent', type: 'text', modelName: 'text:anthropic/claude-sonnet-5',
      prompt: 'You are a test agent.', userId, organisationId: orgId,
    });
    builderAgent = await Agent.create({
      name: 'Pushed builder', description: 'Team builder [polite:agent-builder]', type: 'text',
      modelName: 'text:anthropic/claude-sonnet-5', prompt: 'You build teams.', userId, organisationId: orgId,
    });
  }, 60000);

  afterAll(async () => {
    try {
      await textChat.releaseAllChatSessions({ log: mockLogger });
      await textChat.stopChatOwnershipListener();
      await ChatSession.destroy({ where: { organisationId: orgId } });
      await Agent.destroy({ where: { organisationId: orgId } });
      await User.destroy({ where: { id: userId } });
      await Organisation.destroy({ where: { id: orgId } });
    } finally {
      await teardownRealDatabase();
    }
  }, 60000);

  // A browser reconnecting through the load balancer to ANOTHER server
  // process: the peer claims the session, optionally sends one message, and
  // reports what it saw. By default it releases on exit, as a server does on
  // SIGTERM; with `keep` it exits still holding the row, like a crash.
  function runPeer(spec) {
    const env = { ...process.env, NODE_ENV: 'test', LOGLEVEL: 'silent' };
    delete env.DB_FORCE_SYNC; // never alter-sync the schema under a running suite
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [peer, JSON.stringify(spec)], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`chat peer exited ${code}: ${err || out}`));
        try {
          resolve(JSON.parse(out.trim().split('\n').pop()));
        } catch {
          reject(new Error(`chat peer output was not JSON: ${out}\n${err}`));
        }
      });
    });
  }

  async function waitFor(pred, what, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      if (await pred()) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 50); });
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  const open = (over = {}) => textChat.openChatSession({ agent, logger: mockLogger, ...over }).then((r) => r.id);
  const attach = (id, ws) => textChat.attachChatSession(id, ws, { logger: mockLogger });
  const row = (id) => ChatSession.findByPk(id);

  test('opening a session writes an unowned row and builds nothing anywhere', async () => {
    const id = await open();
    const r = await row(id);
    expect(r.owner).toBeNull();
    expect(r.ephemeral).toBe(true);
    expect(r.state).toMatchObject({ v: 1, everConnected: false });
    expect(r.state.seed).toBeDefined();
    expect(textChat.getChatSession(id)).toBeUndefined();
    expect(await textChat.probeChatSession(id)).toBe(true);
    expect(await textChat.probeChatSession(randomUUID())).toBe(false);
    expect(await textChat.probeChatSession('not-a-uuid')).toBe(false);
    shared.id = id;
  });

  test('the process that receives the socket claims the row and snapshots the conversation per turn', async () => {
    const { id } = shared;
    const ws = new FakeWs();
    await attach(id, ws);
    // The opening turn ran here, as a first attach.
    expect(ws.ofType('attached')).toEqual([{ type: 'attached', resumed: false, busy: false }]);
    expect(ws.ofType('agent')).toHaveLength(1);
    ws.say('hello from A');
    await ws.waitFor((f) => f.type === 'agent' && /hello from A/.test(f.text), { what: 'reply to A' });
    const session = textChat.getChatSession(id);
    await session.lastPersist;
    const r = await row(id);
    expect(r.owner).toBe(PROCESS_ID);
    expect(r.state.everConnected).toBe(true);
    expect(r.state.seed).toBeNull(); // spent
    expect(r.state.conversation).toMatchObject({ driver: 'fake' });
    expect(r.state.conversation.messages).toHaveLength(session.llm.messages.length);
    shared.ws = ws;
    shared.count = session.llm.messages.length;
    shared.llmA = session.llm;
  });

  test('a reconnect on ANOTHER process takes the session over, live, with the conversation intact', async () => {
    const { id, ws, count, llmA } = shared;
    ws.close(); // the browser went away; this process keeps the session for the re-attach grace
    const out = await runPeer({ id, say: 'hello from B', tag: 'B' });
    expect(out.held).toBe(true);
    expect(out.ownerAfterClaim).toBe(out.processId);
    // B started from A's conversation, not from scratch...
    expect(out.imported).toBe(count);
    expect(out.messages).toBe(count + 2);
    // ...answered the reconnect at once (provisional) and again once rehydrated...
    expect(out.frames.filter((f) => f.type === 'attached')).toEqual([
      { type: 'attached', resumed: true, busy: true },
      { type: 'attached', resumed: true, busy: false },
    ]);
    expect(out.frames.some((f) => f.type === 'agent' && /hello from B/.test(f.text))).toBe(true);
    // ...and did not have to wait the holder out: this process let go when asked.
    expect(out.attachedMs).toBeLessThan(HANDOFF_WAIT_MS);
    // This process let the session go: nothing held, the driver's connections closed,
    // and once B exited (releasing, as a server does on SIGTERM) the row is free.
    expect(textChat.getChatSession(id)).toBeUndefined();
    expect(llmA.closed).toBe(true);
    const r = await row(id);
    expect(r.owner).toBeNull();
    expect(r.endedAt).toBeNull();
    expect(r.state.conversation.messages).toHaveLength(count + 2);
    shared.count = count + 2;
  }, 60000);

  test('and back: this process re-attaches to the conversation B left in the row', async () => {
    const { id, count } = shared;
    const ws = new FakeWs();
    await attach(id, ws);
    // Unowned row: no wait, so no provisional frame.
    expect(ws.ofType('attached')).toEqual([{ type: 'attached', resumed: true, busy: false }]);
    const session = textChat.getChatSession(id);
    expect(session.llm.imported).toBe(count);
    ws.say('and again from A');
    await ws.waitFor((f) => f.type === 'agent' && /and again from A/.test(f.text), { what: 'reply after resume' });
    await session.lastPersist;
    expect((await row(id)).owner).toBe(PROCESS_ID);
    shared.ws = ws;
    shared.count = count + 2;
  });

  test('a session whose holder has died is taken at once', async () => {
    const { id } = shared;
    await textChat.getChatSession(id).release();
    expect(textChat.getChatSession(id)).toBeUndefined();
    // A holder that stopped beating ten minutes ago.
    await ChatSession.update({ owner: 'ghost:1:dead', lastSeenAt: new Date(Date.now() - 10 * 60 * 1000) }, { where: { id } });
    const ws = new FakeWs();
    const t0 = Date.now();
    await attach(id, ws);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(ws.ofType('attached')).toEqual([{ type: 'attached', resumed: true, busy: false }]);
    expect((await row(id)).owner).toBe(PROCESS_ID);
    shared.ws = ws;
  });

  test('a holder that does not answer loses the session when the wait runs out', async () => {
    const { id } = shared;
    await textChat.getChatSession(id).release();
    // B takes the session and exits without releasing: to the row, a fresh,
    // live holder that will never answer.
    const out = await runPeer({ id, keep: true, tag: 'B2' });
    expect(out.held).toBe(true);
    expect((await row(id)).owner).toBe(out.processId);
    const ws = new FakeWs();
    const t0 = Date.now();
    await attach(id, ws);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(HANDOFF_WAIT_MS - 200);
    expect(elapsed).toBeLessThan(HANDOFF_WAIT_MS + 5000);
    expect(ws.ofType('attached').map((f) => f.resumed)).toEqual([true, true]);
    expect((await row(id)).owner).toBe(PROCESS_ID);
    expect(textChat.getChatSession(id).llm.imported).toBe(shared.count);
    shared.ws = ws;
  }, 60000);

  test('a process whose row was taken drops the session on its next write, ending nothing', async () => {
    const { id, ws } = shared;
    const session = textChat.getChatSession(id);
    // Another process has taken the row (as a forced claim does).
    await ChatSession.update({ owner: 'thief:2:x' }, { where: { id } });
    await session.persistTurn();
    expect(session.released).toBe(true);
    expect(textChat.getChatSession(id)).toBeUndefined();
    expect(session.llm.closed).toBe(true);
    expect(ws.frames.at(-1)).toMatchObject({ type: 'error', code: 'superseded' });
    const r = await row(id);
    expect(r.owner).toBe('thief:2:x');
    expect(r.endedAt).toBeNull();
    await ChatSession.destroy({ where: { id } });
  });

  test("an ephemeral session's row goes when the session ends; a builder session's stays as history", async () => {
    const id = await open();
    let ws = new FakeWs();
    await attach(id, ws);
    textChat.getChatSession(id).teardown();
    await waitFor(async () => !(await row(id)), 'ephemeral row deletion');
    expect(await textChat.probeChatSession(id)).toBe(false);

    const { id: bid } = await textChat.openChatSession({ agent: builderAgent, logger: mockLogger });
    expect((await row(bid)).ephemeral).toBe(false);
    ws = new FakeWs();
    await attach(bid, ws);
    ws.say('build me a team');
    await ws.waitFor((f) => f.type === 'agent' && /build me a team/.test(f.text), { what: 'builder reply' });
    const session = textChat.getChatSession(bid);
    await session.lastPersist;
    session.teardown();
    await waitFor(async () => !!(await row(bid))?.endedAt, 'builder row end');
    const r = await row(bid);
    expect(r.owner).toBeNull();
    expect(r.state).toBeNull(); // nothing left to hand over
    expect(r.turns).toBe(1);
    expect(r.transcript.map((e) => e.role)).toEqual(['agent', 'user', 'agent']);
  });

  test('the reaper removes ended ephemeral rows', async () => {
    const id = randomUUID();
    const ago = new Date(Date.now() - 60 * 60 * 1000);
    await ChatSession.create({
      id, agentId: agent.id, organisationId: orgId, userId, startedAt: ago, lastSeenAt: ago, endedAt: ago,
      ephemeral: true, turns: 0,
    });
    await textChat.reapStaleChatSessions({ log: mockLogger });
    expect(await row(id)).toBeNull();
  });
});
