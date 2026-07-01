import {
  setupRealDatabase, teardownRealDatabase,
  RateCard, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

// Phase-0 schema smoke tests for the billing RateCard model (schema v44): the
// table syncs, column defaults apply, and the per-name EXCLUDE-gist non-overlap
// constraint (rate_cards_name_period_excl) actually enforces [start, end) ranges
// — overlap rejected, adjacency allowed, different names independent.

const PREFIX = `rc-test-${randomUUID()}-`;
const d = (iso) => new Date(iso);

describe('RateCard model + non-overlap constraint (schema v44)', () => {
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

  it('rejects two OVERLAPPING cards for the same name (exclusion constraint)', async () => {
    const name = `${PREFIX}overlap`;
    await RateCard.create({
      name, startDate: d('2026-01-01T00:00:00Z'), endDate: d('2026-06-01T00:00:00Z'),
    });
    let err;
    try {
      // [2026-03-01, open) overlaps [2026-01-01, 2026-06-01) for the same name.
      await RateCard.create({ name, startDate: d('2026-03-01T00:00:00Z'), endDate: null });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const sig = `${err?.name} ${err?.message} ${err?.original?.code} ${err?.parent?.constraint}`.toLowerCase();
    expect(sig).toMatch(/exclusion|rate_cards_name_period_excl|23p01/);
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
