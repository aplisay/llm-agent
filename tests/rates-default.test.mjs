import {
  setupRealDatabase, teardownRealDatabase,
  Metadata, RateCard, Organisation, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import {
  getDefaultRateName, setDefaultRateName, validateDefaultRateName,
  defaultRateHistoryEntry, DEFAULT_RATE_KEY,
} from '../lib/rates.js';

// The platform DEFAULT rate (Phase-3 billing): a Metadata singleton holding the
// rate NAME a brand-new org is stamped with at creation, so no org is ever
// silently left uncosted. Covers the lib/rates.js helpers, the GET/PUT
// /api/rates/default route + the defaultRateName on GET /api/rates, and the
// org-create auto-assign.

const mockLogger = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child() { return mockLogger; } };

function mockReqRes({ role = 'superAdmin', params = {}, body = {}, query = {} } = {}) {
  const req = { params, body, query, log: mockLogger };
  const res = { locals: { user: { id: 'admin-1', role } }, statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  return { req, res };
}

describe('platform default rate', () => {
  const PREFIX = `default-rate-${randomUUID()}-`;
  let ratesGET, defGET, defPUT, orgPOST;

  // A rate card whose interval [2020-01-01, ∞) covers "now" for `name`.
  const seedCard = (name) => RateCard.create({
    name, startDate: '2020-01-01T00:00:00Z', endDate: null, detail: { lines: [] },
  });

  const clearDefault = () => Metadata.destroy({ where: { key: DEFAULT_RATE_KEY } });

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    const rates = (await import('../api/paths/rates.js')).default(mockLogger);
    ratesGET = rates.GET;
    const def = (await import('../api/paths/rates/default.js')).default(mockLogger);
    defGET = def.GET; defPUT = def.PUT;
    orgPOST = (await import('../api/paths/organisations.js')).default(mockLogger).POST;
  }, 30000);

  afterEach(async () => {
    await clearDefault();
    await Organisation.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
  });

  afterAll(async () => {
    await clearDefault();
    await Organisation.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await teardownRealDatabase();
  }, 30000);

  // --- helpers -------------------------------------------------------------

  it('getDefaultRateName returns null when unset', async () => {
    expect(await getDefaultRateName()).toBeNull();
  });

  it('set → get round-trips, and null clears', async () => {
    const name = `${PREFIX}std`;
    await seedCard(name);
    expect(await setDefaultRateName(name)).toBe(name);
    expect(await getDefaultRateName()).toBe(name);
    expect(await setDefaultRateName(null)).toBeNull();
    expect(await getDefaultRateName()).toBeNull();
  });

  it('validateDefaultRateName: null/"" clears (valid); unknown name rejected; covered name accepted', async () => {
    const name = `${PREFIX}ok`;
    await seedCard(name);
    expect(await validateDefaultRateName(null)).toBeNull();
    expect(await validateDefaultRateName('')).toBeNull();
    expect(await validateDefaultRateName(`${PREFIX}missing`)).toMatch(/no rate card/);
    expect(await validateDefaultRateName(name)).toBeNull();
  });

  it('defaultRateHistoryEntry: null when unset; a single [{name, startDate}] when set', async () => {
    const name = `${PREFIX}h`;
    await seedCard(name);
    expect(await defaultRateHistoryEntry()).toBeNull();
    await setDefaultRateName(name);
    const entry = await defaultRateHistoryEntry();
    expect(entry).toHaveLength(1);
    expect(entry[0].name).toBe(name);
    expect(new Date(entry[0].startDate).valueOf()).not.toBeNaN();
  });

  it('defaultRateHistoryEntry: null when the configured name has no card covering now (defensive)', async () => {
    // Card that ENDED in the past — does not cover now. Set the Metadata key
    // directly (bypassing validation) to exercise the defensive fallback.
    const name = `${PREFIX}expired`;
    await RateCard.create({ name, startDate: '2020-01-01T00:00:00Z', endDate: '2021-01-01T00:00:00Z', detail: { lines: [] } });
    await Metadata.upsert({ key: DEFAULT_RATE_KEY, value: name });
    expect(await getDefaultRateName()).toBe(name);
    expect(await defaultRateHistoryEntry()).toBeNull();
  });

  // --- GET/PUT /api/rates/default -----------------------------------------

  it('GET /api/rates/default requires rate:read (403 for owner)', async () => {
    const { req, res } = mockReqRes({ role: 'owner' });
    await defGET(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('PUT /api/rates/default requires rate:update (403 for orgAdmin)', async () => {
    const { req, res } = mockReqRes({ role: 'orgAdmin', body: { defaultRateName: 'x' } });
    await defPUT(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('PUT rejects a name with no covering card (400) and does not persist', async () => {
    const { req, res } = mockReqRes({ body: { defaultRateName: `${PREFIX}nope` } });
    await defPUT(req, res);
    expect(res.statusCode).toBe(400);
    expect(await getDefaultRateName()).toBeNull();
  });

  it('PUT sets a valid name, GET reads it back, PUT null clears it', async () => {
    const name = `${PREFIX}live`;
    await seedCard(name);

    const { req: pReq, res: pRes } = mockReqRes({ body: { defaultRateName: name } });
    await defPUT(pReq, pRes);
    expect(pRes.statusCode).toBe(200);
    expect(pRes.body.defaultRateName).toBe(name);

    const { req: gReq, res: gRes } = mockReqRes();
    await defGET(gReq, gRes);
    expect(gRes.body.defaultRateName).toBe(name);

    const { req: cReq, res: cRes } = mockReqRes({ body: { defaultRateName: null } });
    await defPUT(cReq, cRes);
    expect(cRes.body.defaultRateName).toBeNull();
    expect(await getDefaultRateName()).toBeNull();
  });

  it('GET /api/rates carries defaultRateName alongside the cards', async () => {
    const name = `${PREFIX}listed`;
    await seedCard(name);
    await setDefaultRateName(name);
    const { req, res } = mockReqRes({ query: { name } });
    await ratesGET(req, res);
    expect(res.body.rates).toHaveLength(1);
    expect(res.body.defaultRateName).toBe(name);
  });

  // --- org-create auto-assign ---------------------------------------------

  it('POST /api/organisations stamps the default rate onto a new org', async () => {
    const name = `${PREFIX}card`;
    await seedCard(name);
    await setDefaultRateName(name);

    const { req, res } = mockReqRes({ body: { name: `${PREFIX}org` } });
    await orgPOST(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.rateHistory).toHaveLength(1);
    expect(res.body.rateHistory[0].name).toBe(name);
  });

  it('POST /api/organisations leaves rateHistory unset when no default is configured', async () => {
    const { req, res } = mockReqRes({ body: { name: `${PREFIX}org-nodefault` } });
    await orgPOST(req, res);
    expect(res.statusCode).toBe(201);
    expect(res.body.rateHistory == null).toBe(true);
  });
});
