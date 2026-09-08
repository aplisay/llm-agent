import {
  setupRealDatabase, teardownRealDatabase,
  UsageRecord, Organisation, User, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

// GET /api/usage/records — the ITEMISED ledger. /usage answers "how much of X",
// and by construction cannot answer "which one, and why is that one not
// priced". These pin the second question: scope, the cursor, and the
// priceState vocabulary the usage screen renders its explanations from.

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

describe('Itemised usage API (GET /api/usage/records)', () => {
  let GET, orgA, userA, orgB, userB, callId;

  const mk = (over) => ({
    sessionId: over.sessionId || `${over.organisationId}-s`,
    technology: 'llm', provider: 'openai', detail: 'gpt-5.6-terra', unit: 'input_tokens',
    quantity: 100, finalised: true,
    ...over,
    meterKey: UsageRecord.meterKey({ agentId: null, ...over }),
  });

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    GET = (await import('../api/paths/usage/records.js')).default(mockLogger).GET;

    orgA = randomUUID(); userA = randomUUID();
    orgB = randomUUID(); userB = randomUUID();
    callId = randomUUID();
    await Organisation.bulkCreate([{ id: orgA, name: 'Items A' }, { id: orgB, name: 'Items B' }]);
    await User.bulkCreate([
      { id: userA, name: 'A', email: `ia-${userA}@x.com`, emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner', organisationId: orgA },
      { id: userB, name: 'B', email: `ib-${userB}@x.com`, emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner', organisationId: orgB },
    ]);

    await UsageRecord.bulkCreate([
      // priced
      mk({ sessionId: `${orgA}-1`, organisationId: orgA, userId: userA, unit: 'input_tokens', quantity: 1000, costMicros: 2200, costStatus: 'matched', rateName: 'pro', currency: 'gbp', billedAt: new Date('2026-09-01T10:00:00Z'), metadata: { costBreakdown: [{ dim: 'model', costMicros: 2200 }] } }),
      // included — bundled realtime speech, priced at zero on purpose
      mk({ sessionId: `${orgA}-2`, organisationId: orgA, userId: userA, technology: 'tts', provider: 'ultravox', detail: 'Wendy', unit: 'milliseconds', quantity: 156572, costMicros: 0, costStatus: 'matched', rateName: 'pro', billedAt: new Date('2026-09-02T10:00:00Z') }),
      // no_line — the card priced no dimension of this row
      mk({ sessionId: `${orgA}-3`, organisationId: orgA, userId: userA, technology: 'tts', provider: 'ultravox', detail: 'Olivia', unit: 'milliseconds', quantity: 108360, costStatus: 'no_line', rateName: 'pro', billedAt: new Date('2026-09-03T10:00:00Z') }),
      // provisional — still metering, uncosted BY DESIGN
      mk({ sessionId: `${orgA}-4`, organisationId: orgA, userId: userA, unit: 'output_tokens', quantity: 88, finalised: false }),
      // no_rate, and attached to a call
      mk({ sessionId: `${orgA}-5`, organisationId: orgA, userId: userA, technology: 'voice', provider: 'pipecat', detail: 'pipecat:ultravox/ultravox-v0.7', unit: 'milliseconds', media: 'webrtc', quantity: 60000, costStatus: 'no_rate', billedAt: new Date('2026-07-01T10:00:00Z') }),
      // another tenant
      mk({ sessionId: `${orgB}-1`, organisationId: orgB, userId: userB, quantity: 999, costMicros: 9999, costStatus: 'matched' }),
    ]);
  }, 30000);

  afterAll(async () => {
    await UsageRecord.destroy({ where: { organisationId: [orgA, orgB] } });
    await User.destroy({ where: { id: [userA, userB] } });
    await Organisation.destroy({ where: { id: [orgA, orgB] } });
    await teardownRealDatabase();
  }, 30000);

  const list = async (query = {}, user = { id: userA, organisationId: orgA }) => {
    const { req, res } = mockReqRes(user, query);
    await GET(req, res);
    return res.body;
  };

  it('returns the caller’s own rows only, newest first', async () => {
    const { records } = await list();
    expect(records.length).toBe(5);
    expect(records.every((r) => r.quantity !== 999)).toBe(true); // org B never leaks
    const ids = records.map((r) => Number(r.id));
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
  });

  // The whole point of the endpoint: say WHY, in a vocabulary the screen can
  // render. `costStatus` alone conflates "still running" with "we have no price
  // for this", and conflates a deliberate zero with a missing one.
  it('classifies every row into a priceState the screen can explain', async () => {
    const { records } = await list();
    const by = (detail, unit) => records.find((r) => r.detail === detail && (!unit || r.unit === unit));
    expect(by('gpt-5.6-terra', 'input_tokens').priceState).toBe('priced');
    expect(by('Wendy').priceState).toBe('included');       // zero, on purpose
    expect(by('Olivia').priceState).toBe('no_line');       // zero, by accident
    expect(by('gpt-5.6-terra', 'output_tokens').priceState).toBe('provisional');
    expect(by('pipecat:ultravox/ultravox-v0.7').priceState).toBe('no_rate');
  });

  it('carries the frozen per-line breakdown that justifies the charge', async () => {
    const { records } = await list({ priced: 'true' });
    expect(records).toHaveLength(1);
    expect(records[0].costBreakdown).toEqual([{ dim: 'model', costMicros: 2200 }]);
    expect(records[0].rateName).toBe('pro');
  });

  it('filters by technology, costStatus and finalised', async () => {
    expect((await list({ technology: 'tts' })).records).toHaveLength(2);
    expect((await list({ costStatus: 'no_line,no_rate' })).records).toHaveLength(2);
    expect((await list({ finalised: 'false' })).records).toHaveLength(1);
    // 'none' is the never-costed state, which is not expressible as a value.
    expect((await list({ costStatus: 'none' })).records).toHaveLength(1);
  });

  // A date filter must bound on the BILLING instant but still show uncosted
  // rows, whose billedAt is null — filtering on billed_at alone would silently
  // hide exactly the population this endpoint exists to surface.
  it('bounds on the billing instant, falling back to createdAt for uncosted rows', async () => {
    const { records } = await list({ startDate: '2026-08-01T00:00:00Z' });
    // The July no_rate row is excluded by date; the provisional row (no
    // billedAt, created now) is still visible.
    expect(records.some((r) => r.detail === 'pipecat:ultravox/ultravox-v0.7')).toBe(false);
    expect(records.some((r) => r.finalised === false)).toBe(true);
  });

  it('pages with a stable cursor that never repeats or skips a row', async () => {
    const first = await list({ limit: 2 });
    expect(first.records).toHaveLength(2);
    expect(first.next).toBeTruthy();
    const second = await list({ limit: 2, before: first.next });
    expect(second.records).toHaveLength(2);
    const seen = new Set([...first.records, ...second.records].map((r) => r.id));
    expect(seen.size).toBe(4);
    const last = await list({ limit: 10, before: second.next });
    expect(last.next).toBe(false);
  });

  it('refuses a caller without usage:read', async () => {
    const { req, res } = mockReqRes({ id: userA, organisationId: orgA, role: 'nobody' }, {});
    await GET(req, res);
    expect(res.statusCode).toBe(403);
  });
});
