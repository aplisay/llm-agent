/**
 * Billing for the phone system, against the test database: the monthly charge
 * for each extension, the usage every phone system call writes, the rules for
 * an empty balance, the charge in a directory write's effect, and who sees the
 * usage rows.
 */
import { randomUUID } from 'node:crypto';
import {
  setupRealDatabase, teardownRealDatabase, databaseStarted,
  Organisation, Trunk, RateCard, Tariff, TariffPrefix, UsageRecord,
} from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const START = new Date('2020-01-01T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
// November, so London is on UTC.
const NOV_20 = new Date('2026-11-20T12:00:00Z');

describe('billing for the phone system', () => {
  const stamp = `${Date.now()}`.slice(-6);
  const BRAND = `xc-${stamp}`;
  const card = `xc-card-${stamp}`;
  const bareCard = `xc-bare-${stamp}`;
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

  const balanceOf = async (id) => Number((await Organisation.findByPk(id, { attributes: ['balance'] })).balance);
  const chargeRows = (organisationId) => UsageRecord.findAll({ where: { organisationId, technology: 'extension' }, order: [['quantity', 'ASC']] });
  const orgRow = (id) => Organisation.findByPk(id);

  /** An entry with an extension, created at `createdAt`. */
  const extension = async (organisationId, number, { type = 'ring_all', createdAt = new Date(), deletedAt = null } = {}) => {
    const entry = await db.DirectoryEntry.create({ organisationId, kind: 'team', name: `Team ${number}` });
    const row = await db.Extension.create({
      organisationId, number, type, entryId: entry.id, deletedAt,
    });
    await db.Extension.sequelize.query('UPDATE extensions SET created_at = :createdAt WHERE id = :id', { replacements: { createdAt, id: row.id } });
    return db.Extension.findByPk(row.id);
  };
  const clean = async (organisationId) => {
    await db.BalanceCredit.destroy({ where: { organisationId } });
    await UsageRecord.destroy({ where: { organisationId } });
    await db.Call.destroy({ where: { organisationId } });
    await db.OutboundEvent.destroy({ where: { organisationId } });
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
          // An agent's telephony line. It must not price a phone system row.
          { dim: 'audio-path', match: { technology: 'voice', media: 'telephony' }, unit: 'minute', priceMicros: 60_000 },
          { dim: 'destination', tariff: tariffName },
          { dim: 'extension', match: { technology: 'extension' }, unit: 'month', priceMicros: 4_000_000 },
          { dim: 'recording', match: { technology: 'recording' }, unit: 'minute', priceMicros: 10_000 },
          { dim: 'transcription', match: { technology: 'transcription' }, unit: 'minute', priceMicros: 20_000 },
        ],
      },
    });
    await RateCard.create({ name: bareCard, startDate: START, currency: 'gbp', detail: { lines: [{ dim: 'destination', tariff: tariffName }] } });
    const make = async (key, fields) => {
      orgs[key] = `xc-${key}-${stamp}`;
      await Organisation.create({ id: orgs[key], name: key, rateHistory: [{ name: card, startDate: START }], ...fields });
    };
    await make('phone', { capabilities: ['phoneSystem'], balance: 10_000_000, brand: BRAND });
    await make('plain', { capabilities: [], balance: 10_000_000 });
    await make('bare', { capabilities: ['phoneSystem'], balance: 10_000_000, rateHistory: [{ name: bareCard, startDate: START }] });
    await make('owing', { capabilities: ['phoneSystem'], balance: 1_000_000 });
    // Filters wide enough that the policy and the balance decide.
    await Trunk.create({ id: PLATFORM, name: 'Platform', outbound: true, chargeable: false, outboundCallFilter: '^\\+\\d{8,15}$' });
    await Trunk.create({
      id: REGISTRATION, name: 'Customer', outbound: true, chargeable: false, flags: { provider: 'registration', registrationId: randomUUID() },
    });
    await Trunk.create({ id: CARRIER, name: 'Carrier', outbound: true, chargeable: true, outboundCallFilter: '^\\+\\d{8,15}$' });
  }, 60000);

  afterAll(async () => {
    for (const id of Object.values(orgs)) await clean(id);
    await Trunk.destroy({ where: { id: [PLATFORM, REGISTRATION, CARRIER] } });
    await RateCard.destroy({ where: { name: [card, bareCard] } });
    await Tariff.destroy({ where: { name: tariffName } });
    await Organisation.destroy({ where: { id: Object.values(orgs) } });
    await db.Brand.destroy({ where: { id: BRAND } });
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    for (const id of Object.values(orgs)) await clean(id);
    await Organisation.update({ balance: 10_000_000, chargeUnpaidSince: null }, { where: { id: [orgs.phone, orgs.plain, orgs.bare] } });
    await Organisation.update({ balance: 1_000_000, chargeUnpaidSince: null }, { where: { id: orgs.owing } });
  });

  describe('the period charged', () => {
    test('an extension created this month is charged from that day, by the day', () => {
      expect(charge.chargePeriod({ createdAt: new Date('2026-11-11T09:00:00Z'), now: NOV_20 })).toMatchObject({
        month: '2026-11', from: '2026-11-11', to: '2026-11-30', days: 20, daysInMonth: 30, billedAt: new Date('2026-11-11T00:00:00Z'),
      });
    });

    test('an extension from an earlier month is charged the whole month', () => {
      expect(charge.chargePeriod({ createdAt: new Date('2026-10-01T00:00:00Z'), now: NOV_20 })).toMatchObject({
        from: '2026-11-01', days: 30, billedAt: new Date('2026-11-01T00:00:00Z'),
      });
    });

    test('days and months are UK days and months', () => {
      // 00:30 on 11 June, summer time.
      expect(charge.chargePeriod({ createdAt: new Date('2026-06-10T23:30:00Z'), now: new Date('2026-06-12T09:00:00Z') })).toMatchObject({
        from: '2026-06-11', days: 20, daysInMonth: 30, billedAt: new Date('2026-06-10T23:00:00Z'),
      });
      expect(charge.chargePeriod({ createdAt: new Date('2028-02-15T12:00:00Z'), now: new Date('2028-02-20T12:00:00Z') }))
        .toMatchObject({ days: 15, daysInMonth: 29 });
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

    test('a part month is the days over the length of the month', async () => {
      await extension(orgs.phone, '203', { createdAt: new Date('2026-11-28T15:00:00Z') });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: new Date('2026-11-28T16:00:00Z'), log });
      const [row] = await chargeRows(orgs.phone);
      expect(Number(row.quantity)).toBe(3);
      expect(Number(row.costMicros)).toBe(400_000);
      expect(row.metadata).toMatchObject({ month: '2026-11', from: '2026-11-28', to: '2026-11-30', daysInMonth: 30 });
      expect(row.sessionId).toBe(charge.chargeSessionId(row.metadata.extensionId, '2026-11'));
    });

    test('the next month is charged in full', async () => {
      await extension(orgs.phone, '204', { createdAt: new Date('2026-11-11T09:00:00Z') });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: NOV_20, log });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: new Date('2026-12-01T00:30:00Z'), log });
      const rows = await chargeRows(orgs.phone);
      expect(rows.map((r) => [r.metadata.month, Number(r.quantity), Number(r.costMicros)])).toEqual(expect.arrayContaining([
        ['2026-11', 20, 2_666_667],
        ['2026-12', 31, 4_000_000],
      ]));
    });

    test('a connection extension is free, and a removed one is not charged', async () => {
      await extension(orgs.phone, '310', { type: 'connection', createdAt: new Date('2026-10-01T00:00:00Z') });
      await extension(orgs.phone, '205', { createdAt: new Date('2026-10-01T00:00:00Z'), deletedAt: new Date('2026-11-02T00:00:00Z') });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { now: NOV_20, log });
      expect(await chargeRows(orgs.phone)).toHaveLength(0);
      expect(await balanceOf(orgs.phone)).toBe(10_000_000);
    });

    test('an organisation without the phone system is not charged', async () => {
      await extension(orgs.plain, '206', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await charge.runExtensionCharges({ now: NOV_20, log });
      expect(await chargeRows(orgs.plain)).toHaveLength(0);
    });

    test('with no extension line on the card the row is written unpriced and nothing is drawn', async () => {
      await extension(orgs.bare, '207', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await charge.chargeOrganisation(await orgRow(orgs.bare), { now: NOV_20, log });
      const [row] = await chargeRows(orgs.bare);
      expect(row).toMatchObject({ costStatus: 'no_line', costMicros: null });
      expect(await balanceOf(orgs.bare)).toBe(10_000_000);
    });

    test('the price shown before an extension is added', async () => {
      const at = new Date('2026-11-11T09:00:00Z');
      await expect(charge.extensionPrice({ organisationId: orgs.phone, type: 'ring_all', at })).resolves.toEqual({
        amountMicros: 4_000_000, firstPeriodMicros: 2_666_667, currency: 'gbp', startsOn: '2026-11-11',
      });
      await expect(charge.extensionPrice({ organisationId: orgs.phone, type: 'connection', at }))
        .resolves.toMatchObject({ amountMicros: 0, firstPeriodMicros: 0 });
      await expect(charge.extensionPrice({ organisationId: orgs.bare, type: 'ring_all', at }))
        .resolves.toMatchObject({ amountMicros: null, firstPeriodMicros: null });
    });
  });

  describe('an empty balance', () => {
    const pbxLeg = (organisationId, calledId = '+442079460123', aplisayId = PLATFORM) => oa.authoriseOutboundDestination(
      { calledId, organisationId, aplisayId, phoneSystemLeg: true }, { env: {}, log },
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

    test('a charge that leaves the balance below zero marks the organisation; one that does not, does not', async () => {
      await extension(orgs.owing, '208', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await extension(orgs.phone, '209', { createdAt: new Date('2026-10-01T00:00:00Z') });
      await charge.runExtensionCharges({ now: NOV_20, log });
      expect(await balanceOf(orgs.owing)).toBe(-3_000_000);
      expect((await orgRow(orgs.owing)).chargeUnpaidSince).toEqual(NOV_20);
      expect((await orgRow(orgs.phone)).chargeUnpaidSince).toBeNull();
      // A later run keeps the first time.
      await charge.runExtensionCharges({ now: new Date('2026-11-21T12:00:00Z'), log });
      expect((await orgRow(orgs.owing)).chargeUnpaidSince).toEqual(NOV_20);
    });

    test('after 30 days unpaid the phones stop taking calls, and a top-up starts them again', async () => {
      const ext = await extension(orgs.owing, '210', { createdAt: new Date('2026-10-01T00:00:00Z') });
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

    test('a leg out on a platform trunk carries the destination charge; the rest is written at nothing', async () => {
      const call = await pbxCall(orgs.phone, { calledId: '+442079460123' });
      const inside = await leg(orgs.phone, call.id, { calledId: '202', metadata: { kind: 'line', number: '202' } });
      const out = await leg(orgs.phone, call.id, { calledId: '+442079460123', outboundTrunkId: PLATFORM, metadata: { kind: 'external' } });
      const own = await leg(orgs.phone, call.id, { calledId: '+442079460124', outboundTrunkId: REGISTRATION, metadata: { kind: 'external' } });
      const endedAt = ONE_MINUTE_LATER;
      for (const row of [inside, out, own]) await records.endCall(row.id, { endedAt, answered: true });
      await records.endCall(call.id, { endedAt });

      const [priced] = await rowsOf(out.id);
      expect(priced).toMatchObject({ technology: 'pbx', provider: 'pbx', detail: 'telephony:pbx-leg', costStatus: 'matched' });
      // One minute at 100,000 a minute, and nothing from the agent's telephony line.
      expect(Number(priced.costMicros)).toBe(100_000);
      expect(priced.metadata.destinationRaw).toBe('+442079460123');
      for (const id of [call.id, inside.id, own.id]) {
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
      const out = await leg(orgs.phone, call.id, { calledId: '+447700900123', outboundTrunkId: PLATFORM, metadata: { kind: 'external' } });
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

    test('recording and transcription are charged by their lines', async () => {
      const call = await pbxCall(orgs.phone, { calledId: '+442079460123' });
      const out = await leg(orgs.phone, call.id, { calledId: '+442079460123', outboundTrunkId: PLATFORM, metadata: { kind: 'external' } });
      await records.endCall(out.id, { endedAt: ONE_MINUTE_LATER, transcribedMs: 30_000 });
      await records.endCall(call.id, { endedAt: ONE_MINUTE_LATER, recordedMs: 90_000 });
      const byTech = Object.fromEntries((await UsageRecord.findAll({ where: { callId: [call.id, out.id] } }))
        .map((row) => [`${row.callId === call.id ? 'call' : 'leg'}:${row.technology}`, Number(row.costMicros)]));
      expect(byTech).toEqual({ 'call:pbx': 0, 'call:recording': 15_000, 'leg:pbx': 100_000, 'leg:transcription': 10_000 });
    });

    test('a bad recording length is refused before anything is written', async () => {
      const call = await pbxCall(orgs.phone);
      await expect(records.endCall(call.id, { recordedMs: -5 })).rejects.toMatchObject({ status: 400 });
      expect(await rowsOf(call.id)).toHaveLength(0);
    });
  });

  describe('a phone system leg on a platform trunk', () => {
    test('is chargeable, so the trunk filter, the rating and the policy apply; a customer registration is not', async () => {
      const decide = (aplisayId, phoneSystemLeg) => oa.authoriseOutboundDestination(
        { calledId: '+442079460123', organisationId: orgs.phone, aplisayId, phoneSystemLeg }, { env: {}, log },
      );
      await expect(decide(PLATFORM, true)).resolves.toMatchObject({ allowed: true, chargeable: true, trunkId: PLATFORM, tariff: tariffName });
      await expect(decide(PLATFORM, false)).resolves.toMatchObject({ chargeable: false });
      await expect(decide(REGISTRATION, true)).resolves.toMatchObject({ chargeable: false });
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
        number: '250', amountMicros: 4_000_000, currency: 'gbp', startsOn: period.from,
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

    test('an extension restored in a month it was already charged for shows no new part month', async () => {
      await directory.createEntry(ctx(false), { name: 'Fran', kind: 'person', extension: '252', extensionType: 'ring_all' });
      const ext = await db.Extension.findOne({ where: { organisationId: orgs.phone, number: '252' } });
      await charge.chargeOrganisation(await orgRow(orgs.phone), { log });
      await directory.deleteExtension(ctx(false), ext.id);
      const restored = await directory.restoreExtension(ctx(true), ext.id);
      expect(restored.effect.charges.add).toEqual([expect.objectContaining({ extensionId: ext.id, amountMicros: 4_000_000, firstPeriodMicros: 0 })]);
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
});
