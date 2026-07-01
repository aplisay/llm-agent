import {
  setupRealDatabase, teardownRealDatabase,
  Tariff, TariffPrefix, UsageRecord, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import {
  normaliseDestination, callingCodeFor, longestPrefixMatch, computeDestinationCost,
  isPeak, roundUpSeconds, validateSchedule,
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

  it('rounds duration UP to the next 6-second increment', () => {
    expect(roundUpSeconds(0, 6)).toBe(0);
    expect(roundUpSeconds(1, 6)).toBe(6);
    expect(roundUpSeconds(6, 6)).toBe(6);
    expect(roundUpSeconds(7, 6)).toBe(12);
    expect(roundUpSeconds(61, 6)).toBe(66);
  });

  it('isPeak evaluates the schedule in the tariff timezone (peak = window, off-peak = complement)', () => {
    // Magrathea: peak 08:00–18:00 Mon–Fri Europe/London. 2026-01-05 is a Monday (GMT).
    const sched = {
      mon: { start: '08:00', end: '18:00' }, tue: { start: '08:00', end: '18:00' },
      wed: { start: '08:00', end: '18:00' }, thu: { start: '08:00', end: '18:00' },
      fri: { start: '08:00', end: '18:00' }, sat: null, sun: null,
    };
    expect(isPeak(new Date('2026-01-05T10:00:00Z'), 'Europe/London', sched)).toBe(true);   // Mon 10:00 GMT
    expect(isPeak(new Date('2026-01-05T07:59:00Z'), 'Europe/London', sched)).toBe(false);  // before 08:00
    expect(isPeak(new Date('2026-01-05T18:30:00Z'), 'Europe/London', sched)).toBe(false);  // after 18:00
    expect(isPeak(new Date('2026-01-10T10:00:00Z'), 'Europe/London', sched)).toBe(false);  // Saturday
    // DST: 2026-07-06 Mon 09:00 local = 08:00 UTC (BST) — must be peak via the timezone.
    expect(isPeak(new Date('2026-07-06T08:00:00Z'), 'Europe/London', sched)).toBe(true);
  });

  it('computeDestinationCost = callStart + connect + perMinute(peak?) × roundUp(duration)', () => {
    const tariff = {
      timezone: 'Europe/London', callStartMicros: 1_000, roundingSeconds: 6,
      schedule: { mon: { start: '08:00', end: '18:00' } },
    };
    const prefix = { connectMicros: 50_000, peakPerMinuteMicros: 120_000, offPeakPerMinuteMicros: 60_000 };
    // Mon 10:00 GMT → peak; 61s → rounds to 66s = 1.1 min → 1_000 + 50_000 + 120_000×1.1 = 183_000.
    const peak = computeDestinationCost(tariff, prefix, { billedAt: new Date('2026-01-05T10:00:00Z'), durationMs: 61_000 });
    expect(peak.peak).toBe(true);
    expect(peak.billedSeconds).toBe(66);
    expect(peak.costMicros).toBe(1_000 + 50_000 + 132_000);
    // Saturday → off-peak; 30s → rounds to 30s = 0.5 min → 1_000 + 50_000 + 60_000×0.5 = 81_000.
    const off = computeDestinationCost(tariff, prefix, { billedAt: new Date('2026-01-10T10:00:00Z'), durationMs: 30_000 });
    expect(off.peak).toBe(false);
    expect(off.costMicros).toBe(1_000 + 50_000 + 30_000);
  });

  it('applies the minimum carrier charge as a floor on connect + duration', () => {
    const tariff = { timezone: 'Europe/London', callStartMicros: 1_000, roundingSeconds: 6, schedule: {} };
    const prefix = { connectMicros: 0, peakPerMinuteMicros: 120_000, offPeakPerMinuteMicros: 60_000, minimumMicros: 20_000 };
    // 6s off-peak (no schedule) → 0.1 min → 60_000×0.1 = 6_000 < 20_000 minimum → carrier 20_000; + callStart.
    const tiny = computeDestinationCost(tariff, prefix, { billedAt: new Date('2026-01-10T10:00:00Z'), durationMs: 6_000 });
    expect(tiny.minimumMicros).toBe(20_000);
    expect(tiny.costMicros).toBe(1_000 + 20_000);
    // A long call clears the minimum → priced on connect + per-minute.
    const long = computeDestinationCost(tariff, prefix, { billedAt: new Date('2026-01-10T10:00:00Z'), durationMs: 120_000 });
    expect(long.costMicros).toBe(1_000 + 120_000); // 2 min × 60_000 = 120_000 > minimum
  });

  it('validates prefix decks, schedule and tariff input', () => {
    const good = { connectMicros: 0, peakPerMinuteMicros: 20000, offPeakPerMinuteMicros: 10000, minimumMicros: 1000 };
    expect(validatePrefixes([{ prefix: '447', ...good }])).toBeNull();
    expect(validatePrefixes([{ prefix: '44a', ...good }])).toMatch(/1-15 digits/);
    expect(validatePrefixes([{ prefix: '44', ...good }, { prefix: '44', ...good }])).toMatch(/duplicate/);
    expect(validatePrefixes([{ prefix: '44', ...good, offPeakPerMinuteMicros: -1 }])).toMatch(/offPeakPerMinuteMicros/);
    expect(validateSchedule({ mon: { start: '08:00', end: '18:00' }, sat: null })).toBeNull();
    expect(validateSchedule({ funday: { start: '08:00', end: '18:00' } })).toMatch(/unknown weekday/);
    expect(validateSchedule({ mon: { start: '18:00', end: '08:00' } })).toMatch(/start must be <= end/);
    expect(validateTariffInput({ name: '', startDate: '2026-01-01' })).toMatch(/name/);
    expect(validateTariffInput({ name: 'x', startDate: '2026-01-01', timezone: 'Mars/Olympus' })).toMatch(/not a valid IANA/);
    expect(validateTariffInput({ name: 'x', startDate: '2026-01-01', callStartMicros: -1 })).toMatch(/callStartMicros/);
    expect(validateTariffInput({ name: 'x', startDate: '2026-01-01', timezone: 'Europe/London', schedule: {}, prefixes: [] })).toBeNull();
  });
});

