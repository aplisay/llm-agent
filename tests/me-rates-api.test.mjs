import {
  setupRealDatabase, teardownRealDatabase,
  Organisation, User, RateCard, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * GET /api/me/rates — the SELF-SCOPED read of the rate card in force for the
 * caller's own organisation (the customer-visible half of "your full rate card
 * is visible in the dashboard").
 *
 * The two things that must hold whatever else changes:
 *  - it is gated on `usage:read`, which an owner holds, and NOT on `rate:read`
 *    (superAdmin platform config over EVERY customer's pricing);
 *  - the org comes from the principal, never the request — so a user in org B
 *    can never be shown org A's card.
 * Plus: "not rated" is a real current state reported as a 200, not a 500 and not
 * an empty card (an unrated org is metered but never charged).
 */

const mockLogger = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child() { return mockLogger; } };

function callRoute(GET, user) {
  const req = { params: {}, body: {}, query: {}, log: mockLogger };
  const res = { locals: { user }, statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  return GET(req, res).then(() => res);
}

describe('GET /api/me/rates (own organisation)', () => {
  const PREFIX = `me-rates-${randomUUID()}-`;
  const START = new Date('2020-01-01T00:00:00Z');
  const cardA = `${PREFIX}a`;
  const cardB = `${PREFIX}b`;
  let GET;
  let orgA; let orgB; let orgNone; let orgStale;
  let userA; let userB; let userNone; let userStale; let userOverride;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    GET = (await import('../api/paths/me/rates.js')).default(mockLogger).GET;

    await RateCard.create({
      name: cardA,
      startDate: START,
      currency: 'gbp',
      description: 'Org A pricing',
      detail: { lines: [{ dim: 'audio-path', match: { technology: 'voice', media: 'telephony' }, unit: 'minute', priceMicros: 60_000 }] },
    });
    await RateCard.create({
      name: cardB,
      startDate: START,
      currency: 'gbp',
      detail: { lines: [{ dim: 'model', match: { technology: 'voice' }, unit: 'minute', priceMicros: 90_000 }] },
    });

    const mkOrg = async (name, rateHistory) => {
      const id = randomUUID();
      await Organisation.create({ id, name, ...(rateHistory ? { rateHistory } : {}) });
      return id;
    };
    const mkUser = async (organisationId, extra = {}) => {
      const id = randomUUID();
      await User.create({
        id, name: 'Rate Reader', email: `mr-${id}@example.com`,
        emailVerified: true, phone: '', phoneVerified: false, picture: '',
        role: 'owner', organisationId, ...extra,
      });
      return id;
    };

    orgA = await mkOrg(`${PREFIX}A`, [{ name: cardA, startDate: START.toISOString() }]);
    orgB = await mkOrg(`${PREFIX}B`, [{ name: cardB, startDate: START.toISOString() }]);
    orgNone = await mkOrg(`${PREFIX}none`, null);
    // Assigned a name whose card only starts in 2099 — a name with no covering version.
    orgStale = await mkOrg(`${PREFIX}stale`, [{ name: `${PREFIX}never`, startDate: START.toISOString() }]);

    userA = await mkUser(orgA);
    userB = await mkUser(orgB);
    userNone = await mkUser(orgNone);
    userStale = await mkUser(orgStale);
    // Phase-5 per-user override: sits in org A but is priced on card B.
    userOverride = await mkUser(orgA, { rateHistory: [{ name: cardB, startDate: START.toISOString() }] });
  }, 30000);

  afterAll(async () => {
    await User.destroy({ where: { organisationId: { [Op.in]: [orgA, orgB, orgNone, orgStale] } } });
    await Organisation.destroy({ where: { id: { [Op.in]: [orgA, orgB, orgNone, orgStale] } } });
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await teardownRealDatabase();
  }, 30000);

  it('gives an owner their own card, with lines and no internal ids', async () => {
    const res = await callRoute(GET, { id: userA, role: 'owner', organisationId: orgA });
    expect(res.statusCode).toBe(200);
    expect(res.body.rated).toBe(true);
    expect(res.body.name).toBe(cardA);
    expect(res.body.currency).toBe('gbp');
    expect(res.body.description).toBe('Org A pricing');
    expect(new Date(res.body.startDate).toISOString()).toBe(START.toISOString());
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({ dim: 'audio-path', unit: 'minute', priceMicros: 60_000 });
    // Billing arithmetic the customer needs to read the card correctly.
    expect(res.body.billingIncrementSeconds).toBe(6);
    // Never leak the card row's identity or authorship.
    expect(res.body.id).toBeUndefined();
    expect(res.body.createdBy).toBeUndefined();
  });

  it('gives a member the same card (usage:read, not rate:read)', async () => {
    const res = await callRoute(GET, { id: userA, role: 'member', organisationId: orgA });
    expect(res.statusCode).toBe(200);
    expect(res.body.name).toBe(cardA);
  });

  it('403s a principal without usage:read', async () => {
    // billingService holds rate:read but NOT usage:read — proof the gate is the
    // usage capability and not the platform-pricing one.
    const res = await callRoute(GET, { id: userA, role: 'billingService', organisationId: orgA });
    expect(res.statusCode).toBe(403);
    expect(res.body.detail).toMatch(/usage:read/);
  });

  it("never shows another organisation's card", async () => {
    const a = await callRoute(GET, { id: userA, role: 'owner', organisationId: orgA });
    const b = await callRoute(GET, { id: userB, role: 'owner', organisationId: orgB });
    expect(a.body.name).toBe(cardA);
    expect(b.body.name).toBe(cardB);
    expect(b.body.name).not.toBe(cardA);
    expect(JSON.stringify(b.body.lines)).not.toContain('60000');
  });

  it('honours the per-user rate override, as costing does', async () => {
    const res = await callRoute(GET, { id: userOverride, role: 'owner', organisationId: orgA });
    // Same org as userA, different card — the user's own rateHistory wins.
    expect(res.body.rated).toBe(true);
    expect(res.body.name).toBe(cardB);
  });

  it('reports an unrated organisation as a 200 "not rated", not an empty card', async () => {
    const res = await callRoute(GET, { id: userNone, role: 'owner', organisationId: orgNone });
    expect(res.statusCode).toBe(200);
    expect(res.body.rated).toBe(false);
    expect(res.body.reason).toMatch(/metered but not charged/);
    expect(res.body.lines).toEqual([]);
    expect(res.body.name).toBeNull();
  });

  it('reports an assigned name with no covering card as "not rated", naming it', async () => {
    const res = await callRoute(GET, { id: userStale, role: 'owner', organisationId: orgStale });
    expect(res.statusCode).toBe(200);
    expect(res.body.rated).toBe(false);
    expect(res.body.name).toBe(`${PREFIX}never`);
    expect(res.body.reason).toMatch(/in force/);
  });

  it('follows a superseding same-name card rather than the original', async () => {
    // Same-name cards may overlap since schema v59: the greatest startDate <= now
    // wins, and this endpoint must resolve exactly as costUsageRow does.
    await RateCard.create({
      name: cardA,
      startDate: new Date(Date.now() - 60_000),
      currency: 'gbp',
      description: 'Org A pricing, superseded',
      detail: { lines: [{ dim: 'audio-path', match: { technology: 'voice', media: 'telephony' }, unit: 'minute', priceMicros: 70_000 }] },
    });
    const res = await callRoute(GET, { id: userA, role: 'owner', organisationId: orgA });
    expect(res.body.lines[0].priceMicros).toBe(70_000);
    expect(res.body.description).toBe('Org A pricing, superseded');
  });
});
