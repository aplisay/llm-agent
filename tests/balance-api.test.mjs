import {
  setupRealDatabase, teardownRealDatabase,
  Organisation, BalanceCredit, RateCard, User, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import { penniesToMicros, microsToPennies, MICROS_PER_PENNY } from '../lib/rates.js';

// Phase-3 billing edge: rate-history assignment, balance read (pennies), and the
// idempotent balance/credit (Stripe top-up seam) backed by the BalanceCredit table.

const mockLogger = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child() { return mockLogger; } };

function mockReqRes({ role = 'superAdmin', organisationId, params = {}, body = {}, query = {} } = {}) {
  const req = { params, body, query, log: mockLogger };
  const res = { locals: { user: { id: 'u-1', role, organisationId } }, statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  return { req, res };
}

describe('money scale helper (micro-pence <-> pence)', () => {
  it('uses a 1e4 scale and round-trips', () => {
    expect(MICROS_PER_PENNY).toBe(10000);
    expect(penniesToMicros(1)).toBe(10000);
    expect(microsToPennies(10000)).toBe(1);
    expect(penniesToMicros(250)).toBe(2_500_000);
    expect(microsToPennies(penniesToMicros(1337))).toBe(1337);
    expect(microsToPennies(null)).toBeNull();
  });
});

describe('Phase 3: rate-history + balance + balance/credit', () => {
  const PREFIX = `bal-${randomUUID()}-`;
  let orgId, rateHistGET, rateHistPUT, balGET, creditPOST;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    orgId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Balance Org' });
    await RateCard.create({ name: `${PREFIX}r1`, startDate: new Date('2026-01-01Z'), detail: { lines: [] } });

    const rh = (await import('../api/paths/organisations/{organisationId}/rate-history.js')).default(mockLogger);
    rateHistGET = rh.GET; rateHistPUT = rh.PUT;
    balGET = (await import('../api/paths/organisations/{organisationId}/balance.js')).default(mockLogger).GET;
    creditPOST = (await import('../api/paths/organisations/{organisationId}/balance/credit.js')).default(mockLogger).POST;
  }, 30000);

  afterEach(async () => {
    await BalanceCredit.destroy({ where: { organisationId: orgId } });
    await Organisation.update({ balance: null, rateHistory: null }, { where: { id: orgId } });
  });

  afterAll(async () => {
    await BalanceCredit.destroy({ where: { organisationId: orgId } });
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await Organisation.destroy({ where: { id: orgId } });
    await teardownRealDatabase();
  }, 30000);

  // --- rate-history ---
  it('assigns a valid rate-history (covering card) and reads it back', async () => {
    const { req, res } = mockReqRes({ params: { organisationId: orgId }, body: { rateHistory: [{ name: `${PREFIX}r1`, startDate: '2026-02-01T00:00:00Z' }] } });
    await rateHistPUT(req, res);
    expect(res.statusCode).toBe(200);
    const { req: g, res: gr } = mockReqRes({ params: { organisationId: orgId } });
    await rateHistGET(g, gr);
    expect(gr.body.rateHistory[0].name).toBe(`${PREFIX}r1`);
  });

  it('400s rate-history with no covering card, dups, or unsorted', async () => {
    const noCard = mockReqRes({ params: { organisationId: orgId }, body: { rateHistory: [{ name: 'ghost', startDate: '2026-02-01Z' }] } });
    await rateHistPUT(noCard.req, noCard.res);
    expect(noCard.res.statusCode).toBe(400);

    const unsorted = mockReqRes({ params: { organisationId: orgId }, body: { rateHistory: [
      { name: `${PREFIX}r1`, startDate: '2026-03-01Z' }, { name: `${PREFIX}r1`, startDate: '2026-02-01Z' },
    ] } });
    await rateHistPUT(unsorted.req, unsorted.res);
    expect(unsorted.res.statusCode).toBe(400);
  });

  it('rate-history PUT requires organisation:setRate (owner 403)', async () => {
    const { req, res } = mockReqRes({ role: 'owner', params: { organisationId: orgId }, body: { rateHistory: [] } });
    await rateHistPUT(req, res);
    expect(res.statusCode).toBe(403);
  });

  // --- balance read ---
  it('reads balance in pennies; untracked is null; an owner can read their OWN org', async () => {
    const { req, res } = mockReqRes({ role: 'owner', organisationId: orgId, params: { organisationId: orgId } });
    await balGET(req, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.balancePennies).toBeNull();
    expect(res.body.tracked).toBe(false);
  });

  it('balance read 404s another org without usage:readAll', async () => {
    const { req, res } = mockReqRes({ role: 'owner', organisationId: 'someone-else', params: { organisationId: orgId } });
    await balGET(req, res);
    expect(res.statusCode).toBe(404);
  });

  // --- balance/credit (idempotent) ---
  it('credits a null balance to tracked, is idempotent on the same key, and sums distinct keys', async () => {
    const credit = (key, pennies) => {
      const { req, res } = mockReqRes({ params: { organisationId: orgId }, body: { idempotencyKey: key, amountPennies: pennies } });
      return creditPOST(req, res).then(() => res);
    };
    const r1 = await credit('pi_1', 500); // £5
    expect(r1.body.balancePennies).toBe(500);
    expect((await Organisation.findByPk(orgId)).balance).not.toBeNull(); // now tracked

    const dup = await credit('pi_1', 500); // same PaymentIntent -> idempotent, no double credit
    expect(dup.body.idempotent).toBe(true);
    expect(dup.body.balancePennies).toBe(500);

    const r2 = await credit('pi_2', 250); // distinct payment
    expect(r2.body.balancePennies).toBe(750);
    expect(await BalanceCredit.count({ where: { organisationId: orgId } })).toBe(2);
  });

  it('the billingService role can credit but cannot assign rates (least privilege)', async () => {
    const c = mockReqRes({ role: 'billingService', params: { organisationId: orgId }, body: { idempotencyKey: 'svc-1', amountPennies: 300 } });
    await creditPOST(c.req, c.res);
    expect(c.res.statusCode).toBe(200);
    expect(c.res.body.balancePennies).toBe(300);
    // …but not rate assignment (organisation:setRate) — that stays superAdmin-only.
    const r = mockReqRes({ role: 'billingService', params: { organisationId: orgId }, body: { rateHistory: [] } });
    await rateHistPUT(r.req, r.res);
    expect(r.res.statusCode).toBe(403);
  });

  it('credit 400s missing key / non-positive amount, and 403s a non-super', async () => {
    const bad1 = mockReqRes({ params: { organisationId: orgId }, body: { amountPennies: 100 } });
    await creditPOST(bad1.req, bad1.res);
    expect(bad1.res.statusCode).toBe(400);
    const bad2 = mockReqRes({ params: { organisationId: orgId }, body: { idempotencyKey: 'k', amountPennies: 0 } });
    await creditPOST(bad2.req, bad2.res);
    expect(bad2.res.statusCode).toBe(400);
    const forbidden = mockReqRes({ role: 'owner', params: { organisationId: orgId }, body: { idempotencyKey: 'k', amountPennies: 100 } });
    await creditPOST(forbidden.req, forbidden.res);
    expect(forbidden.res.statusCode).toBe(403);
  });
});
