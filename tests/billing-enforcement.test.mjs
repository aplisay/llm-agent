import {
  setupRealDatabase, teardownRealDatabase,
  Organisation, User, Agent, Instance, Call, UsageRecord, RateCard, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

// Phase-5 wiring: hot-path billingBlocked refusal in Call.start(), and the
// reconciliation sweep endpoint (POST /api/agent-db/sweep).

const mockLogger = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child() { return mockLogger; } };

describe('Phase 5: billingBlocked enforcement + sweep endpoint', () => {
  const PREFIX = `p5-${randomUUID()}-`;
  let orgId, userId, agentId, instanceId, sweepPOST;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    orgId = randomUUID();
    userId = randomUUID();
    agentId = randomUUID();
    instanceId = randomUUID();
    await Organisation.create({ id: orgId, name: 'P5 Org' });
    await User.create({
      id: userId, name: 'P5', email: `p5-${userId}@x.com`, emailVerified: true,
      phone: '', phoneVerified: false, picture: '', role: 'owner', organisationId: orgId,
    });
    await Agent.create({ id: agentId, name: 'P5 Agent', modelName: 'livekit:ultravox/ultravox-v0.6', userId, organisationId: orgId }, { validate: false });
    await Instance.create({ id: instanceId, agentId, type: 'livekit', userId, organisationId: orgId });
    sweepPOST = (await import('../api/paths/agent-db/sweep.js')).default(mockLogger).POST;
  }, 30000);

  afterEach(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await Organisation.update({ billingBlocked: false, rateHistory: null, balance: null }, { where: { id: orgId } });
  });

  afterAll(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await Organisation.destroy({ where: { id: orgId } });
    await teardownRealDatabase();
  }, 30000);

  const mkCall = () => Call.create({
    instanceId, agentId, organisationId: orgId, userId,
    calledId: 'WebRTC', callerId: 'WebRTC', platform: 'livekit', modelName: 'livekit:ultravox/ultravox-v0.6',
  });

  it('Call.start() refuses a billingBlocked org (BILLING_BLOCKED) before reserving concurrency', async () => {
    await Organisation.update({ billingBlocked: true }, { where: { id: orgId } });
    const call = await mkCall();
    await expect(call.start()).rejects.toMatchObject({ code: 'BILLING_BLOCKED' });
    const fresh = await Call.findByPk(call.id);
    expect(fresh.status).toBe('failed: billing blocked');
    expect(fresh.live).toBe(false);
  });

  it('Call.start() does NOT billing-block a normal org', async () => {
    // billingBlocked defaults false; the billing gate must pass (it then proceeds
    // to concurrency reservation, which is exercised elsewhere).
    const call = await mkCall();
    let billingBlocked = false;
    try {
      await call.start({ organisation: { id: orgId, billingBlocked: false } });
    } catch (e) {
      billingBlocked = e?.code === 'BILLING_BLOCKED';
    }
    expect(billingBlocked).toBe(false);
  });

  it('POST /agent-db/sweep costs uncosted rows via sweepUncostedRows', async () => {
    const name = `${PREFIX}sweep`;
    await RateCard.create({
      name, startDate: new Date('2026-01-01Z'),
      detail: { lines: [{ dim: 'audio-path', match: { technology: 'voice', provider: 'livekit', media: 'webrtc' }, unit: 'minute', priceMicros: 500000 }] },
    });
    await Organisation.update({ rateHistory: [{ name, startDate: '2026-01-01T00:00:00Z' }], balance: 10_000_000 }, { where: { id: orgId } });
    const call = await mkCall();
    await call.update({ startedAt: new Date('2026-02-01T12:00:00Z') });
    await UsageRecord.create({
      sessionId: call.id, meterKey: randomUUID(), callId: call.id, organisationId: orgId, userId, agentId,
      technology: 'voice', provider: 'livekit', detail: 'livekit:ultravox/ultravox-v0.6',
      unit: 'milliseconds', media: 'webrtc', quantity: 60000, finalised: true,
    });

    const req = { body: { limit: 100 }, log: mockLogger };
    const res = { statusCode: 200, body: undefined, status(c) { this.statusCode = c; return this; }, send(b) { this.body = b; return this; } };
    await sweepPOST(req, res);
    expect(res.body.costed).toBeGreaterThanOrEqual(1);
    const row = await UsageRecord.findOne({ where: { callId: call.id, technology: 'voice' } });
    expect(row.costStatus).toBe('matched');
    expect(Number(row.costMicros)).toBe(500000);
  });
});
