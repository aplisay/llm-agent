import {
  setupRealDatabase, teardownRealDatabase,
  Tariff, TariffPrefix, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import { matchTariffPrefix, normaliseDestination } from '../lib/tariffs.js';

/**
 * The tariff create/update ROUTES compress the prefix deck losslessly before persisting
 * (aggregation + hole-punching), so the stored `TariffPrefix` rows are the minimal set
 * that longest-prefix-matches identically. This drives the real handlers and checks the
 * PERSISTED deck via the same DB matcher the billing engine uses.
 */

const mockLogger = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child() { return mockLogger; } };
function mockReqRes({ params = {}, body = {} } = {}) {
  const req = { params, body, log: mockLogger };
  const res = { locals: { user: { id: 'admin-1', role: 'superAdmin' } }, statusCode: 200, body: undefined };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  return { req, res };
}
const mk = (prefix, v) => ({ prefix, connectMicros: v, peakPerMinuteMicros: v, offPeakPerMinuteMicros: v, minimumMicros: v, label: `v${v}` });

describe('/api/tariffs deck compression (persisted, super admin)', () => {
  const PREFIX = `tar-cmp-${randomUUID()}-`;
  let collPOST, itemPUT;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    collPOST = (await import('../api/paths/tariffs.js')).default(mockLogger).POST;
    itemPUT = (await import('../api/paths/tariffs/{tariffId}.js')).default(mockLogger).PUT;
  }, 30000);

  afterEach(async () => { await Tariff.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } }); });
  afterAll(async () => { await Tariff.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } }); await teardownRealDatabase(); }, 30000);

  const create = (body) => { const { req, res } = mockReqRes({ body }); return collPOST(req, res).then(() => res); };

  /** The value 4-tuple the engine's DB matcher returns for `number`, or 'UNCOVERED'. */
  const billed = async (tariffId, number) => {
    const n = normaliseDestination(number, { defaultCountry: 'GB' });
    const row = n ? await matchTariffPrefix(tariffId, n) : null;
    return row ? `${row.connectMicros}|${row.peakPerMinuteMicros}|${row.offPeakPerMinuteMicros}|${row.minimumMicros}` : 'UNCOVERED';
  };

  it('stores a compressed deck that bills identically (aggregation + hole-punch)', async () => {
    // 44 -> rate1, and all ten 447x -> rate2 (aggregates to 447), plus a redundant 4471x.
    const deck = [mk('44', 1), ...Array.from({ length: 10 }, (_, d) => mk(`447${d}`, 2)), mk('44715', 2)];
    const res = await create({ name: `${PREFIX}agg`, startDate: '2026-01-01T00:00:00Z', prefixes: deck });
    expect(res.statusCode).toBe(201);
    const id = res.body.id;

    const stored = await TariffPrefix.count({ where: { tariffId: id } });
    expect(stored).toBe(2); // 44, 447

    // Bills identically for representative numbers (compare original intent vs stored).
    expect(await billed(id, '447700000000')).toBe('2|2|2|2'); // under 447 -> rate2
    expect(await billed(id, '447155500000')).toBe('2|2|2|2'); // the redundant 44715 still rate2
    expect(await billed(id, '448000000000')).toBe('1|1|1|1'); // under 44 -> rate1
    expect(await billed(id, '330000000000')).toBe('UNCOVERED'); // unmatched
  });

  it('a nine-child block with a gap does NOT over-aggregate over the gap', async () => {
    // 447{0..8} -> rate2 (447 has a gap at 9), parent 44 -> rate1.
    const deck = [mk('44', 1), ...Array.from({ length: 9 }, (_, d) => mk(`447${d}`, 2))];
    const res = await create({ name: `${PREFIX}gap`, startDate: '2026-01-01T00:00:00Z', prefixes: deck });
    expect(res.statusCode).toBe(201);
    const id = res.body.id;
    expect(await TariffPrefix.count({ where: { tariffId: id } })).toBe(10); // cannot collapse to 447
    expect(await billed(id, '447000000000')).toBe('2|2|2|2');
    expect(await billed(id, '447900000000')).toBe('1|1|1|1'); // 4479 falls back to 44, not rate2
  });

  it('PUT replaces with a compressed deck', async () => {
    const res = await create({ name: `${PREFIX}put`, startDate: '2026-01-01T00:00:00Z', prefixes: [mk('44', 1)] });
    const id = res.body.id;
    // Replace with a redundant deck: 44 + 447 same rate -> 447 is redundant.
    const { req, res: pRes } = mockReqRes({ params: { tariffId: id }, body: { prefixes: [mk('44', 5), mk('447', 5), mk('4477', 5)] } });
    await itemPUT(req, pRes);
    expect(pRes.statusCode).toBe(200);
    expect(await TariffPrefix.count({ where: { tariffId: id } })).toBe(1); // all collapse to 44
    expect(await billed(id, '447700000000')).toBe('5|5|5|5');
  });
});
