import {
  setupRealDatabase, teardownRealDatabase,
  UsageRecord, Organisation, User, Agent, Instance, Call, RateCard, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import {
  resolveRowCost, toLineUnits, lineMatchesRow, resolveOrgRateName,
  resolveRateCard, settle, costUsageRow, sweepUncostedRows,
} from '../lib/rates.js';
import { recordUsage, finaliseSession } from '../lib/usage.js';

// Phase-2 costing engine (lib/rates.js): the additive-by-dimension resolver,
// temporal rate lookup, the idempotent balance settle(), and the never-throw
// costUsageRow orchestrator.

// A minute-billed realtime (Ultravox) card: one voice/ms row is priced on BOTH
// audio-path (handler+media) AND model (the model id in `detail`).
const ULTRAVOX_CARD = {
  currency: 'gbp',
  detail: {
    lines: [
      { dim: 'audio-path', match: { technology: 'voice', provider: 'livekit', media: 'webrtc' }, unit: 'minute', priceMicros: 500_000 },
      { dim: 'audio-path', match: { technology: 'voice', provider: 'livekit', media: 'telephony' }, unit: 'minute', priceMicros: 1_000_000 },
      { dim: 'audio-path', match: { technology: 'voice', detail: 'telephony:bridged-call', media: 'telephony' }, unit: 'minute', priceMicros: 1_000_000 },
      { dim: 'model', match: { technology: 'voice', detail: 'livekit:ultravox/ultravox-v0.6' }, unit: 'minute', priceMicros: 6_000_000 },
      { dim: 'model', match: { technology: 'llm', provider: 'openai', detail: 'openai/gpt-4o', unit: 'output_tokens' }, unit: 'token', priceMicros: 8_000 },
      { dim: 'tts', match: { technology: 'tts', provider: 'elevenlabs', unit: 'characters' }, unit: 'character', priceMicros: 100 },
      { dim: 'stt', match: { technology: 'stt', provider: 'deepgram', unit: 'milliseconds' }, unit: 'minute', priceMicros: 500_000 },
    ],
  },
};

const voiceRow = (over = {}) => ({
  technology: 'voice', provider: 'livekit', detail: 'livekit:ultravox/ultravox-v0.6',
  unit: 'milliseconds', media: 'webrtc', quantity: 60_000, ...over,
});

describe('rates: pure additive resolver', () => {
  it('toLineUnits converts ms/seconds to minutes; tokens/characters are 1:1', () => {
    expect(toLineUnits(60_000, 'milliseconds', 'minute')).toBe(1);
    expect(toLineUnits(90_000, 'milliseconds', 'minute')).toBeCloseTo(1.5);
    expect(toLineUnits(120, 'seconds', 'minute')).toBe(2);
    expect(toLineUnits(42, 'output_tokens', 'token')).toBe(42);
    expect(toLineUnits(900, 'characters', 'character')).toBe(900);
  });

  it('lineMatchesRow: key omission is wildcard; specified keys must equal', () => {
    expect(lineMatchesRow({}, voiceRow())).toBe(true);
    expect(lineMatchesRow({ technology: 'voice' }, voiceRow())).toBe(true);
    expect(lineMatchesRow({ provider: 'livekit', media: 'webrtc' }, voiceRow())).toBe(true);
    expect(lineMatchesRow({ media: 'telephony' }, voiceRow())).toBe(false);
    expect(lineMatchesRow({ detail: 'livekit:ultravox/ultravox-v0.6' }, voiceRow())).toBe(true);
  });

  it('prices ONE realtime voice/ms row on BOTH audio-path and model dimensions (additive)', () => {
    const { costMicros, status, breakdown } = resolveRowCost(voiceRow(), ULTRAVOX_CARD);
    // 1 minute: audio-path webrtc (500_000) + Ultravox model (6_000_000).
    expect(status).toBe('matched');
    expect(costMicros).toBe(6_500_000);
    expect(breakdown.map((b) => b.dim).sort()).toEqual(['audio-path', 'model']);
  });

  it('uses the leg media: a telephony consult leg picks the telephony audio-path line', () => {
    const { costMicros, breakdown } = resolveRowCost(voiceRow({ media: 'telephony', quantity: 120_000 }), ULTRAVOX_CARD);
    // 2 minutes: telephony audio-path (1_000_000/min) + Ultravox model (6_000_000/min) = 14_000_000.
    expect(costMicros).toBe(14_000_000);
    const ap = breakdown.find((b) => b.dim === 'audio-path');
    expect(ap.priceMicros).toBe(1_000_000);
  });

  it('most-specific line wins within a dimension', () => {
    const card = { detail: { lines: [
      { dim: 'audio-path', match: { technology: 'voice' }, unit: 'minute', priceMicros: 999 },
      { dim: 'audio-path', match: { technology: 'voice', provider: 'livekit', media: 'webrtc' }, unit: 'minute', priceMicros: 500_000 },
    ] } };
    const { breakdown } = resolveRowCost(voiceRow(), card);
    expect(breakdown).toHaveLength(1);
    expect(breakdown[0].priceMicros).toBe(500_000);
  });

  it('the bridged tail leg matches the telephony:bridged-call audio-path line only (no model)', () => {
    const row = voiceRow({ detail: 'telephony:bridged-call', media: 'telephony', quantity: 60_000 });
    const { costMicros, breakdown } = resolveRowCost(row, ULTRAVOX_CARD);
    // Only audio-path (1_000_000/min); the model lines don't match the sentinel detail.
    expect(costMicros).toBe(1_000_000);
    expect(breakdown.map((b) => b.dim)).toEqual(['audio-path']);
  });

  it('prices a pipeline LLM token row on the model dimension (token 1:1)', () => {
    const row = { technology: 'llm', provider: 'openai', detail: 'openai/gpt-4o', unit: 'output_tokens', quantity: 1000 };
    const { costMicros, breakdown } = resolveRowCost(row, ULTRAVOX_CARD);
    expect(costMicros).toBe(8_000_000); // 1000 tokens * 8_000 µpence
    expect(breakdown[0].dim).toBe('model');
  });

  it('returns no_line + null cost when nothing matches', () => {
    const row = { technology: 'voice', provider: 'jambonz', detail: 'x', unit: 'milliseconds', media: 'telephony', quantity: 60_000 };
    const card = { detail: { lines: [
      { dim: 'audio-path', match: { technology: 'voice', provider: 'livekit' }, unit: 'minute', priceMicros: 1 },
    ] } };
    const out = resolveRowCost(row, card);
    expect(out.status).toBe('no_line');
    expect(out.costMicros).toBeNull();
  });

  it('rounds fractional micro-pence to an integer', () => {
    const card = { detail: { lines: [
      { dim: 'audio-path', match: { technology: 'voice' }, unit: 'minute', priceMicros: 7 },
    ] } };
    // 10_000ms = 1/6 min; 7 * 1/6 = 1.166… -> 1
    expect(resolveRowCost(voiceRow({ quantity: 10_000 }), card).costMicros).toBe(1);
  });
});

describe('rates: resolveOrgRateName (temporal)', () => {
  const hist = [
    { name: 'launch', startDate: '2026-01-01T00:00:00Z' },
    { name: 'q2', startDate: '2026-04-01T00:00:00Z' },
  ];
  it('picks the entry with the greatest startDate <= billedAt', () => {
    expect(resolveOrgRateName({ rateHistory: hist }, new Date('2026-02-15T00:00:00Z'))).toBe('launch');
    expect(resolveOrgRateName({ rateHistory: hist }, new Date('2026-05-01T00:00:00Z'))).toBe('q2');
  });
  it('returns null before any assignment / when untracked', () => {
    expect(resolveOrgRateName({ rateHistory: hist }, new Date('2025-12-01T00:00:00Z'))).toBeNull();
    expect(resolveOrgRateName({}, new Date())).toBeNull();
  });
});

describe('rates: settle + resolveRateCard + costUsageRow (DB-backed)', () => {
  const PREFIX = `rate-test-${randomUUID()}-`;
  let orgId, userId, agentId, instanceId;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    orgId = randomUUID();
    userId = randomUUID();
    agentId = randomUUID();
    instanceId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Rates Org' });
    await User.create({
      id: userId, name: 'Rates User', email: `rate-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner', organisationId: orgId,
    });
    await Agent.create(
      { id: agentId, name: 'Rates Agent', modelName: 'livekit:ultravox/ultravox-v0.6', userId, organisationId: orgId },
      { validate: false },
    );
    await Instance.create({ id: instanceId, agentId, type: 'livekit', userId, organisationId: orgId });
  }, 30000);

  afterEach(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await Organisation.update({ rateHistory: null, balance: null }, { where: { id: orgId } });
  });

  afterAll(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await Organisation.destroy({ where: { id: orgId } });
    await teardownRealDatabase();
  }, 30000);

  const mkRow = (over = {}) => UsageRecord.create({
    sessionId: randomUUID(), meterKey: randomUUID(), organisationId: orgId, userId,
    technology: 'voice', provider: 'livekit', detail: 'livekit:ultravox/ultravox-v0.6',
    unit: 'milliseconds', media: 'webrtc', quantity: 60_000, finalised: true, ...over,
  });

  it('resolveRateCard picks the card whose [start,end) covers billedAt', async () => {
    const name = `${PREFIX}eff`;
    await RateCard.create({ name, startDate: new Date('2026-01-01Z'), endDate: new Date('2026-04-01Z') });
    await RateCard.create({ name, startDate: new Date('2026-04-01Z') }); // open
    expect((await resolveRateCard(name, new Date('2026-02-01Z'), { RateCard })).endDate).toBeTruthy();
    expect((await resolveRateCard(name, new Date('2026-06-01Z'), { RateCard })).endDate).toBeNull();
    expect(await resolveRateCard(name, new Date('2025-06-01Z'), { RateCard })).toBeNull();
  });

  it('settle decrements balance by the delta and is idempotent on re-run', async () => {
    await Organisation.update({ balance: 10_000_000 }, { where: { id: orgId } });
    const org = await Organisation.findByPk(orgId);
    const row = await mkRow({ costMicros: 6_500_000, appliedCostMicros: 0 });

    await settle(row, org);
    expect(Number((await Organisation.findByPk(orgId)).balance)).toBe(3_500_000);
    expect(Number((await row.reload()).appliedCostMicros)).toBe(6_500_000);

    // Re-run with the SAME cost is a no-op (delta 0).
    await settle(row, await Organisation.findByPk(orgId));
    expect(Number((await Organisation.findByPk(orgId)).balance)).toBe(3_500_000);
  });

  it('settle applies only the difference on a re-cost (convergent)', async () => {
    await Organisation.update({ balance: 10_000_000 }, { where: { id: orgId } });
    const row = await mkRow({ costMicros: 6_500_000, appliedCostMicros: 0 });
    await settle(row, await Organisation.findByPk(orgId));
    // Re-cost lower: balance should be refunded the difference.
    await row.update({ costMicros: 4_000_000 });
    await settle(row, await Organisation.findByPk(orgId));
    expect(Number((await Organisation.findByPk(orgId)).balance)).toBe(6_000_000); // 10M - 4M
    expect(Number((await row.reload()).appliedCostMicros)).toBe(4_000_000);
  });

  it('settle is a no-op when balance is untracked (null)', async () => {
    const org = await Organisation.findByPk(orgId); // balance null
    const row = await mkRow({ costMicros: 6_500_000 });
    await settle(row, org);
    expect((await Organisation.findByPk(orgId)).balance).toBeNull();
    expect(Number((await row.reload()).appliedCostMicros)).toBe(0);
  });

  it('costUsageRow: stamps cost + breakdown, sets matched, decrements balance', async () => {
    const name = `${PREFIX}live`;
    await RateCard.create({
      name, startDate: new Date('2026-01-01Z'),
      detail: { lines: [
        { dim: 'audio-path', match: { technology: 'voice', provider: 'livekit', media: 'webrtc' }, unit: 'minute', priceMicros: 500_000 },
        { dim: 'model', match: { technology: 'voice', detail: 'livekit:ultravox/ultravox-v0.6' }, unit: 'minute', priceMicros: 6_000_000 },
      ] },
    });
    await Organisation.update(
      { rateHistory: [{ name, startDate: '2026-01-01T00:00:00Z' }], balance: 20_000_000 },
      { where: { id: orgId } },
    );
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId, callerId: 'WebRTC', calledId: 'WebRTC',
      platform: 'livekit', modelName: 'livekit:ultravox/ultravox-v0.6',
    });
    await call.update({ startedAt: new Date('2026-02-01T12:00:00Z') });
    const row = await mkRow({ callId: call.id, quantity: 60_000 });

    await costUsageRow(row);
    const fresh = await row.reload();
    expect(fresh.costStatus).toBe('matched');
    expect(Number(fresh.costMicros)).toBe(6_500_000);
    expect(fresh.rateName).toBe(name);
    expect(new Date(fresh.billedAt).toISOString()).toBe('2026-02-01T12:00:00.000Z');
    expect(fresh.metadata.costBreakdown).toHaveLength(2);
    expect(Number((await Organisation.findByPk(orgId)).balance)).toBe(13_500_000);
  });

  it('costUsageRow: no assigned rate -> costStatus no_rate, cost null, billedAt stamped', async () => {
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId, callerId: 'WebRTC', calledId: 'WebRTC',
      platform: 'livekit', modelName: 'livekit:ultravox/ultravox-v0.6',
    });
    await call.update({ startedAt: new Date('2026-03-01T09:00:00Z') });
    const row = await mkRow({ callId: call.id });
    await costUsageRow(row);
    const fresh = await row.reload();
    expect(fresh.costStatus).toBe('no_rate');
    expect(fresh.costMicros).toBeNull();
    expect(fresh.billedAt).toBeTruthy();
  });

  // --- cost-at-finalisation WIRING (the triggers, not just the engine) ---

  const assignRate = async (name, lines, balance) => {
    await RateCard.create({ name, startDate: new Date('2026-01-01Z'), detail: { lines } });
    await Organisation.update(
      { rateHistory: [{ name, startDate: '2026-01-01T00:00:00Z' }], balance },
      { where: { id: orgId } },
    );
  };

  it('Call.end() costs the voice row end-to-end and decrements balance', async () => {
    const name = `${PREFIX}e2e`;
    await assignRate(name, [
      { dim: 'audio-path', match: { technology: 'voice', provider: 'livekit', media: 'telephony' }, unit: 'minute', priceMicros: 1_000_000 },
      { dim: 'model', match: { technology: 'voice', detail: 'livekit:ultravox/ultravox-v0.6' }, unit: 'minute', priceMicros: 6_000_000 },
    ], 50_000_000);
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId, callerId: '441234567890', calledId: '447700900000',
      platform: 'livekit', modelName: 'livekit:ultravox/ultravox-v0.6',
    });
    call.startedAt = new Date(Date.now() - 60_000); // 1 minute
    await call.end();

    const row = await UsageRecord.findOne({ where: { callId: call.id, technology: 'voice' } });
    expect(row.costStatus).toBe('matched');
    expect(row.media).toBe('telephony');
    expect(Number(row.costMicros)).toBe(7_000_000); // telephony 1M + Ultravox 6M
    expect(Number((await Organisation.findByPk(orgId)).balance)).toBe(43_000_000);
  });

  it('RateCard is immutable once referenced; cosmetic edits + unreferenced cards are free', async () => {
    const startDate = new Date('2026-01-01Z');
    await RateCard.create({ name: `${PREFIX}imm`, startDate, detail: { lines: [] } });
    await RateCard.create({ name: `${PREFIX}free`, startDate, detail: { lines: [] } });
    // A costed usage row pins the referenced card (rateName + rateCardStart).
    await mkRow({ rateName: `${PREFIX}imm`, rateCardStart: startDate, costMicros: 1, costStatus: 'matched' });

    // Each fetch is a fresh instance (clean changed-state), as a real API request is.
    const imm = () => RateCard.findOne({ where: { name: `${PREFIX}imm` } });
    const free = () => RateCard.findOne({ where: { name: `${PREFIX}free` } });

    await expect((await imm()).update({ detail: { lines: [{ dim: 'model', match: {}, unit: 'minute', priceMicros: 1 }] } }))
      .rejects.toThrow(/immutable once referenced/);
    await expect((await imm()).update({ startDate: new Date('2026-02-01Z') })).rejects.toThrow(/immutable/);
    // Cosmetic edit on the referenced card is allowed.
    await expect((await imm()).update({ description: 'note' })).resolves.toBeTruthy();
    // The unreferenced card can have its pricing edited freely.
    await expect((await free()).update({ detail: { lines: [{ dim: 'model', match: {}, unit: 'minute', priceMicros: 5 }] } }))
      .resolves.toBeTruthy();
  });

  it('finaliseSession costs the session’s finalised text rows', async () => {
    const name = `${PREFIX}text`;
    await assignRate(name, [
      { dim: 'model', match: { technology: 'llm', provider: 'anthropic', detail: 'claude-opus-4-8', unit: 'output_tokens' }, unit: 'token', priceMicros: 4_000 },
    ], 20_000_000);
    const sessionId = randomUUID();
    // A provisional (un-finalised) increment row — not costed until the session ends.
    await recordUsage({
      sessionId, organisationId: orgId, userId,
      technology: 'llm', provider: 'anthropic', detail: 'claude-opus-4-8', unit: 'output_tokens',
      quantity: 1000, mode: 'increment', finalised: false,
      metadata: { startedAt: '2026-02-01T00:00:00Z' },
    });
    const before = await UsageRecord.findOne({ where: { sessionId } });
    expect(before.costStatus).toBeNull(); // not costed while provisional

    await finaliseSession(sessionId);
    const after = await UsageRecord.findOne({ where: { sessionId } });
    expect(after.finalised).toBe(true);
    expect(after.costStatus).toBe('matched');
    expect(Number(after.costMicros)).toBe(4_000_000); // 1000 tokens * 4_000
    expect(Number((await Organisation.findByPk(orgId)).balance)).toBe(16_000_000);
  });

  it('sweepUncostedRows backfills uncosted + re-costs no_rate, leaving matched frozen', async () => {
    const name = `${PREFIX}sweep`;
    await assignRate(name, [
      { dim: 'audio-path', match: { technology: 'voice', provider: 'livekit', media: 'webrtc' }, unit: 'minute', priceMicros: 500_000 },
      { dim: 'model', match: { technology: 'voice', detail: 'livekit:ultravox/ultravox-v0.6' }, unit: 'minute', priceMicros: 6_000_000 },
    ], 100_000_000);
    const call = await Call.create({
      instanceId, agentId, organisationId: orgId, userId, callerId: 'WebRTC', calledId: 'WebRTC',
      platform: 'livekit', modelName: 'livekit:ultravox/ultravox-v0.6',
    });
    await call.update({ startedAt: new Date('2026-02-01T12:00:00Z') });

    const uncosted = await mkRow({ callId: call.id, quantity: 60_000 });                                  // costStatus null
    const noRate = await mkRow({ callId: call.id, quantity: 60_000, costStatus: 'no_rate' });             // pre-rate
    const frozen = await mkRow({ callId: call.id, quantity: 60_000, costStatus: 'matched', costMicros: 123, appliedCostMicros: 123 });

    const res = await sweepUncostedRows();
    expect(res.costed).toBeGreaterThanOrEqual(2);
    expect((await uncosted.reload()).costStatus).toBe('matched');
    expect((await noRate.reload()).costStatus).toBe('matched');
    expect(Number((await frozen.reload()).costMicros)).toBe(123); // untouched (not scanned)
    // 100M - 6.5M (uncosted) - 6.5M (no_rate) = 87M; the frozen row was never settled here.
    expect(Number((await Organisation.findByPk(orgId)).balance)).toBe(87_000_000);
  });
});
