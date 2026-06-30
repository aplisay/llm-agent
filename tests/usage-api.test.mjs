import {
  setupRealDatabase, teardownRealDatabase,
  UsageRecord, Organisation, User, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

const mockLogger = {
  info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, trace: () => {},
  child: () => mockLogger,
};

function mockReqRes(user, query = {}) {
  const req = { query, log: mockLogger };
  const res = { locals: { user: user ? { role: 'owner', ...user } : user }, statusCode: 200, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.body = body; return res; };
  res.json = (body) => { res.body = body; return res; };
  return { req, res };
}

describe('Tenant usage API (GET /api/usage)', () => {
  let GET, orgA, userA, orgB, userB;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    GET = (await import('../api/paths/usage.js')).default(mockLogger).GET;

    orgA = randomUUID(); userA = randomUUID();
    orgB = randomUUID(); userB = randomUUID();
    await Organisation.bulkCreate([{ id: orgA, name: 'Org A' }, { id: orgB, name: 'Org B' }]);
    await User.bulkCreate([
      { id: userA, name: 'A', email: `a-${userA}@x.com`, emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner', organisationId: orgA },
      { id: userB, name: 'B', email: `b-${userB}@x.com`, emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner', organisationId: orgB },
    ]);

    // bulkCreate does not run the per-row beforeValidate hook that derives
    //  meterKey, so set it explicitly here (the real recording path always does).
    const mk = (orgId, userId, technology, provider, detail, unit, quantity, media = null) =>
      ({
        sessionId: `${orgId}-s`,
        meterKey: UsageRecord.meterKey({ agentId: null, technology, provider, detail, unit }),
        organisationId: orgId, userId, technology, provider, detail, unit, quantity, media, finalised: true,
      });
    await UsageRecord.bulkCreate([
      mk(orgA, userA, 'llm', 'anthropic', 'claude-opus-4-8', 'input_tokens', 100),
      mk(orgA, userA, 'llm', 'anthropic', 'claude-opus-4-8', 'output_tokens', 20),
      mk(orgA, userA, 'voice', 'livekit', 'livekit:x', 'milliseconds', 60000, 'webrtc'),
      mk(orgB, userB, 'llm', 'anthropic', 'claude-opus-4-8', 'input_tokens', 999),
    ]);
  }, 30000);

  afterAll(async () => {
    await UsageRecord.destroy({ where: { organisationId: [orgA, orgB] } });
    await User.destroy({ where: { id: [userA, userB] } });
    await Organisation.destroy({ where: { id: [orgA, orgB] } });
    await teardownRealDatabase();
  }, 30000);

  it('aggregates usage grouped by meter dimensions for the caller', async () => {
    const { req, res } = mockReqRes({ id: userA, organisationId: orgA });
    await GET(req, res);
    expect(res.body).toBeDefined();
    const input = res.body.usage.find((u) => u.technology === 'llm' && u.unit === 'input_tokens');
    expect(input).toBeDefined();
    expect(input.quantity).toBe(100);
    const voice = res.body.usage.find((u) => u.technology === 'voice' && u.unit === 'milliseconds');
    expect(voice.quantity).toBe(60000);
  });

  it("never leaks another organisation's usage", async () => {
    const { req, res } = mockReqRes({ id: userA, organisationId: orgA });
    await GET(req, res);
    // Org B posted 999 input_tokens; the sum for org A must be 100, not 1099.
    const input = res.body.usage.find((u) => u.unit === 'input_tokens');
    expect(input.quantity).toBe(100);
  });

  it('supports a coarser groupBy and a technology filter', async () => {
    const { req, res } = mockReqRes({ id: userA, organisationId: orgA }, { groupBy: 'technology', technology: 'llm' });
    await GET(req, res);
    expect(res.body.usage).toHaveLength(1);
    expect(res.body.usage[0].technology).toBe('llm');
    // input(100) + output(20) summed under one llm bucket.
    expect(res.body.usage[0].quantity).toBe(120);
  });

  it('exposes media (audio transport) as a groupBy dimension on voice rows', async () => {
    const { req, res } = mockReqRes(
      { id: userA, organisationId: orgA },
      { groupBy: 'technology,provider,detail,unit,media', technology: 'voice' },
    );
    await GET(req, res);
    const voice = res.body.usage.find((u) => u.technology === 'voice');
    expect(voice).toBeDefined();
    expect(voice.media).toBe('webrtc');
  });

  it('sums frozen cost (cost_micros) and counts uncosted meters explicitly', async () => {
    const rows = [
      { sessionId: `${orgA}-k1`, organisationId: orgA, userId: userA, technology: 'voice', provider: 'livekit', detail: 'cost-test', unit: 'milliseconds', quantity: 60000, media: 'webrtc', costMicros: 6500000, costStatus: 'matched', rateName: 'r1', currency: 'gbp', finalised: true },
      { sessionId: `${orgA}-k2`, organisationId: orgA, userId: userA, technology: 'voice', provider: 'livekit', detail: 'cost-test', unit: 'milliseconds', quantity: 30000, media: 'webrtc', costStatus: 'no_rate', finalised: true },
    ].map((r) => ({ ...r, meterKey: UsageRecord.meterKey(r) }));
    await UsageRecord.bulkCreate(rows);

    // One bucket over both rows: cost sums the costed one, uncostedMeters counts the other.
    const { req, res } = mockReqRes({ id: userA, organisationId: orgA }, { groupBy: 'technology,detail' });
    await GET(req, res);
    const bucket = res.body.usage.find((u) => u.detail === 'cost-test');
    expect(bucket.costMicros).toBe(6500000); // only the costed row contributes
    expect(bucket.uncostedMeters).toBe(1);    // the no_rate row
    expect(bucket.meters).toBe(2);

    // rateName is a usable groupBy dimension (the costed row carries it).
    const { req: r2, res: s2 } = mockReqRes({ id: userA, organisationId: orgA }, { groupBy: 'detail,rateName' });
    await GET(r2, s2);
    expect(s2.body.usage.some((u) => u.detail === 'cost-test' && u.rateName === 'r1')).toBe(true);

    await UsageRecord.destroy({ where: { detail: 'cost-test' } });
  });
});