describe('Tariff model (schema v51)', () => {
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
      { tariffId: t.id, prefix: '44', connectMicros: 0, peakPerMinuteMicros: 10_000, offPeakPerMinuteMicros: 5_000 },
      { tariffId: t.id, prefix: '447', connectMicros: 0, peakPerMinuteMicros: 20_000, offPeakPerMinuteMicros: 10_000 },
      { tariffId: t.id, prefix: '447970', connectMicros: 50_000, peakPerMinuteMicros: 80_000, offPeakPerMinuteMicros: 40_000 },
    ]);
    const m1 = await matchTariffPrefix(t.id, '4471234577');
    expect(m1.prefix).toBe('447');
    expect(Number(m1.peakPerMinuteMicros)).toBe(20_000);
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

  it('ALLOWS overlapping / open-ended same-name versions; resolveTariff disambiguates by latest start', async () => {
    const name = `${PREFIX}overlap`;
    // Two open-ended versions of the same name — no period constraint rejects this.
    await mkTariff(name, { startDate: d('2026-01-01T00:00:00Z'), endDate: null });
    await expect(mkTariff(name, { startDate: d('2026-03-01T00:00:00Z'), endDate: null })).resolves.toBeTruthy();
    // The greatest start_date <= billedAt wins: 1/1 covers Feb, 3/1 supersedes from March.
    expect((await resolveTariff(name, d('2026-02-01T00:00:00Z'))).startDate.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect((await resolveTariff(name, d('2026-04-01T00:00:00Z'))).startDate.toISOString()).toBe('2026-03-01T00:00:00.000Z');
    // A duplicate start_date is still rejected (unique index).
    let err;
    try { await mkTariff(name, { startDate: d('2026-03-01T00:00:00Z'), endDate: null }); } catch (e) { err = e; }
    expect(err).toBeDefined();
    expect(`${err?.name}`.toLowerCase()).toMatch(/unique/);
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
