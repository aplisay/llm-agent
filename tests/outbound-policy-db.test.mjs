/**
 * The organisation's outbound policy on the real authorisation path and its
 * route, against the test database: each class, each limit, the brand's
 * ceiling, the daily notice, and that it fails closed.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { jest } from '@jest/globals';
import express from 'express';
import openapi from 'express-openapi';
import request from 'supertest';
import yaml from 'js-yaml';
import {
  setupRealDatabase, teardownRealDatabase, databaseStarted,
  Organisation, User, Trunk, RateCard, Tariff, TariffPrefix, Call, UsageRecord,
} from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const START = new Date('2020-01-01T00:00:00Z');
const NO_ENV = { env: {} };

describe('the outbound policy of an organisation', () => {
  const stamp = `${Date.now()}`.slice(-6);
  const BRAND = `obp-${stamp}`;
  const cardName = `obp-card-${stamp}`;
  const tariffName = `obp-tariff-${stamp}`;
  const WIDE = `obp-wide-${stamp}`;
  const PLAIN_TRUNK = `obp-plain-${stamp}`;
  const BYO = `obp-byo-${stamp}`;
  const orgs = {};
  const users = {};
  let db;
  let oa;
  let app;
  let server;

  const authorise = (organisationId, calledId, extra = {}, models = {}) => oa.authoriseOutboundDestination(
    { calledId, organisationId, outboundTrunkId: WIDE, at: new Date(), ...extra },
    { ...NO_ENV, log, ...models },
  );
  const setPolicy = (organisationId, policy) => Organisation.update({ outboundPolicy: policy }, { where: { id: organisationId } });
  const clearEvents = (organisationId) => db.OutboundEvent.destroy({ where: { organisationId } });
  const liveLeg = (organisationId, fields = {}) => Call.create({
    organisationId, platform: 'pbx', modelName: 'telephony:pbx-leg', callerId: '201', calledId: '+442079460123',
    outboundTrunkId: WIDE, live: true, status: 'in progress', startedAt: new Date(), ...fields,
  });

  const http = (method) => (user, path, body) => {
    const req = request(server)[method](`/api${path}`).set('x-test-user', user);
    return body === undefined ? req : req.send(body);
  };
  const get = http('get');
  const put = http('put');

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    db = await import('../lib/database.js');
    oa = await import('../lib/outbound-authorisation.js');

    await db.Brand.create({
      id: BRAND,
      defaultCapabilities: ['phoneSystem'],
      outboundCeiling: { classes: { international: true, service: true }, callsInProgress: 5, callsPerMinute: 50 },
    });
    const make = async (key, fields) => {
      orgs[key] = `obp-${key}-${stamp}`;
      await Organisation.create({ id: orgs[key], name: key, rateHistory: [{ name: cardName, startDate: START }], ...fields });
    };
    await make('phone', { capabilities: ['phoneSystem'], brand: BRAND });
    await make('plain', { capabilities: [] });
    await make('nobrand', { capabilities: ['phoneSystem'] });
    await make('other', { capabilities: ['phoneSystem'], brand: BRAND });

    const tariff = await Tariff.create({ name: tariffName, startDate: START });
    await TariffPrefix.bulkCreate(['4411', '4420', '4477', '4470', '4476', '4480', '4484', '449', '1'].map((prefix) => ({
      tariffId: tariff.id, prefix, connectMicros: 0, peakPerMinuteMicros: 100_000, offPeakPerMinuteMicros: 100_000,
    })));
    await RateCard.create({
      name: cardName, startDate: START, currency: 'gbp', detail: { lines: [{ dim: 'destination', tariff: tariffName }] },
    });
    // A trunk filter wide enough that the organisation's policy is what decides.
    await Trunk.create({ id: WIDE, name: 'Wide', outbound: true, chargeable: true, outboundCallFilter: '^\\+\\d{8,15}$' });
    await Trunk.create({ id: PLAIN_TRUNK, name: 'Default filter', outbound: true, chargeable: true });
    await Trunk.create({ id: BYO, name: 'Customer', outbound: true, chargeable: false });

    Object.assign(users, {
      owner: { id: `obp-owner-${stamp}`, organisationId: orgs.phone, role: 'owner' },
      admin: { id: `obp-admin-${stamp}`, organisationId: orgs.phone, role: 'orgAdmin' },
      member: { id: `obp-member-${stamp}`, organisationId: orgs.phone, role: 'member' },
      otherOwner: { id: `obp-other-${stamp}`, organisationId: orgs.other, role: 'owner' },
      plainOwner: { id: `obp-plainowner-${stamp}`, organisationId: orgs.plain, role: 'owner' },
      operator: { id: `obp-operator-${stamp}`, organisationId: null, role: 'superAdmin' },
    });
    app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.log = log;
      res.locals.user = users[req.headers['x-test-user']];
      next();
    });
    for (const file of ['../api/paths/organisations/{organisationId}/outbound-policy.js', '../api/paths/brands/{brandId}.js']) {
      await import(file);
    }
    await openapi.initialize({
      app,
      apiDoc: yaml.load(fs.readFileSync('./api/api-doc.yaml', 'utf8')),
      dependencies: { logger: log, voices: {}, wsServer: {} },
      paths: './api/paths',
      routesGlob: '{organisations/{organisationId}/outbound-policy,brands/{brandId}}.js',
      promiseMode: true,
      errorMiddleware: (err, req, res, next) => res.status(err.status || 500).json(err),
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
  }, 60000);

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    const ids = Object.values(orgs);
    await Call.destroy({ where: { organisationId: ids } });
    await UsageRecord.destroy({ where: { organisationId: ids } });
    await db.OutboundEvent.destroy({ where: { organisationId: ids } });
    await Trunk.destroy({ where: { id: [WIDE, PLAIN_TRUNK, BYO] } });
    await RateCard.destroy({ where: { name: cardName } });
    await Tariff.destroy({ where: { name: tariffName } });
    await Organisation.destroy({ where: { id: ids } });
    await db.Brand.destroy({ where: { id: BRAND } });
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    await setPolicy(orgs.phone, null);
    await clearEvents(orgs.phone);
    await Call.destroy({ where: { organisationId: orgs.phone } });
    await UsageRecord.destroy({ where: { organisationId: orgs.phone } });
  });

  describe('070 and 076 are refused by default', () => {
    test('by the default trunk filter, for an organisation without the phone system', async () => {
      for (const number of ['+447012345678', '+447640123456']) {
        await expect(authorise(orgs.plain, number, { outboundTrunkId: PLAIN_TRUNK }))
          .resolves.toMatchObject({ allowed: false, code: 'trunk_filter' });
      }
      await expect(authorise(orgs.plain, '+447700900123', { outboundTrunkId: PLAIN_TRUNK }))
        .resolves.toMatchObject({ allowed: true });
    });

    test('by the default agent filter on a trunk we do not pay for', async () => {
      await expect(authorise(orgs.plain, '07012345678', { outboundTrunkId: BYO }))
        .resolves.toMatchObject({ allowed: false, code: 'default_filter', chargeable: false });
    });

    test("but the Isle of Man's mobiles, 07624, pass both default filters", async () => {
      await expect(authorise(orgs.plain, '+447624123456', { outboundTrunkId: PLAIN_TRUNK }))
        .resolves.toMatchObject({ allowed: true, chargeable: true });
      await expect(authorise(orgs.plain, '07624123456', { outboundTrunkId: BYO }))
        .resolves.toMatchObject({ allowed: true, chargeable: false });
    });

    test('and the policy can still close 07624 by its class', async () => {
      await expect(authorise(orgs.phone, '+447624123456', { outboundTrunkId: PLAIN_TRUNK }))
        .resolves.toMatchObject({ allowed: false, code: 'destination_class', destinationClass: 'crownDependencies' });
    });

    test('by the destination classes when an operator opened them on the trunk', async () => {
      for (const number of ['+447012345678', '+447640123456']) {
        await expect(authorise(orgs.phone, number))
          .resolves.toMatchObject({ allowed: false, code: 'destination_class', destinationClass: 'premium' });
      }
    });
  });

  describe('destination classes', () => {
    test('the default classes: landline, mobile and freephone pass, the rest are refused', async () => {
      for (const number of ['+442079460123', '+447700900123', '+448081570123']) {
        await expect(authorise(orgs.phone, number)).resolves.toMatchObject({ allowed: true, code: 'ok' });
      }
      for (const [number, destinationClass] of [['+448449790123', 'service'], ['+449098790123', 'premium'], ['+15550100123', 'international']]) {
        const decision = await authorise(orgs.phone, number);
        expect(decision).toMatchObject({ allowed: false, code: 'destination_class', destinationClass, chargeable: true });
        expect(decision.reason).toContain(number);
      }
    });

    test('a Reading number (0118) is a landline', async () => {
      await expect(authorise(orgs.phone, '+441184960000')).resolves.toMatchObject({ allowed: true, code: 'ok' });
    });

    test('a class the organisation opens within the ceiling passes', async () => {
      await setPolicy(orgs.phone, { classes: { international: true, service: true } });
      await expect(authorise(orgs.phone, '+15550100123')).resolves.toMatchObject({ allowed: true });
      await expect(authorise(orgs.phone, '+448449790123')).resolves.toMatchObject({ allowed: true });
    });

    test('a class the organisation closes is refused', async () => {
      await setPolicy(orgs.phone, { classes: { ukMobile: false } });
      await expect(authorise(orgs.phone, '+447700900123')).resolves.toMatchObject({ allowed: false, destinationClass: 'ukMobile' });
      await expect(authorise(orgs.phone, '+442079460123')).resolves.toMatchObject({ allowed: true });
    });
  });

  describe('the ceiling', () => {
    test('a class the brand does not open stays closed, whatever the organisation stored', async () => {
      await setPolicy(orgs.phone, { classes: { premium: true } });
      await expect(authorise(orgs.phone, '+449098790123')).resolves.toMatchObject({ allowed: false, destinationClass: 'premium' });
    });

    test('an organisation with no brand has the platform ceiling', async () => {
      await setPolicy(orgs.nobrand, { classes: { international: true } });
      await expect(authorise(orgs.nobrand, '+15550100123')).resolves.toMatchObject({ allowed: false, destinationClass: 'international' });
      await setPolicy(orgs.nobrand, null);
    });

    test("a limit above the brand's ceiling is clipped to it", async () => {
      await setPolicy(orgs.phone, { callsInProgress: 100 });
      for (let i = 0; i < 5; i += 1) await liveLeg(orgs.phone);
      await expect(authorise(orgs.phone, '+442079460123'))
        .resolves.toMatchObject({ allowed: false, code: 'calls_in_progress_limit', value: 5, current: 5 });
    });
  });

  describe('the limits', () => {
    test('calls in progress count live outside legs on our trunks only', async () => {
      await setPolicy(orgs.phone, { callsInProgress: 2 });
      await liveLeg(orgs.phone);
      // None of these count: an ended leg, a leg on a trunk we do not pay for, a call inside the organisation, a stale row.
      await liveLeg(orgs.phone, { live: false, endedAt: new Date(), status: 'ended normally' });
      await liveLeg(orgs.phone, { outboundTrunkId: BYO });
      await liveLeg(orgs.phone, { outboundTrunkId: null, modelName: 'telephony:pbx-call' });
      const stale = await liveLeg(orgs.phone);
      await Call.sequelize.query("UPDATE calls SET created_at = now() - interval '5 hours' WHERE id = :id", { replacements: { id: stale.id } });
      await expect(authorise(orgs.phone, '+442079460123')).resolves.toMatchObject({ allowed: true });
      await liveLeg(orgs.phone);
      const refused = await authorise(orgs.phone, '+442079460123');
      expect(refused).toMatchObject({ allowed: false, code: 'calls_in_progress_limit', limit: 'callsInProgress', value: 2, current: 2 });
      expect(refused.reason).toMatch(/2 outside calls in progress/);
    });

    test('calls a minute count the calls the policy allowed in the last 60 seconds', async () => {
      await setPolicy(orgs.phone, { callsPerMinute: 3 });
      for (let i = 0; i < 3; i += 1) {
        await expect(authorise(orgs.phone, '+442079460123')).resolves.toMatchObject({ allowed: true });
      }
      await expect(authorise(orgs.phone, '+442079460123'))
        .resolves.toMatchObject({ allowed: false, code: 'calls_per_minute_limit', current: 3 });
      // Older than a minute: no longer counted.
      await db.OutboundEvent.update({ at: new Date(Date.now() - 61_000) }, { where: { organisationId: orgs.phone } });
      await expect(authorise(orgs.phone, '+442079460123')).resolves.toMatchObject({ allowed: true });
    });

    test('a call is in progress from its decision until its call row ends', async () => {
      await setPolicy(orgs.phone, { callsInProgress: 2 });
      await expect(authorise(orgs.phone, '+442079460001')).resolves.toMatchObject({ allowed: true });
      await expect(authorise(orgs.phone, '+442079460002')).resolves.toMatchObject({ allowed: true });
      // Neither call has a row yet: both still hold their place.
      await expect(authorise(orgs.phone, '+442079460003'))
        .resolves.toMatchObject({ allowed: false, code: 'calls_in_progress_limit', current: 2 });
      // The first is answered, as call control writes it, and then ends: its place is free.
      const leg = await liveLeg(orgs.phone, { calledId: '+442079460001' });
      await expect(authorise(orgs.phone, '+442079460003')).resolves.toMatchObject({ allowed: false, current: 2 });
      await leg.update({ live: false, endedAt: new Date(), status: 'ended normally' });
      await expect(authorise(orgs.phone, '+442079460003')).resolves.toMatchObject({ allowed: true });
    });

    test('a decision whose call never gets a row gives its place back after two minutes', async () => {
      await setPolicy(orgs.phone, { callsInProgress: 1 });
      await expect(authorise(orgs.phone, '+442079460001')).resolves.toMatchObject({ allowed: true });
      await expect(authorise(orgs.phone, '+442079460002')).resolves.toMatchObject({ allowed: false });
      await db.OutboundEvent.update({ at: new Date(Date.now() - oa.DECISION_HOLDS_PLACE_MS - 1000) }, { where: { organisationId: orgs.phone } });
      await expect(authorise(orgs.phone, '+442079460002')).resolves.toMatchObject({ allowed: true });
    });

    test('calls decided at the same moment cannot pass the calls a minute limit', async () => {
      await setPolicy(orgs.phone, { callsPerMinute: 3 });
      const decisions = await Promise.all(Array.from({ length: 20 }, (_, i) => authorise(orgs.phone, `+4420794601${String(i).padStart(2, '0')}`)));
      expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
      expect(decisions.filter((d) => d.code === 'calls_per_minute_limit')).toHaveLength(17);
    });

    test('calls decided at the same moment cannot pass the calls in progress limit', async () => {
      await setPolicy(orgs.phone, { callsInProgress: 2 });
      const decisions = await Promise.all(Array.from({ length: 10 }, (_, i) => authorise(orgs.phone, `+4420794602${String(i).padStart(2, '0')}`)));
      expect(decisions.filter((d) => d.allowed)).toHaveLength(2);
    });

    test('daily spend, from the spend source', async () => {
      await setPolicy(orgs.phone, { spendPerDayMicros: 2_000_000 });
      const spendSource = async () => 2_000_000;
      await expect(authorise(orgs.phone, '+442079460123', {}, { spendSource }))
        .resolves.toMatchObject({ allowed: false, code: 'daily_spend_limit', current: 2_000_000 });
      await expect(authorise(orgs.phone, '+442079460123', {}, { spendSource: async () => 1_999_999 }))
        .resolves.toMatchObject({ allowed: true });
    });

    test('monthly spend, from the spend source, by the start of the month', async () => {
      await setPolicy(orgs.phone, { spendPerMonthMicros: 10_000_000 });
      const at = new Date();
      const { dayStart, monthStart } = (await import('../lib/outbound-policy.js')).periodsAt(at);
      const asked = [];
      const spendSource = async ({ since }) => {
        asked.push(since.valueOf());
        return since.valueOf() === monthStart.valueOf() ? 10_000_000 : 0;
      };
      await expect(authorise(orgs.phone, '+442079460123', { at }, { spendSource }))
        .resolves.toMatchObject({ allowed: false, code: 'monthly_spend_limit' });
      expect(asked).toEqual(expect.arrayContaining([dayStart.valueOf(), monthStart.valueOf()]));
    });

    test("the interim spend source reads today's costed destination usage", async () => {
      await setPolicy(orgs.phone, { spendPerDayMicros: 1_000_000 });
      const row = {
        organisationId: orgs.phone, technology: 'voice', provider: 'pbx', unit: 'milliseconds', quantity: 60_000,
        finalised: true, billedAt: new Date(), costMicros: 600_000,
      };
      await UsageRecord.create({ ...row, sessionId: randomUUID(), meterKey: 'a', metadata: { destinationRaw: '+442079460123' } });
      // Not a destination charge: not counted.
      await UsageRecord.create({ ...row, sessionId: randomUUID(), meterKey: 'b', costMicros: 5_000_000, metadata: {} });
      await expect(authorise(orgs.phone, '+442079460123')).resolves.toMatchObject({ allowed: true });
      await UsageRecord.create({ ...row, sessionId: randomUUID(), meterKey: 'c', costMicros: 400_000, metadata: { destinationRaw: '+447700900123' } });
      await expect(authorise(orgs.phone, '+442079460123')).resolves.toMatchObject({ allowed: false, code: 'daily_spend_limit', current: 1_000_000 });
    });

    test('an hours rule refuses outside its hours', async () => {
      const at = new Date('2026-11-18T03:00:00Z');
      await setPolicy(orgs.phone, { hours: { timeZone: 'Europe/London', days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' } });
      await expect(authorise(orgs.phone, '+442079460123', { at })).resolves.toMatchObject({ allowed: false, code: 'outside_hours' });
      await expect(authorise(orgs.phone, '+442079460123', { at: new Date('2026-11-18T12:00:00Z') })).resolves.toMatchObject({ allowed: true });
    });
  });

  describe('where it applies', () => {
    test('not to an organisation without the phone system', async () => {
      await setPolicy(orgs.plain, { classes: { ukLandline: false } });
      await expect(authorise(orgs.plain, '+15550100123')).resolves.toMatchObject({ allowed: true, chargeable: true });
      await expect(authorise(orgs.plain, '+442079460123')).resolves.toMatchObject({ allowed: true });
      expect(await db.OutboundEvent.count({ where: { organisationId: orgs.plain } })).toBe(0);
      await setPolicy(orgs.plain, null);
    });

    test('not on a trunk we do not pay for', async () => {
      await setPolicy(orgs.phone, { callsInProgress: 0 });
      await expect(authorise(orgs.phone, '+442079460123', { outboundTrunkId: BYO })).resolves.toMatchObject({ allowed: true, chargeable: false });
    });

    test('each decision is written with its class', async () => {
      await authorise(orgs.phone, '+442079460123');
      await authorise(orgs.phone, '+15550100123');
      const rows = await db.OutboundEvent.findAll({ where: { organisationId: orgs.phone }, order: [['at', 'ASC']] });
      expect(rows.map((r) => [r.allowed, r.code, r.destinationClass, r.trunkId])).toEqual([
        [true, 'ok', 'ukLandline', WIDE],
        [false, 'destination_class', 'international', WIDE],
      ]);
    });
  });

  describe('the notice', () => {
    test('the first refusal by a limit on a day sends one notice, and later ones do not', async () => {
      await setPolicy(orgs.phone, { callsInProgress: 0 });
      const notify = jest.fn(async () => true);
      await authorise(orgs.phone, '+442079460123', {}, { notify });
      await authorise(orgs.phone, '+442079460123', {}, { notify });
      // A refusal by class is not a limit and sends nothing.
      await authorise(orgs.phone, '+15550100123', {}, { notify });
      expect(notify).toHaveBeenCalledTimes(1);
      expect(notify.mock.calls[0][1]).toMatchObject({ code: 'calls_in_progress_limit', day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
      const rows = await db.OutboundEvent.findAll({ where: { organisationId: orgs.phone, allowed: false } });
      expect(rows).toHaveLength(3);
      expect(rows.filter((r) => r.noticeDay)).toHaveLength(1);
    });

    test('a notice whose send fails is sent by the next refusal by a limit', async () => {
      await setPolicy(orgs.phone, { callsInProgress: 0 });
      const notify = jest.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      await authorise(orgs.phone, '+442079460123', {}, { notify });
      // The failed send gives the day back in the background.
      for (let i = 0; i < 50 && await db.OutboundEvent.count({ where: { organisationId: orgs.phone, noticeDay: { [db.Op.ne]: null } } }); i += 1) {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      await authorise(orgs.phone, '+442079460123', {}, { notify });
      await authorise(orgs.phone, '+442079460123', {}, { notify });
      expect(notify).toHaveBeenCalledTimes(2);
    });

    test('with nowhere to send it, the day is kept and nothing is sent again', async () => {
      await setPolicy(orgs.phone, { callsInProgress: 0 });
      const notify = jest.fn(async () => null);
      await authorise(orgs.phone, '+442079460123', {}, { notify });
      await new Promise((resolve) => { setTimeout(resolve, 50); });
      await authorise(orgs.phone, '+442079460123', {}, { notify });
      expect(notify).toHaveBeenCalledTimes(1);
    });

    test('two servers refusing at once still send one notice', async () => {
      await setPolicy(orgs.phone, { callsPerMinute: 0 });
      const notify = jest.fn(async () => true);
      await Promise.all([1, 2, 3, 4].map(() => authorise(orgs.phone, '+442079460123', {}, { notify })));
      expect(notify).toHaveBeenCalledTimes(1);
    });

    test('the notice goes to the billing callback, signed', async () => {
      const { sendOutboundNotice, signOutboundNotice } = await import('../lib/outbound-notice.js');
      const send = jest.fn(async () => true);
      const organisation = { id: orgs.phone, billingConfig: { callbackUrl: 'https://example.com/hook', hashKey: 'k' } };
      const at = new Date('2026-11-18T10:00:00Z');
      const refusal = { code: 'daily_spend_limit', reason: 'r', limit: 'spendPerDayMicros', value: 5, day: '2026-11-18', at };
      await expect(sendOutboundNotice(organisation, refusal, { log, send })).resolves.toBe(true);
      expect(send).toHaveBeenCalledWith(expect.objectContaining({
        callHook: { url: 'https://example.com/hook' },
        payload: expect.objectContaining({
          event: 'outboundLimitReached', organisationId: orgs.phone, code: 'daily_spend_limit', day: '2026-11-18',
          hash: signOutboundNotice({ hashKey: 'k', organisationId: orgs.phone, code: 'daily_spend_limit', day: '2026-11-18' }),
        }),
      }));
      // The receiver refused it: the answer says so, to be tried again.
      await expect(sendOutboundNotice(organisation, refusal, { log, send: async () => false })).resolves.toBe(false);
      // No callback set: nothing is sent, and nothing throws.
      send.mockClear();
      await expect(sendOutboundNotice({ id: orgs.phone }, { code: 'x', reason: 'r', day: 'd', at }, { log, send })).resolves.toBeNull();
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('it fails closed', () => {
    const unavailable = { allowed: false, code: 'outbound_policy_unavailable', chargeable: true };

    test('when the spend cannot be read', async () => {
      await expect(authorise(orgs.phone, '+442079460123', {}, { spendSource: async () => { throw new Error('ledger down'); } }))
        .resolves.toMatchObject(unavailable);
    });

    test('when the brand cannot be read', async () => {
      const Brand = { findByPk: async () => { throw new Error('db down'); } };
      await expect(authorise(orgs.phone, '+442079460123', {}, { Brand })).resolves.toMatchObject(unavailable);
    });

    test('when the decision cannot be written', async () => {
      const OutboundEvent = {
        count: (...args) => db.OutboundEvent.count(...args),
        create: async () => { throw new Error('disk full'); },
      };
      await expect(authorise(orgs.phone, '+442079460123', {}, { OutboundEvent })).resolves.toMatchObject(unavailable);
    });

    test('when the spend source answers something that is not a number', async () => {
      await expect(authorise(orgs.phone, '+442079460123', {}, { spendSource: async () => undefined }))
        .resolves.toMatchObject(unavailable);
    });
  });

  describe('the route', () => {
    test('the owner reads the policy, the ceiling, what applies and the use today', async () => {
      await setPolicy(orgs.phone, { callsInProgress: 3 });
      await liveLeg(orgs.phone);
      const res = await get('owner', `/organisations/${orgs.phone}/outbound-policy`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        policy: { callsInProgress: 3 },
        ceiling: { callsInProgress: 5, classes: { international: true, premium: false } },
        effective: { callsInProgress: 3, classes: { international: false, ukLandline: true } },
        usage: { callsInProgress: 1, callsLastMinute: 0, spendTodayMicros: 0 },
        notices: [],
      });
    });

    test('the owner and an admin change it within the ceiling', async () => {
      let res = await put('owner', `/organisations/${orgs.phone}/outbound-policy`, { classes: { international: true }, callsPerMinute: 4 });
      expect(res.status).toBe(200);
      expect(res.body.effective).toMatchObject({ callsPerMinute: 4, classes: { international: true } });
      res = await put('admin', `/organisations/${orgs.phone}/outbound-policy`, { hours: { days: [1, 2, 3, 4, 5], from: '08:00', to: '18:00' } });
      expect(res.status).toBe(200);
      expect(res.body.policy).toMatchObject({ callsPerMinute: 4, classes: { international: true }, hours: { timeZone: 'Europe/London' } });
      expect((await Organisation.findByPk(orgs.phone)).outboundPolicy).toMatchObject({ callsPerMinute: 4 });
    });

    test('two changes at once both stick', async () => {
      const [a, b] = await Promise.all([
        put('owner', `/organisations/${orgs.phone}/outbound-policy`, { classes: { service: true } }),
        put('admin', `/organisations/${orgs.phone}/outbound-policy`, { callsPerMinute: 4 }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
      expect((await Organisation.findByPk(orgs.phone)).outboundPolicy).toMatchObject({ classes: { service: true }, callsPerMinute: 4 });
    });

    test('a stored hours rule that no longer checks shows as it is stored, not as any time', async () => {
      await setPolicy(orgs.phone, { hours: { days: 'weekdays' } });
      const res = await get('owner', `/organisations/${orgs.phone}/outbound-policy`);
      expect(res.body.effective).toMatchObject({ hours: { days: 'weekdays' }, hoursValid: false });
      await setPolicy(orgs.phone, null);
      expect((await get('owner', `/organisations/${orgs.phone}/outbound-policy`)).body.effective).toMatchObject({ hours: null, hoursValid: true });
    });

    test('a value above the ceiling is refused with the field', async () => {
      let res = await put('owner', `/organisations/${orgs.phone}/outbound-policy`, { callsInProgress: 6 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'above_ceiling', field: 'callsInProgress' });
      res = await put('owner', `/organisations/${orgs.phone}/outbound-policy`, { classes: { premium: true } });
      expect(res.body).toMatchObject({ code: 'above_ceiling', field: 'classes.premium' });
      res = await put('owner', `/organisations/${orgs.phone}/outbound-policy`, { callsInProgress: 'many' });
      expect(res.status).toBe(400);
    });

    test('a refusal shows in the notices', async () => {
      await setPolicy(orgs.phone, { callsInProgress: 0 });
      await authorise(orgs.phone, '+442079460123', {}, { notify: async () => true });
      const res = await get('owner', `/organisations/${orgs.phone}/outbound-policy`);
      expect(res.body.notices).toEqual([expect.objectContaining({ code: 'calls_in_progress_limit', count: 1, limit: true })]);
    });

    test('an ordinary member may not read or change it', async () => {
      expect((await get('member', `/organisations/${orgs.phone}/outbound-policy`)).status).toBe(403);
      expect((await put('member', `/organisations/${orgs.phone}/outbound-policy`, { callsInProgress: 1 })).status).toBe(403);
    });

    test("another organisation's owner gets 404", async () => {
      expect((await get('otherOwner', `/organisations/${orgs.phone}/outbound-policy`)).status).toBe(404);
      expect((await put('otherOwner', `/organisations/${orgs.phone}/outbound-policy`, { callsInProgress: 1 })).status).toBe(404);
    });

    test('an organisation without the phone system gets 403', async () => {
      const res = await get('plainOwner', `/organisations/${orgs.plain}/outbound-policy`);
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('phone_system_disabled');
    });

    test("a platform operator sets a brand's ceiling, and it applies at once", async () => {
      let res = await put('operator', `/brands/${BRAND}`, { outboundCeiling: { classes: { international: true, service: true }, callsInProgress: 1 } });
      expect(res.status).toBe(200);
      expect(res.body.outboundCeiling).toMatchObject({ callsInProgress: 1, callsPerMinute: 10, classes: { international: true } });
      await liveLeg(orgs.phone);
      await expect(authorise(orgs.phone, '+442079460123')).resolves.toMatchObject({ code: 'calls_in_progress_limit', value: 1 });
      res = await put('operator', `/brands/${BRAND}`, { outboundCeiling: { callsInProgress: -2 } });
      expect(res.body).toMatchObject({ code: 'invalid_request', field: 'outboundCeiling.callsInProgress' });
      await put('operator', `/brands/${BRAND}`, { outboundCeiling: { classes: { international: true, service: true }, callsInProgress: 5, callsPerMinute: 50 } });
    });
  });

  // Last: switching a schema step off cannot be undone in this process.
  describe('before the schema 75 upgrade', () => {
    test('outside calls of an organisation with the phone system are refused, and others are not', async () => {
      const { stepOff } = await import('../lib/schema-guards.js');
      stepOff('outboundPolicy');
      await expect(authorise(orgs.phone, '+442079460123')).resolves.toMatchObject({ allowed: false, code: 'outbound_policy_not_ready' });
      await expect(authorise(orgs.plain, '+442079460123')).resolves.toMatchObject({ allowed: true });
      expect((await get('owner', `/organisations/${orgs.phone}/outbound-policy`)).status).toBe(503);
    });
  });
});
