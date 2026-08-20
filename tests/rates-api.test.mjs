import {
  setupRealDatabase, teardownRealDatabase,
  RateCard, UsageRecord, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

// Phase-3 admin API: /api/rates CRUD (super-admin gated via the `rate` resource),
// honouring the duplicate-start + immutable-once-referenced invariants. Periods
// may overlap since v59 — the latest start covering the billing instant wins.

const mockLogger = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child() { return mockLogger; } };

function mockReqRes({ role = 'superAdmin', params = {}, body = {}, query = {} } = {}) {
  const req = { params, body, query, log: mockLogger };
  const res = { locals: { user: { id: 'admin-1', role } }, statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  return { req, res };
}

describe('/api/rates CRUD (super admin)', () => {
  const PREFIX = `rate-api-${randomUUID()}-`;
  let listGET, collPOST, itemGET, itemPATCH, itemDELETE;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    const coll = (await import('../api/paths/rates.js')).default(mockLogger);
    listGET = coll.GET; collPOST = coll.POST;
    const item = (await import('../api/paths/rates/{rateId}.js')).default(mockLogger);
    itemGET = item.GET; itemPATCH = item.PATCH; itemDELETE = item.DELETE;
  }, 30000);

  afterEach(async () => {
    await UsageRecord.destroy({ where: { rateName: { [Op.like]: `${PREFIX}%` } } });
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
  });

  afterAll(async () => {
    await UsageRecord.destroy({ where: { rateName: { [Op.like]: `${PREFIX}%` } } });
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await teardownRealDatabase();
  }, 30000);

  const create = (body) => { const { req, res } = mockReqRes({ body }); return collPOST(req, res).then(() => res); };

  it('rejects non-super principals (403)', async () => {
    const { req, res } = mockReqRes({ role: 'owner', query: {} });
    await listGET(req, res);
    expect(res.statusCode).toBe(403);
  });

  it('creates, lists, and gets a rate card', async () => {
    const name = `${PREFIX}c1`;
    const cRes = await create({
      name, startDate: '2026-01-01T00:00:00Z',
      detail: { lines: [{ dim: 'audio-path', match: { technology: 'voice', provider: 'livekit', media: 'webrtc' }, unit: 'minute', priceMicros: 500000 }] },
    });
    expect(cRes.statusCode).toBe(201);
    const id = cRes.body.id;

    const { req: lReq, res: lRes } = mockReqRes({ query: { name } });
    await listGET(lReq, lRes);
    expect(lRes.body.rates).toHaveLength(1);

    const { req: gReq, res: gRes } = mockReqRes({ params: { rateId: id } });
    await itemGET(gReq, gRes);
    expect(gRes.body.name).toBe(name);
  });

  it('400s on a malformed rate line and missing required fields', async () => {
    const bad = await create({ name: `${PREFIX}bad`, startDate: '2026-01-01Z', detail: { lines: [{ dim: 'nope', unit: 'minute', priceMicros: 1 }] } });
    expect(bad.statusCode).toBe(400);
    const missing = await create({ startDate: '2026-01-01Z' });
    expect(missing.statusCode).toBe(400);
  });

  it('201s a card that overlaps an open-ended one for the same name (it supersedes)', async () => {
    // Since v59 there is no period constraint: the later card simply takes over
    // from its own start, which is what lets an in-use card be superseded at all.
    const name = `${PREFIX}ov`;
    expect((await create({ name, startDate: '2026-01-01Z' })).statusCode).toBe(201); // open-ended
    expect((await create({ name, startDate: '2026-06-01Z' })).statusCode).toBe(201); // overlaps it
  });

  it('409s a second card starting at the SAME instant for one name', async () => {
    const name = `${PREFIX}same-start`;
    expect((await create({ name, startDate: '2026-01-01Z' })).statusCode).toBe(201);
    const dup = await create({ name, startDate: '2026-01-01Z' });
    expect(dup.statusCode).toBe(409);
  });

  it('updates an unreferenced card but 409s once referenced (immutable)', async () => {
    const name = `${PREFIX}imm`;
    const c = await create({ name, startDate: '2026-01-01T00:00:00Z', detail: { lines: [] } });
    const id = c.body.id;

    // Unreferenced: editable.
    const { req: u1, res: r1 } = mockReqRes({ params: { rateId: id }, body: { description: 'v1' } });
    await itemPATCH(u1, r1);
    expect(r1.statusCode).toBe(200);

    // Reference it with a costed usage row, then a pricing edit is rejected.
    await UsageRecord.create({
      sessionId: randomUUID(), meterKey: randomUUID(), technology: 'voice', unit: 'milliseconds',
      quantity: 1, finalised: true, rateName: name, rateCardStart: new Date('2026-01-01T00:00:00Z'),
      costMicros: 1, costStatus: 'matched',
    });
    const { req: u2, res: r2 } = mockReqRes({ params: { rateId: id }, body: { detail: { lines: [{ dim: 'model', match: {}, unit: 'minute', priceMicros: 9 }] } } });
    await itemPATCH(u2, r2);
    expect(r2.statusCode).toBe(409);
  });

  it('blocks DELETE of a referenced card (409), allows it otherwise', async () => {
    const name = `${PREFIX}del`;
    const c = await create({ name, startDate: '2026-01-01T00:00:00Z' });
    const id = c.body.id;
    await UsageRecord.create({
      sessionId: randomUUID(), meterKey: randomUUID(), technology: 'voice', unit: 'milliseconds',
      quantity: 1, finalised: true, rateName: name, rateCardStart: new Date('2026-01-01T00:00:00Z'),
      costMicros: 1, costStatus: 'matched',
    });
    const { req: d1, res: r1 } = mockReqRes({ params: { rateId: id } });
    await itemDELETE(d1, r1);
    expect(r1.statusCode).toBe(409);

    // Remove the reference -> deletable.
    await UsageRecord.destroy({ where: { rateName: name } });
    const { req: d2, res: r2 } = mockReqRes({ params: { rateId: id } });
    await itemDELETE(d2, r2);
    expect(r2.statusCode).toBe(200);
  });
});
