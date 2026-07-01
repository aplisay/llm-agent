import {
  setupRealDatabase, teardownRealDatabase,
  Tariff, TariffPrefix, UsageRecord, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import {
  normaliseDestination, callingCodeFor, longestPrefixMatch, destinationCostMicros,
  validatePrefixes, validateTariffInput, resolveTariff, matchTariffPrefix, isTariffReferenced,
} from '../lib/tariffs.js';

// Phase-D destination tariffs: the env-independent core (normalise / longest-prefix
// match / validation / cost) plus the model behaviours that mirror RateCard
// (temporal resolution, per-name non-overlap, immutable-once-referenced).

const PREFIX = `tar-test-${randomUUID()}-`;
const d = (iso) => new Date(iso);

describe('tariff core (pure)', () => {
  it('normalises international + local destinations to digits-only', () => {
    expect(normaliseDestination('+447970123456')).toBe('447970123456');
    expect(normaliseDestination('00447970123456')).toBe('447970123456');
    expect(normaliseDestination('447970123456')).toBe('447970123456');
    expect(normaliseDestination('07970123456')).toBe('447970123456');     // GB local → 44
    expect(normaliseDestination('01539 761541')).toBe('441539761541');     // separators + local
    expect(normaliseDestination('+1 (415) 555-2671')).toBe('14155552671');
  });

  it('rejects un-chargeable inputs (sentinels / too short / unknown home country)', () => {
    expect(normaliseDestination('WebRTC')).toBeNull();
    expect(normaliseDestination('00000')).toBeNull();
    expect(normaliseDestination('')).toBeNull();
    expect(normaliseDestination(null)).toBeNull();
    // A local '0…' number with a home country that has no known calling code → null.
    expect(normaliseDestination('07970123456', { defaultCountry: 'ZZ' })).toBeNull();
  });

  it('honours a per-tariff default country for local numbers', () => {
    expect(normaliseDestination('0851234567', { defaultCountry: 'IE' })).toBe('353851234567');
    expect(callingCodeFor('IE')).toBe('353');
    expect(callingCodeFor('zz')).toBeNull();
  });

  it('longest-prefix match picks the most specific prefix', () => {
    const deck = [{ prefix: '44' }, { prefix: '447' }, { prefix: '447970' }];
    expect(longestPrefixMatch('4471234577', deck).prefix).toBe('447');       // 447, not 44
    expect(longestPrefixMatch('44797012234', deck).prefix).toBe('447970');   // 447970
    expect(longestPrefixMatch('4420123456', deck).prefix).toBe('44');
    expect(longestPrefixMatch('33123456', deck)).toBeNull();                 // no prefix matches
  });

  it('destinationCostMicros = connect + perMinute × minutes', () => {
    expect(destinationCostMicros({ connectMicros: 50_000, perMinuteMicros: 20_000 }, 2.5)).toBe(100_000);
    expect(destinationCostMicros({ connectMicros: 0, perMinuteMicros: 80_000 }, 3)).toBe(240_000);
    expect(destinationCostMicros(null, 5)).toBe(0);
  });

  it('validates prefix decks and tariff input', () => {
    expect(validatePrefixes([{ prefix: '447', connectMicros: 0, perMinuteMicros: 20000 }])).toBeNull();
    expect(validatePrefixes([{ prefix: '44a', connectMicros: 0, perMinuteMicros: 0 }])).toMatch(/1-15 digits/);
    expect(validatePrefixes([{ prefix: '44', connectMicros: 0, perMinuteMicros: 0 }, { prefix: '44', connectMicros: 1, perMinuteMicros: 1 }])).toMatch(/duplicate/);
    expect(validatePrefixes([{ prefix: '44', connectMicros: -1, perMinuteMicros: 0 }])).toMatch(/connectMicros/);
    expect(validateTariffInput({ name: '', startDate: '2026-01-01' })).toMatch(/name/);
    expect(validateTariffInput({ name: 'x', startDate: '2026-01-01', defaultCountry: 'ZZ' })).toMatch(/calling code/);
    expect(validateTariffInput({ name: 'x', startDate: '2026-01-01', defaultCountry: 'GB', prefixes: [] })).toBeNull();
  });
});

describe('Tariff model (schema v48)', () => {
  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
  }, 30000);

  afterEach(async () => {
    await Tariff.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } }); // cascades prefixes
    await UsageRecord.destroy({ where: { sessionId: { [Op.like]: `${PREFIX}%` } } });
  });

  afterAll(async () => {
    await Tariff.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await UsageRecord.destroy({ where: { sessionId: { [Op.like]: `${PREFIX}%` } } });
    await teardownRealDatabase();
  }, 30000);

  const mkTariff = async (name, over = {}) => {
    const t = await Tariff.create({ name, startDate: d('2026-01-01T00:00:00Z'), ...over });
    return t;
  };

  it('applies column defaults (currency=gbp, defaultCountry=GB, endDate null)', async () => {
    const t = await mkTariff(`${PREFIX}defaults`);
    expect(t.currency).toBe('gbp');
    expect(t.defaultCountry).toBe('GB');
    expect(t.endDate).toBeNull();
  });

  it('stores a prefix deck and longest-prefix matches it in the DB', async () => {
    const name = `${PREFIX}deck`;
    const t = await mkTariff(name);
    await TariffPrefix.bulkCreate([
      { tariffId: t.id, prefix: '44', connectMicros: 0, perMinuteMicros: 10_000 },
      { tariffId: t.id, prefix: '447', connectMicros: 0, perMinuteMicros: 20_000 },
      { tariffId: t.id, prefix: '447970', connectMicros: 50_000, perMinuteMicros: 80_000 },
    ]);
    const m1 = await matchTariffPrefix(t.id, '4471234577');
    expect(m1.prefix).toBe('447');
    expect(Number(m1.perMinuteMicros)).toBe(20_000);
    const m2 = await matchTariffPrefix(t.id, '44797012234');
    expect(m2.prefix).toBe('447970');
    expect(Number(m2.connectMicros)).toBe(50_000);
    const m3 = await matchTariffPrefix(t.id, '33123456'); // no prefix
    expect(m3).toBeNull();
  });

  it('resolveTariff picks the version effective at billedAt', async () => {
    const name = `${PREFIX}temporal`;
    await mkTariff(name, { startDate: d('2026-01-01T00:00:00Z'), endDate: d('2026-06-01T00:00:00Z') });
    await mkTariff(name, { startDate: d('2026-06-01T00:00:00Z'), endDate: null });
    expect((await resolveTariff(name, d('2026-03-01T00:00:00Z'))).startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect((await resolveTariff(name, d('2026-07-01T00:00:00Z'))).startDate.toISOString()).toBe('2026-06-01T00:00:00.000Z');
    expect(await resolveTariff(name, d('2025-12-01T00:00:00Z'))).toBeNull();
  });

  it('rejects OVERLAPPING versions for a name, allows ADJACENT', async () => {
    const name = `${PREFIX}overlap`;
    await mkTariff(name, { startDate: d('2026-01-01T00:00:00Z'), endDate: d('2026-06-01T00:00:00Z') });
    let err;
    try {
      await mkTariff(name, { startDate: d('2026-03-01T00:00:00Z'), endDate: null });
    } catch (e) { err = e; }
    expect(err).toBeDefined();
    const sig = `${err?.name} ${err?.message} ${err?.original?.code} ${err?.parent?.constraint}`.toLowerCase();
    expect(sig).toMatch(/exclusion|tariffs_name_period_excl|23p01/);
    // Adjacent [start,end) is fine (end exclusive).
    await expect(mkTariff(name, { startDate: d('2026-06-01T00:00:00Z'), endDate: null })).resolves.toBeTruthy();
  });

  it('is IMMUTABLE once a costed usage row references it (header guard + CRUD check)', async () => {
    const name = `${PREFIX}frozen`;
    const t = await mkTariff(name, { startDate: d('2026-01-01T00:00:00Z') });
    // Not referenced yet → editable, and isTariffReferenced=false.
    expect(await isTariffReferenced(t)).toBe(false);
    await expect(t.update({ description: 'edit ok before referenced' })).resolves.toBeTruthy();

    // Simulate a costed row whose breakdown names this tariff (what D2 stamps).
    await UsageRecord.create({
      sessionId: `${PREFIX}sess`, technology: 'voice', unit: 'milliseconds', quantity: 60_000,
      finalised: true, costMicros: 5, costStatus: 'matched',
      metadata: { costBreakdown: [{ dim: 'destination', tariff: name, tariffStart: t.startDate.toISOString(), prefix: '447' }] },
    });
    expect(await isTariffReferenced(t)).toBe(true);

    // Header pricing edit now throws (beforeUpdate guard).
    let err;
    try { await t.update({ currency: 'usd' }); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(err.message).toMatch(/immutable once referenced/);
  });
});
