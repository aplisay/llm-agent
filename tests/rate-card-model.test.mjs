import {
  setupRealDatabase, teardownRealDatabase,
  RateCard, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { resolveRateCard } from '../lib/rates.js';
import { randomUUID } from 'crypto';

// Schema smoke tests for the billing RateCard model: the table syncs, column
// defaults apply, and same-name cards resolve temporally. Since schema v59 there
// is NO period-overlap constraint (as for tariffs at v53) — overlapping and
// open-ended same-name cards are allowed and resolveRateCard disambiguates by
// the greatest start_date <= billedAt. The unique (name, start_date) index is
// the remaining guard: it is the one case the ordering cannot resolve.

const PREFIX = `rc-test-${randomUUID()}-`;
const d = (iso) => new Date(iso);

describe('RateCard model + temporal resolution (schema v59)', () => {
  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
  }, 30000);

  afterEach(async () => {
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
  });

  afterAll(async () => {
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await teardownRealDatabase();
  }, 30000);

  it('creates a card and applies column defaults (currency=gbp, detail={lines:[]}, endDate null)', async () => {
    const name = `${PREFIX}defaults`;
    const card = await RateCard.create({ name, startDate: d('2026-01-01T00:00:00Z') });
    expect(card.id).toBeTruthy();
    expect(card.currency).toBe('gbp');
    expect(card.detail).toEqual({ lines: [] });
    expect(card.endDate).toBeNull();
    const reread = await RateCard.findByPk(card.id);
    expect(reread.name).toBe(name);
  });

  it('ALLOWS overlapping / open-ended same-name cards; resolveRateCard disambiguates by latest start', async () => {
    const name = `${PREFIX}overlap`;
    // Two open-ended cards for one name — the shape a supersede actually takes,
    // since the incumbent cannot be end-dated once costed usage references it.
    await RateCard.create({ name, startDate: d('2026-01-01T00:00:00Z'), endDate: null });
    await expect(
      RateCard.create({ name, startDate: d('2026-03-01T00:00:00Z'), endDate: null }),
    ).resolves.toBeTruthy();
    // The greatest start_date <= billedAt wins: 1/1 covers February, 3/1 takes
    // over from March onwards without anything being closed.
    expect((await resolveRateCard(name, d('2026-02-01T00:00:00Z'))).startDate.toISOString())
      .toBe('2026-01-01T00:00:00.000Z');
    expect((await resolveRateCard(name, d('2026-04-01T00:00:00Z'))).startDate.toISOString())
      .toBe('2026-03-01T00:00:00.000Z');
    // Before any card exists for the name, nothing resolves.
    expect(await resolveRateCard(name, d('2025-12-01T00:00:00Z'))).toBeNull();
  });

  it('still rejects two cards for the same name sharing a start_date (unique index)', async () => {
    // The one ambiguity the ORDER BY start_date DESC cannot resolve, so this
    // guard has to stay even though the period constraint is gone.
    const name = `${PREFIX}dupe-start`;
    await RateCard.create({ name, startDate: d('2026-01-01T00:00:00Z'), endDate: null });
    let err;
    try {
      await RateCard.create({ name, startDate: d('2026-01-01T00:00:00Z'), endDate: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(`${err?.name}`.toLowerCase()).toMatch(/unique/);
  });

  it('an overlapping card supersedes WITHOUT the incumbent being end-dated', async () => {
    // The workflow the dropped constraint made impossible: a card in use cannot
    // have its endDate changed (beforeUpdate guard), so the successor has to be
    // placeable while the incumbent stays open-ended.
    const name = `${PREFIX}supersede`;
    const incumbent = await RateCard.create({
      name, startDate: d('2026-01-01T00:00:00Z'), endDate: null,
      detail: { lines: [{ dim: 'model', match: { technology: 'voice' }, unit: 'minute', priceMicros: 60000 }] },
    });
    await RateCard.create({
      name, startDate: d('2026-12-01T00:00:00Z'), endDate: null,
      detail: { lines: [{ dim: 'model', match: { technology: 'voice' }, unit: 'minute', priceMicros: 125000 }] },
    });
    const before = await resolveRateCard(name, d('2026-11-30T23:59:59Z'));
    const after = await resolveRateCard(name, d('2026-12-01T00:00:01Z'));
    expect(before.detail.lines[0].priceMicros).toBe(60000);
    expect(after.detail.lines[0].priceMicros).toBe(125000);
    // The incumbent is untouched — still open-ended, still its own price.
    await incumbent.reload();
    expect(incumbent.endDate).toBeNull();
  });

  it('allows ADJACENT [start, end) cards for the same name (end is exclusive)', async () => {
    const name = `${PREFIX}adjacent`;
    await RateCard.create({
      name, startDate: d('2026-01-01T00:00:00Z'), endDate: d('2026-03-01T00:00:00Z'),
    });
    await RateCard.create({
      name, startDate: d('2026-03-01T00:00:00Z'), endDate: d('2026-06-01T00:00:00Z'),
    });
    expect(await RateCard.count({ where: { name } })).toBe(2);
  });

  it('allows time-overlapping cards for DIFFERENT names', async () => {
    const a = `${PREFIX}name-a`;
    const b = `${PREFIX}name-b`;
    await RateCard.create({ name: a, startDate: d('2026-01-01T00:00:00Z'), endDate: null });
    await RateCard.create({ name: b, startDate: d('2026-01-01T00:00:00Z'), endDate: null });
    expect(await RateCard.count({ where: { name: a } })).toBe(1);
    expect(await RateCard.count({ where: { name: b } })).toBe(1);
  });
});
