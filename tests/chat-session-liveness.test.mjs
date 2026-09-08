import { setupRealDatabase, teardownRealDatabase, Organisation, User } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

// Liveness of a persisted chat session.
//
// `ended_at IS NULL` used to mean "live", and a boot sweep closed every open
// row on startup to clear the rows a dead process left behind. That only held
// with exactly one server process: nothing recorded WHICH process owned a row,
// so a second one starting (a scale-up, a rolling deploy, a Cloud Run cold
// start) closed the first one's live sessions, and stamped them at the time of
// their last turn so the damage looked plausible. llm-agent runs on autoscaling
// k8s and on Cloud Run, so more than one process is the normal case.
//
// Liveness is now a heartbeat plus a clock, which every process reads the same
// way and which needs no boot-time guess.
describe('chat session liveness', () => {
  let ChatSession;
  let isChatSessionLive;
  let reapStaleChatSessions;
  let listSessions;

  let orgId;
  let userId;

  const mockLogger = {
    info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {},
    child: () => mockLogger,
  };

  const GRACE_MS = 5 * 60 * 1000;
  const ago = (ms) => new Date(Date.now() - ms);

  beforeAll(async () => {
    await setupRealDatabase();
    ({ ChatSession } = await import('../lib/database.js'));
    ({ isChatSessionLive, reapStaleChatSessions } = await import('../lib/text-chat.js'));
    listSessions = (await import('../api/paths/chat-sessions.js')).default(mockLogger).GET;
    await ChatSession.sync({ alter: true });

    orgId = randomUUID();
    userId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Liveness Org' });
    await User.create({
      id: userId, name: 'Liveness User', email: `live-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '',
      role: 'owner', organisationId: orgId,
    });
  }, 30000);

  afterEach(async () => {
    await ChatSession.destroy({ where: { organisationId: orgId } });
  });

  afterAll(async () => {
    await ChatSession.destroy({ where: { organisationId: orgId } });
    await Organisation.destroy({ where: { id: orgId } });
    await teardownRealDatabase();
  }, 30000);

  const mkSession = (over = {}) => ChatSession.create({
    id: randomUUID(),
    agentId: 'builtin:set-builder',
    organisationId: orgId,
    userId,
    mode: 'new',
    startedAt: ago(10 * 60 * 1000),
    lastSeenAt: new Date(),
    ...over,
  });

  describe('isChatSessionLive', () => {
    it('is live while a process is still beating for it', async () => {
      expect(isChatSessionLive({ endedAt: null, lastSeenAt: new Date() })).toBe(true);
      expect(isChatSessionLive({ endedAt: null, lastSeenAt: ago(60 * 1000) })).toBe(true);
    });

    it('goes stale once the grace lapses, with no boot and no sweep', async () => {
      expect(isChatSessionLive({ endedAt: null, lastSeenAt: ago(GRACE_MS + 1000) })).toBe(false);
    });

    it('an ended session is never live, however recent the beat', async () => {
      expect(isChatSessionLive({ endedAt: new Date(), lastSeenAt: new Date() })).toBe(false);
    });

    // Rows written before the column existed. Reporting them live would put a
    // LIVE badge on every historical session the moment this ships.
    it('a row with no heartbeat at all is history, not a live session', async () => {
      expect(isChatSessionLive({ endedAt: null, lastSeenAt: null })).toBe(false);
    });
  });

  // The reaper is deliberately global: a stale session belongs to no process,
  // so there is nothing to scope it by. These tests therefore assert on the
  // rows they created, never on its return count, which any other suite's
  // leftovers would change.
  describe('reapStaleChatSessions', () => {
    // The defect this replaces: a second process starting closed the first
    // one's live sessions, because the sweep keyed on the boot event rather
    // than on evidence about the session.
    it('leaves a session another process is still beating for alone', async () => {
      const live = await mkSession({ lastSeenAt: ago(30 * 1000) });
      await reapStaleChatSessions({ log: mockLogger });
      await live.reload();
      expect(live.endedAt).toBeNull();
      expect(isChatSessionLive(live)).toBe(true);
    });

    it('closes a session no process has spoken for, at its last heartbeat', async () => {
      const lastSeen = ago(GRACE_MS + 60 * 1000);
      const dead = await mkSession({ lastSeenAt: lastSeen });
      await reapStaleChatSessions({ log: mockLogger });
      await dead.reload();
      // Closed AT the last sign of life, not at the moment the reaper noticed.
      expect(dead.endedAt.getTime()).toBe(lastSeen.getTime());
    });

    // Legacy rows carry no heartbeat, so they fall back to updated_at — which
    // is exactly what the old boot sweep closed them at.
    it('closes a pre-heartbeat row using its last write', async () => {
      const legacy = await mkSession({ lastSeenAt: null });
      await ChatSession.sequelize.query(
        'UPDATE chat_sessions SET updated_at = :ts WHERE id = :id',
        { replacements: { ts: ago(GRACE_MS + 60 * 1000), id: legacy.id } },
      );
      await reapStaleChatSessions({ log: mockLogger });
      await legacy.reload();
      expect(legacy.endedAt).not.toBeNull();
    });

    // Two replicas reap at once. The predicate is the whole decision, so the
    // second pass has nothing left to do and no row moves twice.
    it('is idempotent and safe to run concurrently', async () => {
      const lastSeen = ago(GRACE_MS + 60 * 1000);
      const dead = await mkSession({ lastSeenAt: lastSeen });
      await Promise.all([
        reapStaleChatSessions({ log: mockLogger }),
        reapStaleChatSessions({ log: mockLogger }),
      ]);
      await dead.reload();
      // Closed exactly once, at its own last heartbeat: two racing reapers
      // must not stamp it twice, and the second must not move it to `now`.
      expect(dead.endedAt.getTime()).toBe(lastSeen.getTime());
      await reapStaleChatSessions({ log: mockLogger });
      await dead.reload();
      expect(dead.endedAt.getTime()).toBe(lastSeen.getTime());
    });

    // The reaper must never contradict the API. Both read the same grace, so a
    // row it closes is one the API already reported as not live.
    it('never closes a session the API would still report live', async () => {
      const rows = await Promise.all([
        mkSession({ lastSeenAt: ago(1000) }),
        mkSession({ lastSeenAt: ago(GRACE_MS - 30 * 1000) }),
        mkSession({ lastSeenAt: ago(GRACE_MS + 30 * 1000) }),
      ]);
      const liveBefore = rows.filter((r) => isChatSessionLive(r)).map((r) => r.id);
      await reapStaleChatSessions({ log: mockLogger });
      for (const r of rows) {
        await r.reload();
        if (liveBefore.includes(r.id)) expect(r.endedAt).toBeNull();
      }
    });
  });

  describe('GET /chat-sessions', () => {
    const res = () => ({
      _status: null, _body: null,
      locals: { user: { id: userId, role: 'owner', organisationId: orgId } },
      status(c) { this._status = c; return this; },
      send(d) { this._body = d; return this; },
      json(d) { this._body = d; return this; },
    });

    it('reports live, and does not leak the heartbeat that decides it', async () => {
      await mkSession({ lastSeenAt: ago(30 * 1000) });
      await mkSession({ lastSeenAt: ago(GRACE_MS + 60 * 1000) });
      await mkSession({ lastSeenAt: new Date(), endedAt: new Date() });

      const r = res();
      await listSessions({ query: {}, params: {}, log: mockLogger }, r);
      const sessions = r._body.sessions;
      expect(sessions).toHaveLength(3);
      expect(sessions.filter((s) => s.live)).toHaveLength(1);
      // Exposing lastSeenAt would invite every client to re-derive liveness
      // with its own idea of the grace, and they would disagree.
      for (const s of sessions) expect(s).not.toHaveProperty('lastSeenAt');
    });
  });

  // The heartbeat is what makes the whole scheme work, so its lifecycle is
  // pinned directly rather than inferred from the reaper's behaviour.
  describe('heartbeat lifecycle', () => {
    // Built on the real prototype so the methods call each other exactly as
    // they do in a live session; only the LLM and socket are left off.
    const mkFake = (over = {}) => Object.assign(Object.create(proto), {
      id: randomUUID(),
      persisted: true,
      heartbeat: null,
      logger: mockLogger,
      ...over,
    });

    let proto;
    beforeAll(async () => {
      const mod = await import('../lib/text-chat.js');
      // startHeartbeat/stopHeartbeat live on the session prototype; exercising
      // them directly keeps this a unit test of the timer contract, with no
      // LLM and no websocket.
      const session = await mod.createChatSession({
        agent: {
          id: 'agent-hb', organisationId: orgId, userId,
          modelName: 'text:anthropic/claude-sonnet-5',
          functions: [], keys: [], options: {}, mcpServers: [],
        },
        logger: mockLogger,
      });
      proto = Object.getPrototypeOf(session);
      session.teardown();
    });

    it('does not beat for a session with no durable row', async () => {
      const s = mkFake({ persisted: false });
      s.startHeartbeat();
      expect(s.heartbeat).toBeNull();
    });

    it('beats once started, and starting twice does not stack timers', async () => {
      const s = mkFake();
      s.startHeartbeat();
      const first = s.heartbeat;
      expect(first).toBeTruthy();
      s.startHeartbeat();
      expect(s.heartbeat).toBe(first);
      s.stopHeartbeat();
      expect(s.heartbeat).toBeNull();
    });

    // A beat landing after endedAt was written would leave a row that is both
    // ended and freshly seen. The reaper only looks at OPEN rows, so it could
    // never correct it.
    it('stops beating before teardown writes endedAt', async () => {
      const row = await mkSession({ lastSeenAt: ago(1000) });
      const s = mkFake({ id: row.id, torndown: false, finaliseUsage() {}, transcript: null, turnsCount: 0 });
      s.startHeartbeat();
      expect(s.heartbeat).toBeTruthy();
      s.teardown();
      expect(s.heartbeat).toBeNull();
      expect(s.torndown).toBe(true);
    });
  });
});
