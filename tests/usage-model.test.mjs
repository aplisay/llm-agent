import {
  setupRealDatabase, teardownRealDatabase,
  UsageRecord, Organisation, User, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { recordUsage, recordLlmTokens, finaliseSession } from '../lib/usage.js';
import { randomUUID } from 'crypto';

const silentLog = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {},
  child: () => silentLog,
};

describe('Usage ledger: recordUsage / recordLlmTokens', () => {
  let orgId, userId;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    orgId = randomUUID();
    userId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Usage Test Org' });
    await User.create({
      id: userId, name: 'Usage Test User', email: `usage-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner',
      organisationId: orgId,
    });
  }, 30000);

  afterAll(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await User.destroy({ where: { id: userId } });
    await Organisation.destroy({ where: { id: orgId } });
    await teardownRealDatabase();
  }, 30000);

  afterEach(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
  });

  it('creates a meter row and computes a stable meterKey', async () => {
    const row = await recordUsage({
      sessionId: 's1', organisationId: orgId, userId,
      technology: 'llm', provider: 'anthropic', detail: 'claude-opus-4-8',
      unit: 'input_tokens', quantity: 100, log: silentLog,
    });
    expect(row).toBeTruthy();
    expect(Number(row.quantity)).toBe(100);
    expect(row.meterKey).toBe('|llm|anthropic|claude-opus-4-8|input_tokens');
    expect(row.finalised).toBe(false);
  });

  it("mode 'set' replaces the quantity in place (idempotent re-flush)", async () => {
    const base = { sessionId: 's2', organisationId: orgId, userId, technology: 'tts', provider: 'elevenlabs', detail: 'eleven_turbo_v2', unit: 'characters', log: silentLog };
    await recordUsage({ ...base, quantity: 50 });
    await recordUsage({ ...base, quantity: 175 });
    const rows = await UsageRecord.findAll({ where: { sessionId: 's2' } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].quantity)).toBe(175);
  });

  it("mode 'increment' adds to the stored quantity", async () => {
    const base = { sessionId: 's3', organisationId: orgId, userId, technology: 'llm', provider: 'openai', detail: 'gpt-4o', unit: 'output_tokens', mode: 'increment', log: silentLog };
    await recordUsage({ ...base, quantity: 10 });
    await recordUsage({ ...base, quantity: 5 });
    await recordUsage({ ...base, quantity: 7 });
    const rows = await UsageRecord.findAll({ where: { sessionId: 's3' } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].quantity)).toBe(22);
  });

  it('finalised is sticky-OR (never unset once true)', async () => {
    const base = { sessionId: 's4', organisationId: orgId, userId, technology: 'llm', detail: 'm', unit: 'input_tokens', log: silentLog };
    await recordUsage({ ...base, quantity: 1, finalised: true });
    const after = await recordUsage({ ...base, quantity: 2, finalised: false });
    expect(after.finalised).toBe(true);
    expect(Number(after.quantity)).toBe(2);
  });

  it('distinguishes meters by (technology, provider, detail, unit)', async () => {
    const ids = { sessionId: 's5', organisationId: orgId, userId, log: silentLog };
    await recordUsage({ ...ids, technology: 'llm', provider: 'anthropic', detail: 'claude-opus-4-8', unit: 'input_tokens', quantity: 1 });
    await recordUsage({ ...ids, technology: 'llm', provider: 'anthropic', detail: 'claude-opus-4-8', unit: 'output_tokens', quantity: 2 });
    await recordUsage({ ...ids, technology: 'tts', provider: 'elevenlabs', detail: 'eleven_turbo_v2', unit: 'characters', quantity: 3 });
    const rows = await UsageRecord.findAll({ where: { sessionId: 's5' } });
    expect(rows).toHaveLength(3);
  });

  it('sessionId defaults to callId when not supplied', async () => {
    const row = await recordUsage({
      callId: null, sessionId: undefined, organisationId: orgId, userId,
      technology: 'function', detail: 'send_email', unit: 'invocations', quantity: 1, log: silentLog,
    });
    // No sessionId and no callId → skipped (returns null), nothing recorded.
    expect(row).toBeNull();
  });

  it('recordLlmTokens emits one row per non-zero token unit', async () => {
    await recordLlmTokens({
      sessionId: 's7', organisationId: orgId, userId, agentId: null,
      provider: 'anthropic', model: 'claude-opus-4-8',
      inputTokens: 120, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 9,
      mode: 'set', finalised: true, log: silentLog,
    });
    const rows = await UsageRecord.findAll({ where: { sessionId: 's7' }, order: [['unit', 'ASC']] });
    const byUnit = Object.fromEntries(rows.map((r) => [r.unit, Number(r.quantity)]));
    // input/output/cache_write present; cache_read (0) omitted.
    expect(byUnit).toEqual({ cache_write_tokens: 9, input_tokens: 120, output_tokens: 30 });
    expect(rows.every((r) => r.technology === 'llm' && r.finalised === true)).toBe(true);
  });

  it('finaliseSession marks every not-yet-finalised meter of a session final', async () => {
    const sessionId = 's-final';
    await recordUsage({
      sessionId, organisationId: orgId, userId, technology: 'llm', provider: 'openai',
      detail: 'gpt-4o', unit: 'input_tokens', quantity: 10, mode: 'increment', log: silentLog,
    });
    await recordUsage({
      sessionId, organisationId: orgId, userId, technology: 'llm', provider: 'openai',
      detail: 'gpt-4o', unit: 'output_tokens', quantity: 5, mode: 'increment', log: silentLog,
    });
    let rows = await UsageRecord.findAll({ where: { sessionId } });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.finalised === false)).toBe(true);

    const count = await finaliseSession(sessionId, { log: silentLog });
    expect(count).toBe(2);
    rows = await UsageRecord.findAll({ where: { sessionId } });
    expect(rows.every((r) => r.finalised === true)).toBe(true);
  });

  it('recordLlmTokens persists a metadata.startedAt billing anchor (text sessions)', async () => {
    const startedAt = new Date('2026-06-29T10:00:00Z').toISOString();
    await recordLlmTokens({
      sessionId: 's-anchor', organisationId: orgId, userId, provider: 'openai', model: 'gpt-4o',
      inputTokens: 3, outputTokens: 0, mode: 'increment', metadata: { startedAt }, log: silentLog,
    });
    const row = await UsageRecord.findOne({ where: { sessionId: 's-anchor', unit: 'input_tokens' } });
    expect(row.metadata?.startedAt).toBe(startedAt);
  });
});
