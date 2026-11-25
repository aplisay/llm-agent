/**
 * Billing for the phone system, against the test database: the monthly charge
 * for each extension, the usage every phone system call writes, the rules for
 * an empty balance, the charge in a directory write's effect, who sees the
 * usage rows, and that none of it acts before the schema step is ready.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';
import {
  setupRealDatabase, teardownRealDatabase, databaseStarted,
  Organisation, Trunk, RateCard, Tariff, TariffPrefix, UsageRecord, PhoneNumber, Metadata,
} from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const START = new Date('2020-01-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
// November, so London is on UTC.
const NOV_20 = new Date('2026-11-20T12:00:00Z');
const RUNNER = fileURLToPath(new URL('./setup/run-extension-charges.mjs', import.meta.url));

describe('billing for the phone system', () => {
  const stamp = `${Date.now()}`.slice(-6);
  const BRAND = `xc-${stamp}`;
  const card = `xc-card-${stamp}`;
  const bareCard = `xc-bare-${stamp}`;
  const summerCard = `xc-summer-${stamp}`;
  const tariffName = `xc-tariff-${stamp}`;
  const PLATFORM = `xc-platform-${stamp}`;
  const REGISTRATION = `xc-reg-${stamp}`;
  const CARRIER = `xc-carrier-${stamp}`;
  const orgs = {};
  let db;
  let charge;
  let oa;
  let records;
  let directory;
  let schema;

  const balanceOf = async (id) => Number((await Organisation.findByPk(id, { attributes: ['balance'] })).balance);
  const chargeRows = (organisationId) => UsageRecord.findAll({ where: { organisationId, technology: 'extension' }, order: [['quantity', 'ASC']] });
  const orgRow = (id) => Organisation.findByPk(id);
  const setStart = (at) => Metadata.upsert({ key: schema.EXTENSION_CHARGE_STARTED_KEY, value: at ? at.toISOString() : null });

  /** An entry with an extension, created at `createdAt`. */
  const extension = async (organisationId, number, { type = 'ring_all', createdAt = new Date(), deletedAt = null } = {}) => {
    const entry = await db.DirectoryEntry.create({ organisationId, kind: 'team', name: `Team ${number}` });
    const row = await db.Extension.create({ organisationId, number, type, entryId: entry.id, deletedAt });
    await db.Extension.sequelize.query('UPDATE extensions SET created_at = :createdAt WHERE id = :id', { replacements: { createdAt, id: row.id } });
    return db.Extension.findByPk(row.id);
  };
  const clean = async (organisationId) => {
    await db.BalanceCredit.destroy({ where: { organisationId } });
    await UsageRecord.destroy({ where: { organisationId } });
    await db.Call.destroy({ where: { organisationId } });
    await db.OutboundEvent.destroy({ where: { organisationId } });
    await PhoneNumber.destroy({ where: { organisationId } });
    await db.Extension.destroy({ where: { organisationId } });
    await db.DirectoryEntry.destroy({ where: { organisationId } });
  };

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    db = await import('../lib/database.js');
    charge = await import('../lib/extension-charge.js');
    oa = await import('../lib/outbound-authorisation.js');
    records = await import('../lib/pbx/call-records.js');
    directory = await import('../lib/pbx/directory.js');
    schema = await import('../lib/schema-guards.js');
    await setStart(START);

    await db.Brand.create({ id: BRAND, defaultCapabilities: ['phoneSystem'] });
    const tariff = await Tariff.create({ name: tariffName, startDate: START });
    await TariffPrefix.bulkCreate(['4420', '447'].map((prefix) => ({
      tariffId: tariff.id, prefix, connectMicros: 0, peakPerMinuteMicros: 100_000, offPeakPerMinuteMicros: 100_000,
    })));
    await RateCard.create({
      name: card,
      startDate: START,
      currency: 'gbp',
      detail: {
        lines: [
          // Agent lines that name no technology. They must not price a phone system row.
          { dim: 'audio-path', match: { media: 'telephony' }, unit: 'minute', priceMicros: 60_000 },
          { dim: 'stt', match: { provider: 'deepgram' }, unit: 'minute', priceMicros: 99_000 },
          { dim: 'destination', tariff: tariffName },
          { dim: 'extension', match: { technology: 'extension' }, unit: 'month', priceMicros: 4_000_000 },
          { dim: 'recording', match: { technology: 'recording' }, unit: 'minute', priceMicros: 10_000 },
          { dim: 'transcription', match: { technology: 'transcription' }, unit: 'minute', priceMicros: 20_000 },
        ],
      },
    });
    await RateCard.create({ name: bareCard, startDate: START, currency: 'gbp', detail: { lines: [{ dim: 'destination', tariff: tariffName }] } });
    const extensionLine = (priceMicros) => ({ lines: [{ dim: 'extension', match: { technology: 'extension' }, unit: 'month', priceMicros }] });
    await RateCard.create({ name: summerCard, startDate: START, currency: 'gbp', detail: extensionLine(4_000_000) });
    await RateCard.create({ name: summerCard, startDate: new Date('2026-10-01T00:00:00Z'), currency: 'gbp', detail: extensionLine(5_000_000) });
    const make = async (key, fields) => {
      orgs[key] = `xc-${key}-${stamp}`;
      await Organisation.create({ id: orgs[key], name: key, rateHistory: [{ name: card, startDate: START }], ...fields });
    };
    await make('phone', { capabilities: ['phoneSystem'], balance: 10_000_000, brand: BRAND });
    await make('plain', { capabilities: [], balance: 10_000_000 });
    await make('bare', { capabilities: ['phoneSystem'], balance: 10_000_000, rateHistory: [{ name: bareCard, startDate: START }] });
    await make('owing', { capabilities: ['phoneSystem'], balance: 1_000_000 });
    await make('unrated', { capabilities: ['phoneSystem'], balance: 10_000_000, rateHistory: null });
    await make('summer', { capabilities: ['phoneSystem'], balance: 100_000_000, rateHistory: [{ name: summerCard, startDate: START }] });
    await make('fresh', {
      capabilities: ['phoneSystem'], balance: 10_000_000, rateHistory: [{ name: card, startDate: new Date('2026-11-20T14:00:00Z') }],
    });
    // Filters wide enough that the policy and the balance decide.
    await Trunk.create({ id: PLATFORM, name: 'Platform, not flagged', outbound: true, chargeable: false, outboundCallFilter: '^\\+\\d{8,15}$' });
    await Trunk.create({
      id: REGISTRATION, name: 'Customer', outbound: true, chargeable: false, flags: { provider: 'registration', registrationId: randomUUID() },
    });
    await Trunk.create({ id: CARRIER, name: 'Carrier', outbound: true, chargeable: true, outboundCallFilter: '^\\+\\d{8,15}$' });
  }, 60000);

  afterAll(async () => {
    for (const id of Object.values(orgs)) await clean(id);
    await Trunk.destroy({ where: { id: [PLATFORM, REGISTRATION, CARRIER] } });
    await RateCard.destroy({ where: { name: [card, bareCard, summerCard] } });
    await Tariff.destroy({ where: { name: tariffName } });
    await Organisation.destroy({ where: { id: Object.values(orgs) } });
    await db.Brand.destroy({ where: { id: BRAND } });
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    for (const id of Object.values(orgs)) await clean(id);
    await Organisation.update({ balance: 10_000_000, chargeUnpaidSince: null, outboundPolicy: null, status: 'active' }, {
      where: { id: [orgs.phone, orgs.plain, orgs.bare, orgs.unrated, orgs.fresh] },
    });
    await Organisation.update({ balance: 1_000_000, chargeUnpaidSince: null }, { where: { id: orgs.owing } });
    await setStart(START);
  });

  describe('the period charged', () => {
    test('an extension created this month is charged from that day, by the day, billed at noon UTC', () => {
      expect(charge.chargePeriod({ createdAt: new Date('2026-11-11T09:00:00Z'), now: NOV_20 })).toMatchObject({
        month: '2026-11', from: '2026-11-11', to: '2026-11-30', days: 20, daysInMonth: 30, billedAt: new Date('2026-11-11T12:00:00Z'),
      });
    });

    test('an extension made after noon is billed at the moment it was made', () => {
      expect(charge.chargePeriod({ createdAt: new Date('2026-11-11T14:05:00Z'), now: NOV_20 }).billedAt)
        .toEqual(new Date('2026-11-11T14:05:00Z'));
    });

    test('an extension from an earlier month is charged the whole month', () => {
      expect(charge.chargePeriod({ createdAt: new Date('2026-10-01T00:00:00Z'), now: NOV_20 })).toMatchObject({
        from: '2026-11-01', days: 30, billedAt: new Date('2026-11-01T12:00:00Z'),
      });
    });

    test('days and months are UK days and months, and the billing instant is inside the UK day in summer', () => {
      // 00:30 on 11 June, summer time.
      expect(charge.chargePeriod({ createdAt: new Date('2026-06-10T23:30:00Z'), now: new Date('2026-06-12T09:00:00Z') })).toMatchObject({
        from: '2026-06-11', days: 20, daysInMonth: 30, billedAt: new Date('2026-06-11T12:00:00Z'),
      });
      // The first of October in summer time starts at 23:00 UTC on 30 September; the charge is billed on 1 October.
      expect(charge.chargePeriod({ createdAt: new Date('2026-08-01T00:00:00Z'), now: new Date('2026-09-30T23:30:00Z') })).toMatchObject({
        month: '2026-10', from: '2026-10-01', billedAt: new Date('2026-10-01T12:00:00Z'),
      });
      expect(charge.chargePeriod({ createdAt: new Date('2028-02-15T12:00:00Z'), now: new Date('2028-02-20T12:00:00Z') }))
        .toMatchObject({ days: 15, daysInMonth: 29 });
    });

    test('no day before charging started is charged', () => {
      const old = new Date('2026-10-01T00:00:00Z');
      expect(charge.chargePeriod({ createdAt: old, now: NOV_20, startedAt: new Date('2026-11-15T10:00:00Z') })).toMatchObject({
        from: '2026-11-15', days: 16, billedAt: new Date('2026-11-15T12:00:00Z'),
      });
      expect(charge.chargePeriod({ createdAt: old, now: NOV_20, startedAt: new Date('2026-11-15T15:00:00Z') }).billedAt)
        .toEqual(new Date('2026-11-15T15:00:00Z'));
      expect(charge.chargePeriod({ createdAt: old, now: NOV_20, startedAt: new Date('2026-11-21T00:00:00Z') })).toBeNull();
      expect(charge.chargePeriod({ createdAt: old, now: NOV_20, startedAt: new Date('2026-09-15T00:00:00Z') })).toMatchObject({ from: '2026-11-01' });
    });

    test('an extension created after now is not charged', () => {
      expect(charge.chargePeriod({ createdAt: new Date('2026-11-21T00:00:00Z'), now: NOV_20 })).toBeNull();
    });
  });

  describe('the monthly charge', () => {
    test('the job run twice, and three times at once, charges each extension once', async () => {
      await extension(orgs.phone, '201', { createdAt: new Date('2026-11-11T09:00:00Z') });
      await extension(orgs.phone, '202', { createdAt: new Date('2026-10-01T09:00:00Z') });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: NOV_20, log });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: NOV_20, log });
      await Promise.all([1, 2, 3].map(async () => charge.chargeOrganisation(await orgRow(orgs.phone), { now: NOV_20, log })));
      await charge.runExtensionCharges({ now: NOV_20, log });
      const rows = await chargeRows(orgs.phone);
      expect(rows.map((r) => [Number(r.quantity), Number(r.costMicros), r.costStatus])).toEqual([
        [20, 2_666_667, 'matched'],
        [30, 4_000_000, 'matched'],
      ]);
      expect(await balanceOf(orgs.phone)).toBe(10_000_000 - 6_666_667);
    });

    test('three API processes charging at the same moment charge each extension once', async () => {
      for (let n = 0; n < 12; n += 1) await extension(orgs.phone, String(300 + n), { createdAt: new Date('2026-10-01T09:00:00Z') });
      const runAt = Date.now() + 4000;
      const runs = await Promise.all([1, 2, 3].map(() => new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [RUNNER], {
          env: { ...process.env, RUN_AT: String(runAt), CHARGE_NOW: NOV_20.toISOString(), DB_FORCE_SYNC: 'false', NODE_ENV: 'test', LOGLEVEL: 'fatal' },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('error', reject);
        child.on('exit', (code) => (code === 0 ? resolve(JSON.parse(out.trim().split('\n').pop())) : reject(new Error(`exit ${code}`))));
      })));
      expect(runs.reduce((sum, run) => sum + run.charged, 0)).toBe(12);
      const rows = await chargeRows(orgs.phone);
      expect(rows).toHaveLength(12);
      expect(new Set(rows.map((r) => r.sessionId)).size).toBe(12);
      expect(await balanceOf(orgs.phone)).toBe(10_000_000 - 12 * 4_000_000);
    }, 60000);

    test('a row an earlier run left without a cost is costed by the next run, once, also by three runs at once', async () => {
      const ext = await extension(orgs.phone, '203', { createdAt: new Date('2026-10-01T09:00:00Z') });
      const period = charge.chargePeriod({ createdAt: ext.createdAt, now: NOV_20, startedAt: START });
      await UsageRecord.create({
        sessionId: charge.chargeSessionId(ext.id, '2026-11'), meterKey: charge.EXTENSION_CHARGE_METER_KEY, organisationId: orgs.phone,
        ...charge.EXTENSION_CHARGE, detail: 'ring_all', quantity: 30, finalised: true, billedAt: period.billedAt,
        metadata: { extensionId: ext.id, month: '2026-11', daysInMonth: 30 },
      });
      await Promise.all([1, 2, 3].map(async () => charge.chargeOrganisation(await orgRow(orgs.phone), { now: NOV_20, log })));
      const [row] = await chargeRows(orgs.phone);
      expect(Number(row.costMicros)).toBe(4_000_000);
      expect(await balanceOf(orgs.phone)).toBe(6_000_000);
    });

    test('a part month is the days over the length of the month', async () => {
      await extension(orgs.phone, '204', { createdAt: new Date('2026-11-28T15:00:00Z') });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: new Date('2026-11-28T16:00:00Z'), log });
      const [row] = await chargeRows(orgs.phone);
      expect(Number(row.quantity)).toBe(3);
      expect(Number(row.costMicros)).toBe(400_000);
      expect(row.metadata).toMatchObject({ month: '2026-11', from: '2026-11-28', to: '2026-11-30', daysInMonth: 30 });
    });

    test('the next month is charged in full', async () => {
      await extension(orgs.phone, '205', { createdAt: new Date('2026-11-11T09:00:00Z') });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: NOV_20, log });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: new Date('2026-12-01T00:30:00Z'), log });
      const rows = await chargeRows(orgs.phone);
      expect(rows.map((r) => [r.metadata.month, Number(r.quantity), Number(r.costMicros)])).toEqual(expect.arrayContaining([
        ['2026-11', 20, 2_666_667],
        ['2026-12', 31, 4_000_000],
      ]));
    });

    test('charging starts on the day the upgrade recorded, and not before', async () => {
      await extension(orgs.phone, '206', { createdAt: new Date('2026-10-01T09:00:00Z') });
      await setStart(new Date('2026-11-15T10:00:00Z'));
      await charge.runExtensionCharges({ now: NOV_20, log });
      const [row] = await chargeRows(orgs.phone);
      expect(row.metadata).toMatchObject({ from: '2026-11-15' });
      expect(Number(row.quantity)).toBe(16);
    });

    test('with no start recorded, nothing is charged', async () => {
      await extension(orgs.phone, '207', { createdAt: new Date('2026-10-01T09:00:00Z') });
      await setStart(null);
      const warn = jest.fn();
      await charge.runExtensionCharges({ now: NOV_20, log: { ...log, warn } });
      expect(await chargeRows(orgs.phone)).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/upgrade-db/));
    });

    test('a connection extension is free, and a removed one is not charged', async () => {
      await extension(orgs.phone, '310', { type: 'connection', createdAt: new Date('2026-10-01T00:00:00Z') });
      await extension(orgs.phone, '208', { createdAt: new Date('2026-10-01T00:00:00Z'), deletedAt: new Date('2026-11-02T00:00:00Z') });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: NOV_20, log });
      expect(await chargeRows(orgs.phone)).toHaveLength(0);
      expect(await balanceOf(orgs.phone)).toBe(10_000_000);
    });

    test('an organisation without the phone system is not charged', async () => {
      await extension(orgs.plain, '209', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await charge.runExtensionCharges({ now: NOV_20, log });
      expect(await chargeRows(orgs.plain)).toHaveLength(0);
    });

    test('a deactivated organisation is not charged, and keeps a month charged before it was deactivated', async () => {
      await extension(orgs.phone, '214', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await Organisation.update({ status: 'deactivated' }, { where: { id: orgs.phone } });
      await charge.runExtensionCharges({ now: NOV_20, log });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: NOV_20, log });
      expect(await chargeRows(orgs.phone)).toHaveLength(0);
      expect(await balanceOf(orgs.phone)).toBe(10_000_000);

      await Organisation.update({ status: 'active' }, { where: { id: orgs.phone } });
      await charge.runExtensionCharges({ now: NOV_20, log });
      await Organisation.update({ status: 'deactivated' }, { where: { id: orgs.phone } });
      await charge.runExtensionCharges({ now: new Date('2026-11-25T12:00:00Z'), log });
      await charge.runExtensionCharges({ now: new Date('2026-12-01T12:00:00Z'), log });
      const rows = await chargeRows(orgs.phone);
      expect(rows.map((r) => [r.metadata.month, Number(r.costMicros)])).toEqual([['2026-11', 4_000_000]]);
      expect(await balanceOf(orgs.phone)).toBe(6_000_000);
    });

    test('a suspended organisation is charged', async () => {
      await extension(orgs.phone, '215', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await Organisation.update({ status: 'suspended' }, { where: { id: orgs.phone } });
      await charge.runExtensionCharges({ now: NOV_20, log });
      const [row] = await chargeRows(orgs.phone);
      expect(row).toMatchObject({ costStatus: 'matched' });
      expect(Number(row.costMicros)).toBe(4_000_000);
      expect(await balanceOf(orgs.phone)).toBe(6_000_000);
    });

    test('a charge the card cannot price is closed at nothing, and a later card does not price it', async () => {
      await extension(orgs.bare, '210', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await extension(orgs.unrated, '211', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await charge.runExtensionCharges({ now: NOV_20, log });
      const [noLine] = await chargeRows(orgs.bare);
      const [noRate] = await chargeRows(orgs.unrated);
      expect(noLine).toMatchObject({ costStatus: 'unpriced', metadata: expect.objectContaining({ unpricedBecause: 'no_line' }) });
      expect(noRate).toMatchObject({ costStatus: 'unpriced', metadata: expect.objectContaining({ unpricedBecause: 'no_rate' }) });
      expect(Number(noLine.costMicros)).toBe(0);
      expect(Number(noRate.costMicros)).toBe(0);
      // A card version with an extension line, back-dated over November.
      const later = await RateCard.create({
        name: bareCard, startDate: new Date('2026-11-01T00:00:00Z'), currency: 'gbp',
        detail: { lines: [{ dim: 'extension', match: { technology: 'extension' }, unit: 'month', priceMicros: 4_000_000 }] },
      });
      const { sweepUncostedRows } = await import('../lib/rates.js');
      await sweepUncostedRows({ log });
      await charge.runExtensionCharges({ now: NOV_20, log });
      await noLine.reload();
      expect(noLine.costStatus).toBe('unpriced');
      expect(await balanceOf(orgs.bare)).toBe(10_000_000);
      await later.destroy();
    });

    test('a first part month on the day the organisation\'s rate starts is priced', async () => {
      await extension(orgs.fresh, '212', { createdAt: new Date('2026-11-20T14:05:00Z') });
      await charge.chargeOrganisation(await orgRow(orgs.fresh), { now: new Date('2026-11-20T15:00:00Z'), log });
      const [row] = await chargeRows(orgs.fresh);
      expect(row).toMatchObject({ costStatus: 'matched', billedAt: new Date('2026-11-20T14:05:00Z') });
      expect(Number(row.costMicros)).toBe(Math.round(4_000_000 * (11 / 30)));
    });

    test('a price dated the first of a summer month applies to that month, and shows in that month', async () => {
      await extension(orgs.summer, '213', { createdAt: new Date('2026-08-01T00:00:00Z') });
      await charge.chargeOrganisation(await orgRow(orgs.summer), { now: new Date('2026-10-02T09:00:00Z'), log });
      const [row] = await chargeRows(orgs.summer);
      expect(row.metadata.month).toBe('2026-10');
      expect(Number(row.costMicros)).toBe(5_000_000);
      const usage = (await import('../api/paths/usage.js')).default(log).GET;
      const res = {
        locals: { user: { id: `xc-op-${stamp}`, organisationId: null, role: 'superAdmin' } },
        send(body) { this.body = body; return this; },
        status() { return this; },
      };
      await usage({ query: { groupBy: 'technology', period: 'month', technology: 'extension' }, log }, res);
      const october = res.body.usage.find((r) => Number(r.costMicros) >= 5_000_000 && new Date(r.period).toISOString().startsWith('2026-10'));
      expect(october).toBeTruthy();
    });

    test('the price shown before an extension is added is what the job charges', async () => {
      const at = new Date('2026-11-11T09:00:00Z');
      await expect(charge.extensionPrice({ organisationId: orgs.phone, type: 'ring_all', at })).resolves.toEqual({
        amountMicros: 4_000_000, firstPeriodMicros: 2_666_667, currency: 'gbp', startsOn: '2026-11-11', priced: true,
      });
      await expect(charge.extensionPrice({ organisationId: orgs.phone, type: 'connection', at }))
        .resolves.toMatchObject({ amountMicros: 0, firstPeriodMicros: 0, priced: false });
      await expect(charge.extensionPrice({ organisationId: orgs.bare, type: 'ring_all', at }))
        .resolves.toMatchObject({ amountMicros: 0, firstPeriodMicros: 0, priced: false });
    });
  });

  describe('an empty balance', () => {
    const pbxLeg = (organisationId, calledId = '+442079460123', aplisayId = CARRIER) => oa.authoriseOutboundDestination(
      { calledId, organisationId, aplisayId }, { env: {}, log },
    );

    test('stops outside calls of the phone system, and of its agents', async () => {
      await Organisation.update({ balance: 0 }, { where: { id: orgs.phone } });
      await expect(pbxLeg(orgs.phone)).resolves.toMatchObject({ allowed: false, code: 'balance_empty', chargeable: true });
      const agentLeg = await oa.authoriseOutboundDestination(
        { calledId: '+442079460123', organisationId: orgs.phone, outboundTrunkId: CARRIER }, { env: {}, log },
      );
      expect(agentLeg).toMatchObject({ allowed: false, code: 'balance_empty' });
      await Organisation.update({ balance: -1 }, { where: { id: orgs.phone } });
      await expect(pbxLeg(orgs.phone)).resolves.toMatchObject({ allowed: false, code: 'balance_empty' });
    });

    test('a balance above zero, or one not tracked, lets them through', async () => {
      await Organisation.update({ balance: 1 }, { where: { id: orgs.phone } });
      await expect(pbxLeg(orgs.phone)).resolves.toMatchObject({ allowed: true });
      await Organisation.update({ balance: null }, { where: { id: orgs.phone } });
      await expect(pbxLeg(orgs.phone)).resolves.toMatchObject({ allowed: true });
    });

    test('a charge that draws money and leaves the balance below zero marks the organisation', async () => {
      await extension(orgs.owing, '214', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await extension(orgs.phone, '215', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await charge.runExtensionCharges({ now: NOV_20, log });
      expect(await balanceOf(orgs.owing)).toBe(-3_000_000);
      expect((await orgRow(orgs.owing)).chargeUnpaidSince).toEqual(NOV_20);
      expect((await orgRow(orgs.phone)).chargeUnpaidSince).toBeNull();
      // A later run keeps the first time.
      await charge.runExtensionCharges({ now: new Date('2026-11-21T12:00:00Z'), log });
      expect((await orgRow(orgs.owing)).chargeUnpaidSince).toEqual(NOV_20);
    });

    test('a charge that draws nothing does not mark an organisation whose balance is below zero from calls', async () => {
      await Organisation.update({ balance: -500 }, { where: { id: orgs.bare } });
      await extension(orgs.bare, '216', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await charge.runExtensionCharges({ now: NOV_20, log });
      const [row] = await chargeRows(orgs.bare);
      expect(row.costStatus).toBe('unpriced');
      expect(await balanceOf(orgs.bare)).toBe(-500);
      expect((await orgRow(orgs.bare)).chargeUnpaidSince).toBeNull();
    });

    test('after 30 days unpaid the phones stop taking calls, and a top-up starts them again', async () => {
      const ext = await extension(orgs.owing, '217', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await Organisation.update({ balance: -500, chargeUnpaidSince: new Date(Date.now() - 31 * DAY) }, { where: { id: orgs.owing } });
      const { loadSnapshot } = await import('../lib/pbx/store.js');
      const { indexSnapshot } = await import('../lib/pbx/snapshot.js');
      const { buildRingPlan } = await import('../lib/pbx/ring-plan.js');
      const plan = async (request) => buildRingPlan(indexSnapshot(await loadSnapshot(orgs.owing)), request);
      await expect(plan({ kind: 'extension', extensionId: ext.id, callerId: '+447700900123' }))
        .resolves.toMatchObject({ action: 'refuse', reason: 'charge_unpaid' });

      const { default: creditRoute } = await import('../api/paths/organisations/{organisationId}/balance/credit.js');
      const res = {
        locals: { user: { id: `xc-op-${stamp}`, organisationId: null, role: 'superAdmin' } },
        status(code) { this.code = code; return this; },
        send(body) { this.body = body; return this; },
      };
      await creditRoute(log).POST({ params: { organisationId: orgs.owing }, body: { idempotencyKey: randomUUID(), amountPennies: 100 }, log }, res);
      expect(res.code).toBeUndefined();
      expect((await orgRow(orgs.owing)).chargeUnpaidSince).toBeNull();
      await expect(plan({ kind: 'extension', extensionId: ext.id, callerId: '+447700900123' }))
        .resolves.not.toMatchObject({ action: 'refuse' });
    });

    test('a top-up that leaves the balance below zero keeps the mark', async () => {
      const since = new Date(Date.now() - 31 * DAY);
      await Organisation.update({ balance: -500_000, chargeUnpaidSince: since }, { where: { id: orgs.owing } });
      await charge.noteChargeBalance(orgs.owing);
      expect((await orgRow(orgs.owing)).chargeUnpaidSince).toEqual(since);
    });
  });

  describe('every phone system call writes usage', () => {
    // Each call and leg starts at T0 and is ended at T0 plus one minute, unless a test says otherwise.
    const T0 = new Date(Date.now() - 5 * 60_000);
    const ONE_MINUTE_LATER = new Date(T0.valueOf() + 60_000).toISOString();
    const pbxCall = async (organisationId, fields = {}) => (await records.upsertCall({
      id: randomUUID(), organisationId, callerId: '201', startedAt: T0, ...fields,
    })).call;
    const leg = (organisationId, parentId, fields) => pbxCall(organisationId, { parentId, ...fields });
    const rowsOf = (callId) => UsageRecord.findAll({ where: { callId }, order: [['technology', 'ASC']] });

    test('a leg out on a flagged trunk carries the destination charge; the rest is written at nothing', async () => {
      const call = await pbxCall(orgs.phone, { calledId: '+442079460123' });
      const inside = await leg(orgs.phone, call.id, { calledId: '202', metadata: { kind: 'line', number: '202' } });
      const out = await leg(orgs.phone, call.id, { calledId: '+442079460123', outboundTrunkId: CARRIER, metadata: { kind: 'external' } });
      const unflagged = await leg(orgs.phone, call.id, { calledId: '+442079460125', outboundTrunkId: PLATFORM, metadata: { kind: 'external' } });
      const own = await leg(orgs.phone, call.id, { calledId: '+442079460124', outboundTrunkId: REGISTRATION, metadata: { kind: 'external' } });
      for (const row of [inside, out, unflagged, own]) await records.endCall(row.id, { endedAt: ONE_MINUTE_LATER, answered: true });
      await records.endCall(call.id, { endedAt: ONE_MINUTE_LATER });

      const [priced] = await rowsOf(out.id);
      expect(priced).toMatchObject({ technology: 'pbx', provider: 'pbx', detail: 'telephony:pbx-leg', costStatus: 'matched' });
      // One minute at 100,000 a minute, and nothing from the agent line that names only the media.
      expect(Number(priced.costMicros)).toBe(100_000);
      expect(priced.metadata.destinationRaw).toBe('+442079460123');
      for (const id of [call.id, inside.id, unflagged.id, own.id]) {
        const [row] = await rowsOf(id);
        expect(row).toMatchObject({ technology: 'pbx', costStatus: 'free', finalised: true });
        expect(Number(row.costMicros)).toBe(0);
      }
      expect(await balanceOf(orgs.phone)).toBe(10_000_000 - 100_000);
      const { outboundSpendSince } = await import('../lib/outbound-spend.js');
      await expect(outboundSpendSince({ organisationId: orgs.phone, since: new Date(Date.now() - DAY) })).resolves.toBe(100_000);
    });

    test('a call that is ended twice writes its usage once', async () => {
      const call = await pbxCall(orgs.phone, { calledId: '+442079460123' });
      const out = await leg(orgs.phone, call.id, { calledId: '+447700900123', outboundTrunkId: CARRIER, metadata: { kind: 'external' } });
      await records.endCall(out.id, { endedAt: ONE_MINUTE_LATER });
      await records.endCall(out.id, { endedAt: ONE_MINUTE_LATER });
      await Promise.all([records.endCall(out.id, { endedAt: ONE_MINUTE_LATER }), records.endCall(out.id, {})]);
      expect(await rowsOf(out.id)).toHaveLength(1);
      expect(await balanceOf(orgs.phone)).toBe(10_000_000 - 100_000);
    });

    test('a call nobody answered is on the usage record too', async () => {
      const call = await pbxCall(orgs.phone, { calledId: '+442079460123', startedAt: new Date() });
      await records.endCall(call.id, { endedAt: new Date().toISOString(), reason: 'no_answer' });
      const [row] = await rowsOf(call.id);
      expect(row).toMatchObject({ technology: 'pbx', costStatus: 'free' });
    });

    test('recording and transcription are charged by their own lines only', async () => {
      const call = await pbxCall(orgs.phone, { calledId: '+442079460123' });
      const out = await leg(orgs.phone, call.id, { calledId: '+442079460123', outboundTrunkId: CARRIER, metadata: { kind: 'external' } });
      await records.endCall(out.id, { endedAt: ONE_MINUTE_LATER, transcribedMs: 30_000 });
      await records.endCall(call.id, { endedAt: ONE_MINUTE_LATER, recordedMs: 30_000 });
      const byTech = Object.fromEntries((await UsageRecord.findAll({ where: { callId: [call.id, out.id] } }))
        .map((row) => [`${row.callId === call.id ? 'call' : 'leg'}:${row.technology}`, Number(row.costMicros)]));
      // Not the 99,000 a minute of the agent line that names only the provider.
      expect(byTech).toEqual({ 'call:pbx': 0, 'call:recording': 5_000, 'leg:pbx': 100_000, 'leg:transcription': 10_000 });
    });

    test('a recording length is held to the call, and a bad one is dropped while the call still ends', async () => {
      const long = await pbxCall(orgs.phone);
      await records.endCall(long.id, { endedAt: ONE_MINUTE_LATER, recordedMs: 24 * 60 * 60 * 1000 });
      const recording = (await rowsOf(long.id)).find((row) => row.technology === 'recording');
      expect(Number(recording.quantity)).toBe(60_000);
      for (const bad of ['abc', -5, 1.5]) {
        const call = await pbxCall(orgs.phone);
        const { call: ended } = await records.endCall(call.id, { endedAt: ONE_MINUTE_LATER, recordedMs: bad });
        expect(ended.live).toBe(false);
        expect((await rowsOf(call.id)).map((row) => row.technology)).toEqual(['pbx']);
      }
    });
  });

  describe('a phone system leg and the chargeable flag', () => {
    const decide = (organisationId, aplisayId) => oa.authoriseOutboundDestination(
      { calledId: '+442079460123', organisationId, aplisayId }, { env: {}, log },
    );

    test('a leg on a flagged trunk passes the trunk filter, the rating and the policy; an unflagged one does not', async () => {
      await expect(decide(orgs.phone, CARRIER)).resolves.toMatchObject({ allowed: true, chargeable: true, trunkId: CARRIER, tariff: tariffName });
      await expect(decide(orgs.phone, PLATFORM)).resolves.toMatchObject({ allowed: true, chargeable: false, trunkId: PLATFORM });
      await expect(decide(orgs.phone, REGISTRATION)).resolves.toMatchObject({ chargeable: false });
    });

    test('the calls in progress limit keeps counting a phone leg once it is answered', async () => {
      await Organisation.update({ outboundPolicy: { callsInProgress: 1 } }, { where: { id: orgs.phone } });
      await expect(decide(orgs.phone, CARRIER)).resolves.toMatchObject({ allowed: true });
      // Answered: call control writes the leg's row on the trunk the decision named.
      const call = (await records.upsertCall({ id: randomUUID(), organisationId: orgs.phone, callerId: '201' })).call;
      const answered = (await records.upsertCall({
        id: randomUUID(), organisationId: orgs.phone, parentId: call.id, calledId: '+442079460123', outboundTrunkId: CARRIER, metadata: { kind: 'external' },
      })).call;
      await expect(decide(orgs.phone, CARRIER)).resolves.toMatchObject({ allowed: false, code: 'calls_in_progress_limit', current: 1 });
      await records.endCall(answered.id, {});
      await expect(decide(orgs.phone, CARRIER)).resolves.toMatchObject({ allowed: true });
    });

    test('the trunks phone system numbers use that are not flagged are listed, and a leg on one is logged', async () => {
      const ddi = (n) => `4420795${stamp.slice(0, 3)}${n}`;
      await PhoneNumber.create({ number: ddi(1), handler: 'pbx', organisationId: orgs.phone, aplisayId: PLATFORM });
      await PhoneNumber.create({ number: ddi(2), handler: 'pbx', organisationId: orgs.phone, aplisayId: CARRIER });
      await PhoneNumber.create({ number: ddi(3), handler: 'pbx', organisationId: orgs.phone, aplisayId: REGISTRATION });
      const { unflaggedPhoneSystemTrunks } = await import('../lib/outbound-trunk-check.js');
      const query = (sql, replacements) => db.Trunk.sequelize.query(sql, { replacements, type: db.Trunk.sequelize.QueryTypes.SELECT });
      const listed = await unflaggedPhoneSystemTrunks(query, { env: {} });
      expect(listed.filter((t) => [PLATFORM, CARRIER, REGISTRATION].includes(t.id))).toEqual([
        expect.objectContaining({ id: PLATFORM, numbers: 1 }),
      ]);
      const withFallback = await unflaggedPhoneSystemTrunks(query, { env: { APLISAY_OUTBOUND_TRUNK_ID: PLATFORM } });
      expect(withFallback.filter((t) => t.id === PLATFORM)).toHaveLength(1);

      const warn = jest.fn();
      const { default: route } = await import('../api/paths/agent-db/pbx/outbound-authorisation.js');
      const res = { status() { return this; }, send(body) { this.body = body; return this; } };
      await route({ ...log, warn }).POST({ body: { calledId: '+442079460123', organisationId: orgs.phone, presentNumber: `+${ddi(1)}` } }, res);
      expect(res.body).toMatchObject({ allowed: true, chargeable: false, trunkId: PLATFORM });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ trunkId: PLATFORM }), expect.stringMatching(/not flagged chargeable/));
    });
  });

  describe('the charge in a directory write', () => {
    const ctx = (dryRun) => ({
      organisation: { id: orgs.phone, capabilities: ['phoneSystem'] }, dryRun, actor: { kind: 'user', userId: `xc-owner-${stamp}` },
    });

    test('adding an extension shows its monthly charge and the part month, also in a dry run', async () => {
      const result = await directory.createEntry(ctx(true), { name: 'Dana', kind: 'person', extension: '250', extensionType: 'ring_all' });
      expect(result.dryRun).toBe(true);
      const now = new Date();
      const period = charge.chargePeriod({ createdAt: now, now });
      expect(result.effect.charges.add).toEqual([expect.objectContaining({
        number: '250', amountMicros: 4_000_000, currency: 'gbp', startsOn: period.from, priced: true,
        firstPeriodMicros: Math.round(4_000_000 * (period.days / period.daysInMonth)),
      })]);
      expect(result.effect.charges.remove).toEqual([]);
      expect(await db.Extension.count({ where: { organisationId: orgs.phone } })).toBe(0);
      // An entry's extension is a free connection unless a type is asked for.
      const free = await directory.createEntry(ctx(true), { name: 'Office PBX', kind: 'service', extension: '350' });
      expect(free.effect.charges).toEqual({ add: [], remove: [] });
    });

    test('removing an extension shows the charge stopping, with no refund', async () => {
      const created = await directory.createEntry(ctx(false), { name: 'Evan', kind: 'person', extension: '251', extensionType: 'ring_all' });
      const ext = await db.Extension.findOne({ where: { organisationId: orgs.phone, number: '251' } });
      expect(created.effect.charges.add).toHaveLength(1);
      const removed = await directory.deleteExtension(ctx(true), ext.id);
      expect(removed.effect.charges.remove).toEqual([expect.objectContaining({ extensionId: ext.id, number: '251', refundMicros: 0 })]);
      expect(removed.effect.charges.add).toEqual([]);
    });

    test('a restore quotes what the job then charges: the month from the first, or nothing if already charged', async () => {
      await directory.createEntry(ctx(false), { name: 'Fran', kind: 'person', extension: '252', extensionType: 'ring_all' });
      const ext = await db.Extension.findOne({ where: { organisationId: orgs.phone, number: '252' } });
      await db.Extension.sequelize.query('UPDATE extensions SET created_at = :at WHERE id = :id', { replacements: { at: new Date(Date.now() - 90 * DAY), id: ext.id } });
      await directory.deleteExtension(ctx(false), ext.id);
      const quoted = (await directory.restoreExtension(ctx(true), ext.id)).effect.charges.add[0];
      await directory.restoreExtension(ctx(false), ext.id);
      await charge.chargeOrganisation(await orgRow(orgs.phone), { log });
      const [row] = await chargeRows(orgs.phone);
      expect(quoted.firstPeriodMicros).toBe(Number(row.costMicros));
      await directory.deleteExtension(ctx(false), ext.id);
      const again = (await directory.restoreExtension(ctx(true), ext.id)).effect.charges.add[0];
      expect(again).toMatchObject({ extensionId: ext.id, amountMicros: 4_000_000, firstPeriodMicros: 0 });
    });

    test('a change from connection to a charged type quotes what the job then charges', async () => {
      await directory.createEntry(ctx(false), { name: 'Gail', kind: 'team', extension: '253' });
      const ext = await db.Extension.findOne({ where: { organisationId: orgs.phone, number: '253' } });
      await db.Extension.sequelize.query('UPDATE extensions SET created_at = :at WHERE id = :id', { replacements: { at: new Date(Date.now() - 90 * DAY), id: ext.id } });
      const quoted = (await directory.updateExtension(ctx(true), ext.id, { type: 'ring_all' })).effect.charges.add[0];
      await directory.updateExtension(ctx(false), ext.id, { type: 'ring_all' });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { log });
      const [row] = await chargeRows(orgs.phone);
      expect(quoted.firstPeriodMicros).toBe(Number(row.costMicros));
    });
  });

  describe('who sees the usage rows', () => {
    let usageRoute;
    let recordsRoute;
    let callId;
    const users = {};
    const invoke = async (handler, user, query) => {
      const res = {
        locals: { user },
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        send(body) { this.body = body; return this; },
        json(body) { this.body = body; return this; },
      };
      await handler({ query, log }, res);
      return res;
    };

    beforeAll(async () => {
      usageRoute = (await import('../api/paths/usage.js')).default(log).GET;
      recordsRoute = (await import('../api/paths/usage/records.js')).default(log).GET;
      Object.assign(users, {
        owner: { id: `xc-owner-${stamp}`, organisationId: orgs.phone, role: 'owner' },
        member: { id: `xc-member-${stamp}`, organisationId: orgs.phone, role: 'member' },
        operator: { id: `xc-operator-${stamp}`, organisationId: null, role: 'superAdmin' },
      });
    });

    beforeEach(async () => {
      const call = (await records.upsertCall({ id: randomUUID(), organisationId: orgs.phone, callerId: '201', calledId: '202' })).call;
      await records.endCall(call.id, {});
      callId = call.id;
    });

    test('a member with no linked person gets no usage for a phone system call, as for a call that does not exist', async () => {
      const hidden = await invoke(usageRoute, users.member, { callId });
      const missing = await invoke(usageRoute, users.member, { callId: randomUUID() });
      expect(hidden.body).toEqual({ usage: [] });
      expect(hidden.body).toEqual(missing.body);
      expect((await invoke(recordsRoute, users.member, { callId })).body.records).toEqual([]);
    });

    test('the owner sees it', async () => {
      const seen = await invoke(usageRoute, users.owner, { callId });
      expect(seen.body.usage).toEqual([expect.objectContaining({ technology: 'pbx', costMicros: 0 })]);
      const listed = await invoke(recordsRoute, users.owner, { callId });
      expect(listed.body.records).toEqual([expect.objectContaining({ technology: 'pbx', priceState: 'free' })]);
    });

    test("an operator sums the usage by brand, and a brand's totals hold its phone system usage", async () => {
      await extension(orgs.phone, '211', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: NOV_20, log });
      const byBrand = await invoke(usageRoute, users.operator, { groupBy: 'brand,technology', brand: BRAND });
      expect(byBrand.body.usage).toEqual(expect.arrayContaining([
        expect.objectContaining({ brand: BRAND, technology: 'extension', costMicros: 4_000_000 }),
        expect.objectContaining({ brand: BRAND, technology: 'pbx', costMicros: 0 }),
      ]));
      expect(byBrand.body.usage.every((row) => row.brand === BRAND)).toBe(true);
    });
  });

  describe('rate lines', () => {
    test('a line of the phone system dimensions must name its technology', async () => {
      const { validateRateLines } = await import('../lib/rates.js');
      expect(validateRateLines({ lines: [{ dim: 'extension', match: {}, unit: 'month', priceMicros: 1 }] })).toMatch(/technology 'extension'/);
      expect(validateRateLines({ lines: [{ dim: 'recording', match: { technology: 'voice' }, unit: 'minute', priceMicros: 1 }] })).toMatch(/technology 'recording'/);
      expect(validateRateLines({ lines: [{ dim: 'transcription', match: { technology: 'transcription' }, unit: 'minute', priceMicros: 1 }] })).toBeNull();
    });

    test('an extension line written straight to the database does not price an agent row', async () => {
      const { resolveRowCost } = await import('../lib/rates.js');
      const loose = { detail: { lines: [{ dim: 'extension', match: {}, unit: 'minute', priceMicros: 1_000 }] } };
      expect(resolveRowCost({ technology: 'voice', unit: 'milliseconds', quantity: 60_000 }, loose)).toMatchObject({ status: 'no_line' });
    });
  });

  // Last: switching the step off cannot be undone in this process.
  describe('before the extension charge schema step is ready', () => {
    test('nothing is charged, no call writes usage, an empty balance stops nothing, and a write quotes nothing', async () => {
      schema.stepOff('extensionCharge');
      await extension(orgs.phone, '260', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await charge.runExtensionCharges({ now: NOV_20, log });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: NOV_20, log });
      expect(await chargeRows(orgs.phone)).toHaveLength(0);

      const call = (await records.upsertCall({ id: randomUUID(), organisationId: orgs.phone, callerId: '201', calledId: '+442079460123' })).call;
      await records.endCall(call.id, {});
      expect(await UsageRecord.count({ where: { callId: call.id } })).toBe(0);

      await Organisation.update({ balance: -100 }, { where: { id: orgs.phone } });
      await expect(oa.authoriseOutboundDestination({ calledId: '+442079460123', organisationId: orgs.phone, aplisayId: CARRIER }, { env: {}, log }))
        .resolves.toMatchObject({ allowed: true });

      const ctx = { organisation: { id: orgs.phone, capabilities: ['phoneSystem'] }, dryRun: true, actor: { kind: 'user', userId: 'x' } };
      const result = await directory.createEntry(ctx, { name: 'Hal', kind: 'person', extension: '261', extensionType: 'ring_all' });
      expect(result.effect.charges).toEqual({ add: [], remove: [] });
    });
  });
});
