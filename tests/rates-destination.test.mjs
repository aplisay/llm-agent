import {
  setupRealDatabase, teardownRealDatabase,
  UsageRecord, Organisation, User, Agent, Instance, RateCard, Tariff, TariffPrefix, Op, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import { costUsageRow, validateRateLines, resolveRowCost } from '../lib/rates.js';

// Phase-D2: the `destination` dimension in the costing engine — a carried outbound
// leg is charged its exact-dimension cost (audio-path etc.) PLUS a longest-prefix
// tariff match (per-call connect fee + per-minute) on the row's frozen normalised
// destination (metadata.destination, which D3 stamps only on billable legs).

const PREFIX = `rd-test-${randomUUID()}-`;
const START = new Date('2020-01-01T00:00:00Z'); // well in the past → always covers billedAt(now)

describe('destination dimension (D2)', () => {
  let orgId; let userId; let agentId; let instanceId; let tariffId;
  const cardName = `${PREFIX}card`;
  const tariffName = `${PREFIX}tariff`;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    orgId = randomUUID(); userId = randomUUID(); agentId = randomUUID(); instanceId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Dest Org' });
    await User.create({
      id: userId, name: 'Dest User', email: `d-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner', organisationId: orgId,
    });
    await Agent.create(
      { id: agentId, name: 'Dest Agent', modelName: 'livekit:ultravox/ultravox-v0.6', userId, organisationId: orgId },
      { validate: false },
    );
    await Instance.create({ id: instanceId, agentId, type: 'livekit', userId, organisationId: orgId });

    // Tariff: 44 → 1p/min (no connect); 447970 → 5p connect + 8p/min.
    const tariff = await Tariff.create({ name: tariffName, startDate: START });
    tariffId = tariff.id;
    await TariffPrefix.bulkCreate([
      { tariffId, prefix: '44', connectMicros: 0, perMinuteMicros: 100_000 },
      { tariffId, prefix: '447970', connectMicros: 500_000, perMinuteMicros: 800_000 },
    ]);
    // Rate card: bridged audio-path 2p/min + a destination line → the tariff.
    await RateCard.create({
      name: cardName,
      startDate: START,
      detail: {
        lines: [
          { dim: 'audio-path', match: { technology: 'voice', detail: 'telephony:bridged-call', media: 'telephony' }, unit: 'minute', priceMicros: 200_000 },
          { dim: 'destination', tariff: tariffName },
        ],
      },
    });
    await Organisation.update(
      { rateHistory: [{ name: cardName, startDate: START.toISOString() }], balance: 100_000_000 },
      { where: { id: orgId } },
    );
  }, 30000);

  afterEach(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await Organisation.update({ balance: 100_000_000 }, { where: { id: orgId } });
  });

  afterAll(async () => {
    await UsageRecord.destroy({ where: { organisationId: orgId } });
    await RateCard.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await Tariff.destroy({ where: { name: { [Op.like]: `${PREFIX}%` } } });
    await Organisation.destroy({ where: { id: orgId } });
    await teardownRealDatabase();
  }, 30000);

  // A carried bridged telephony leg; quantity in ms (default 2 minutes).
  const mkBridgedRow = (over = {}) => UsageRecord.create({
    sessionId: randomUUID(), meterKey: randomUUID(), organisationId: orgId, userId,
    technology: 'voice', provider: 'livekit', detail: 'telephony:bridged-call',
    unit: 'milliseconds', media: 'telephony', quantity: 120_000, finalised: true, ...over,
  });

  it('validateRateLines requires a tariff on a destination line (no inline price)', () => {
    expect(validateRateLines({ lines: [{ dim: 'destination' }] })).toMatch(/tariff name/);
    expect(validateRateLines({ lines: [{ dim: 'destination', tariff: 'uk' }] })).toBeNull();
  });

  it('resolveRowCost ignores the destination dim (priced async, not here)', () => {
    const card = { detail: { lines: [{ dim: 'destination', tariff: tariffName }] } };
    const r = resolveRowCost({ technology: 'voice', quantity: 60_000, unit: 'milliseconds' }, card);
    expect(r.status).toBe('no_line');
    expect(r.costMicros).toBeNull();
  });

  it('charges audio-path + destination (connect + per-minute) additively', async () => {
    // 2-min leg to 447970…: audio-path 2p×2 = 400_000; destination 5p connect + 8p×2 = 2_100_000.
    const row = await mkBridgedRow({ metadata: { destinationRaw: '447970123456' } });
    await costUsageRow(row);
    await row.reload();
    expect(row.costStatus).toBe('matched');
    const dest = row.metadata.costBreakdown.find((b) => b.dim === 'destination');
    expect(dest).toMatchObject({ tariff: tariffName, prefix: '447970', connectMicros: 500_000, perMinuteMicros: 800_000 });
    expect(dest.minutes).toBe(2);
    expect(Number(dest.costMicros)).toBe(2_100_000);
    expect(dest.tariffStart).toBe(START.toISOString());
    expect(Number(row.costMicros)).toBe(400_000 + 2_100_000);
    expect(Number((await Organisation.findByPk(orgId)).balance)).toBe(100_000_000 - 2_500_000);
  });

  it('applies longest-prefix (44 vs 447970) and charges connect only once', async () => {
    const row = await mkBridgedRow({ quantity: 60_000, metadata: { destinationRaw: '4415397761' } }); // 1 min, matches '44'
    await costUsageRow(row);
    await row.reload();
    const dest = row.metadata.costBreakdown.find((b) => b.dim === 'destination');
    expect(dest.prefix).toBe('44');
    expect(Number(dest.costMicros)).toBe(100_000); // 0 connect + 1p×1
    expect(Number(row.costMicros)).toBe(200_000 + 100_000);
  });

  it('normalises a LOCAL dialled number with the tariff default country before matching', async () => {
    // Raw '07970…' (GB local) → the resolver normalises via the tariff's defaultCountry
    // (GB → 447970…) then longest-prefix matches the 447970 deck entry.
    const row = await mkBridgedRow({ quantity: 60_000, metadata: { destinationRaw: '07970123456' } });
    await costUsageRow(row);
    await row.reload();
    const dest = row.metadata.costBreakdown.find((b) => b.dim === 'destination');
    expect(dest.number).toBe('447970123456');
    expect(dest.prefix).toBe('447970');
    expect(Number(dest.costMicros)).toBe(500_000 + 800_000); // connect + 8p×1
  });

  it('does NOT destination-charge a row with no destination (non-billable leg)', async () => {
    const row = await mkBridgedRow({}); // no metadata.destination
    await costUsageRow(row);
    await row.reload();
    expect(Number(row.costMicros)).toBe(400_000); // audio-path only
    expect(row.metadata.costBreakdown.some((b) => b.dim === 'destination')).toBe(false);
  });

  it('does NOT destination-charge when no tariff prefix matches', async () => {
    const row = await mkBridgedRow({ quantity: 60_000, metadata: { destinationRaw: '33123456' } });
    await costUsageRow(row);
    await row.reload();
    expect(Number(row.costMicros)).toBe(200_000); // audio-path only
    expect(row.metadata.costBreakdown.some((b) => b.dim === 'destination')).toBe(false);
  });
});
