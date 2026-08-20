import {
  setupRealDatabase, teardownRealDatabase,
  Organisation, BalanceCredit, RateCard, User, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import { penniesToMicros, microsToPennies, MICROS_PER_PENNY } from '../lib/rates.js';
import { can } from '../lib/auth/permissions.js';

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
  let orgId, rateHistGET, rateHistPUT, balGET, creditPOST, billingGET, billingPATCH;

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
    const billing = (await import('../api/paths/organisations/{organisationId}/billing.js')).default(mockLogger);
    billingGET = billing.GET; billingPATCH = billing.PATCH;
  }, 30000);

  afterEach(async () => {
    await BalanceCredit.destroy({ where: { organisationId: orgId } });
    await Organisation.update(
      { balance: null, rateHistory: null, billingBlocked: false, billingConfig: null, chargeableNumberLimit: 3 },
      { where: { id: orgId } },
    );
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

  it('the billingService role can credit AND put an org on its rate card', async () => {
    const c = mockReqRes({ role: 'billingService', params: { organisationId: orgId }, body: { idempotencyKey: 'svc-1', amountPennies: 300 } });
    await creditPOST(c.req, c.res);
    expect(c.res.statusCode).toBe(200);
    expect(c.res.body.balancePennies).toBe(300);

    // Rate assignment is the same seam's job: a client billing service puts an
    // org on the card its subscription package implies when the account is
    // approved or the subscription changes. Reading FIRST is part of it — the
    // assignment is idempotent, so it compares the existing timeline before
    // writing — and this principal carries no organisationId of its own, so it
    // reaches the row only via organisation:readAll.
    const before = mockReqRes({ role: 'billingService', params: { organisationId: orgId } });
    await rateHistGET(before.req, before.res);
    expect(before.res.statusCode).toBe(200);

    const r = mockReqRes({
      role: 'billingService',
      params: { organisationId: orgId },
      body: { rateHistory: [{ name: `${PREFIX}r1`, startDate: '2026-02-01T00:00:00.000Z' }] },
    });
    await rateHistPUT(r.req, r.res);
    expect(r.res.statusCode).toBe(200);
    const saved = (await Organisation.findByPk(orgId)).rateHistory;
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe(`${PREFIX}r1`);
  });

  it('billingService still cannot author or alter the rate cards themselves', async () => {
    // The boundary that survives: it prices its own tenants against cards a
    // super admin authors. Widening `organisation:setRate` must not have
    // dragged the pricing config along with it.
    for (const action of ['create', 'update', 'delete']) {
      expect(can({ role: 'billingService' }, 'rate', action)).toBe(false);
      expect(can({ role: 'billingService' }, 'tariff', action)).toBe(false);
    }
    expect(can({ role: 'billingService' }, 'organisation', 'update')).toBe(false);
    expect(can({ role: 'billingService' }, 'organisation', 'delete')).toBe(false);
  });

  it('credit 400s missing key / zero amount, and 403s a non-super', async () => {
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

  // --- signed amounts (clawback seam) ---
  it('a negative amount debits the balance, idempotently, and may go negative', async () => {
    const adjust = (key, pennies) => {
      const { req, res } = mockReqRes({ role: 'billingService', params: { organisationId: orgId }, body: { idempotencyKey: key, amountPennies: pennies } });
      return creditPOST(req, res).then(() => res);
    };
    await adjust('grant-1', 500);
    const debit = await adjust('claw-1', -200);
    expect(debit.statusCode).toBe(200);
    expect(debit.body.balancePennies).toBe(300);

    const dup = await adjust('claw-1', -200); // replayed clawback applies once
    expect(dup.body.idempotent).toBe(true);
    expect(dup.body.balancePennies).toBe(300);

    const over = await adjust('claw-2', -400); // usage raced the clawback — negative is a fact
    expect(over.body.balancePennies).toBe(-100);
  });

  // --- billing controls (billingBlocked + billingConfig) ---
  it('billingService can set + read billing controls; balance GET reports blocked', async () => {
    const patch = (body) => {
      const { req, res } = mockReqRes({ role: 'billingService', params: { organisationId: orgId }, body });
      return billingPATCH(req, res).then(() => res);
    };
    const blocked = await patch({ billingBlocked: true });
    expect(blocked.statusCode).toBe(200);
    expect(blocked.body.billingBlocked).toBe(true);
    expect((await Organisation.findByPk(orgId)).billingBlocked).toBe(true);

    const cfg = { callbackUrl: 'https://app.polite.ai/api/billing-callback', hashKey: 'k'.repeat(32), balanceLowPennies: 500 };
    const withCfg = await patch({ billingConfig: cfg });
    expect(withCfg.statusCode).toBe(200);
    expect(withCfg.body.billingConfig).toEqual(cfg);

    const read = mockReqRes({ role: 'billingService', params: { organisationId: orgId } });
    await billingGET(read.req, read.res);
    expect(read.res.body).toEqual({ billingBlocked: true, billingConfig: cfg, chargeableNumberLimit: 3 });

    // balance read (own-org member) surfaces the block flag
    const bal = mockReqRes({ role: 'owner', organisationId: orgId, params: { organisationId: orgId } });
    await balGET(bal.req, bal.res);
    expect(bal.res.body.blocked).toBe(true);

    const cleared = await patch({ billingBlocked: false, billingConfig: null });
    expect(cleared.body).toEqual({ billingBlocked: false, billingConfig: null, chargeableNumberLimit: 3 });
  });

  it('billing PATCH sets chargeableNumberLimit (integer >= 0, null = unlimited) and validates it', async () => {
    const patch = (body, role = 'billingService') => {
      const { req, res } = mockReqRes({ role, params: { organisationId: orgId }, body });
      return billingPATCH(req, res).then(() => res);
    };

    const raised = await patch({ chargeableNumberLimit: 10 });
    expect(raised.statusCode).toBe(200);
    expect(raised.body.chargeableNumberLimit).toBe(10);
    expect((await Organisation.findByPk(orgId)).chargeableNumberLimit).toBe(10);

    const zero = await patch({ chargeableNumberLimit: 0 });
    expect(zero.statusCode).toBe(200);
    expect((await Organisation.findByPk(orgId)).chargeableNumberLimit).toBe(0);

    const unlimited = await patch({ chargeableNumberLimit: null });
    expect(unlimited.statusCode).toBe(200);
    expect(unlimited.body.chargeableNumberLimit).toBeNull();
    expect((await Organisation.findByPk(orgId)).chargeableNumberLimit).toBeNull();

    // Settable alongside the other billing controls in one PATCH.
    const combined = await patch({ billingBlocked: true, chargeableNumberLimit: 1 });
    expect(combined.statusCode).toBe(200);
    expect(combined.body).toMatchObject({ billingBlocked: true, chargeableNumberLimit: 1 });

    // Invalid values reject without persisting anything.
    expect((await patch({ chargeableNumberLimit: -1 })).statusCode).toBe(400);
    expect((await patch({ chargeableNumberLimit: 1.5 })).statusCode).toBe(400);
    expect((await patch({ chargeableNumberLimit: '3' })).statusCode).toBe(400);
    expect((await Organisation.findByPk(orgId)).chargeableNumberLimit).toBe(1);

    // Same gate as the rest of the billing controls.
    expect((await patch({ chargeableNumberLimit: 99 }, 'owner')).statusCode).toBe(403);
  });

  it('billing PATCH validates: unsafe URL, short hashKey, bad types, empty body, owner 403', async () => {
    const patch = (body, role = 'billingService') => {
      const { req, res } = mockReqRes({ role, params: { organisationId: orgId }, body });
      return billingPATCH(req, res).then(() => res);
    };
    expect((await patch({ billingConfig: { callbackUrl: 'http://127.0.0.1/x', hashKey: 'k'.repeat(32) } })).statusCode).toBe(400);
    expect((await patch({ billingConfig: { callbackUrl: 'https://ok.example.com/x', hashKey: 'short' } })).statusCode).toBe(400);
    expect((await patch({ billingConfig: { callbackUrl: 'https://ok.example.com/x', hashKey: 'k'.repeat(32), balanceLowPennies: -5 } })).statusCode).toBe(400);
    expect((await patch({ billingBlocked: 'yes' })).statusCode).toBe(400);
    expect((await patch({})).statusCode).toBe(400);
    expect((await patch({ billingBlocked: true }, 'owner')).statusCode).toBe(403);
    // nothing stuck from the failed attempts
    const org = await Organisation.findByPk(orgId);
    expect(org.billingBlocked).toBe(false);
    expect(org.billingConfig).toBeNull();
  });
});
