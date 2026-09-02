import {
  setupRealDatabase, teardownRealDatabase,
  Organisation, User, Trunk, RateCard, Tariff, TariffPrefix, databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import {
  authoriseOutboundDestination, resolveEgressTrunk, isDestinationRateable,
  filterAllows, validateOutboundCallFilter, trunkAllowsSrtp,
  DEFAULT_TRUNK_OUTBOUND_FILTER,
} from '../lib/outbound-authorisation.js';

// The outbound destination authorisation policy (lib/outbound-authorisation.js).
//
// The security property under test: on one of OUR chargeable carrier trunks the
// tenant's agents.options.outboundCallFilter is NOT the authority — the operator's
// Trunk.outboundCallFilter and the organisation's destination tariff are, and the
// agent's filter may only narrow them. On a non-chargeable egress (customer PBX /
// BYO trunk) the historical agent-filter behaviour is preserved exactly.

const PREFIX = `oa-test-${randomUUID()}-`;
const START = new Date('2020-01-01T00:00:00Z');

// A wide-open agent filter of the kind an agent author could set today: every
// destination on earth, including international premium-rate revenue share.
const WIDE_OPEN_FILTER = '^\\+?\\d{6,15}$';

describe('outbound call filter primitives', () => {
  test('validates a pattern and rejects an unusable one', () => {
    expect(validateOutboundCallFilter(null)).toBeNull();
    expect(validateOutboundCallFilter('^\\+44\\d+$')).toBeNull();
    expect(validateOutboundCallFilter('^(')).toMatch(/not a valid regular expression/);
    expect(validateOutboundCallFilter('x'.repeat(513))).toMatch(/at most/);
    expect(validateOutboundCallFilter(42)).toMatch(/must be a string/);
  });

  test('a malformed or over-long filter fails CLOSED rather than opening the gate', () => {
    expect(filterAllows('^\\+44\\d+$', '+447700900123')).toBe(true);
    expect(filterAllows('^(', '+447700900123')).toBe(false);
    expect(filterAllows('^\\+44\\d+$', '+'.padEnd(40, '4'))).toBe(false);
    expect(filterAllows(null, '+447700900123')).toBe(false);
  });

  test('the default trunk filter admits UK geographic/mobile only', () => {
    for (const ok of ['+442079460958', '+447700900123', '+441632960123', '+443069990000']) {
      expect(filterAllows(DEFAULT_TRUNK_OUTBOUND_FILTER, ok)).toBe(true);
    }
    for (const bad of ['+449098790123', '+18005550199', '+8801700000000', '+447700900123456']) {
      expect(filterAllows(DEFAULT_TRUNK_OUTBOUND_FILTER, bad)).toBe(false);
    }
  });
});

describe('per-trunk SRTP contract (Trunk.flags.srtp)', () => {
  test('defaults to offering SRTP when the trunk says nothing', () => {
    expect(trunkAllowsSrtp(null)).toBe(true);
    expect(trunkAllowsSrtp({})).toBe(true);
    expect(trunkAllowsSrtp({ flags: null })).toBe(true);
    expect(trunkAllowsSrtp({ flags: {} })).toBe(true);
    // Other flags on the same object must not be read as an opt-out.
    expect(trunkAllowsSrtp({ flags: { somethingElse: false } })).toBe(true);
  });

  test('only an explicit false opts the trunk out', () => {
    expect(trunkAllowsSrtp({ flags: { srtp: false } })).toBe(false);
    expect(trunkAllowsSrtp({ flags: { srtp: true } })).toBe(true);
    // Not falsy-tolerant on purpose: a stray "" or 0 in operator-edited JSONB
    // must not silently disable encryption on a trunk that supports it.
    expect(trunkAllowsSrtp({ flags: { srtp: '' } })).toBe(true);
    expect(trunkAllowsSrtp({ flags: { srtp: 0 } })).toBe(true);
  });
});

describe('outbound destination authorisation', () => {
  let orgId; let userId;
  const unratedOrgIds = [];
  const cardName = `${PREFIX}card`;
  const tariffName = `${PREFIX}tariff`;
  const chargeableTrunkId = `${PREFIX}public`;
  const byoTrunkId = `${PREFIX}byo`;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    orgId = randomUUID(); userId = randomUUID();
    await Organisation.create({
      id: orgId, name: 'Filter Org', rateHistory: [{ name: cardName, startDate: START }],
    });
    await User.create({
      id: userId, name: 'Filter User', email: `f-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '', role: 'owner',
      organisationId: orgId,
    });

    // A deck that prices UK landline + mobile only — nothing international, and
    // NOT the UK 09 premium-rate range.
    const tariff = await Tariff.create({ name: tariffName, startDate: START });
    await TariffPrefix.bulkCreate([
      { tariffId: tariff.id, prefix: '4420', connectMicros: 0, peakPerMinuteMicros: 100_000, offPeakPerMinuteMicros: 100_000 },
      { tariffId: tariff.id, prefix: '4477', connectMicros: 0, peakPerMinuteMicros: 300_000, offPeakPerMinuteMicros: 300_000 },
    ]);
    await RateCard.create({
      name: cardName, startDate: START, currency: 'gbp',
      detail: { lines: [{ dim: 'destination', tariff: tariffName }] },
    });

    await Trunk.create({ id: chargeableTrunkId, name: 'Our carrier', outbound: true, chargeable: true });
    await Trunk.create({ id: byoTrunkId, name: 'Customer BYO', outbound: true, chargeable: false });
  });

  afterAll(async () => {
    // Suites share one database, and a leftover chargeable trunk is exactly the
    // sort of row a global-trunk listing test would trip over. Clean up ours.
    await Trunk.destroy({ where: { id: [chargeableTrunkId, byoTrunkId] } });
    await RateCard.destroy({ where: { name: cardName } });
    await Tariff.destroy({ where: { name: tariffName } });
    await User.destroy({ where: { id: userId } });
    await Organisation.destroy({ where: { id: [orgId, ...unratedOrgIds] } });
    await teardownRealDatabase();
  }, 30000);

  // `{ env: {} }` pins the egress-trunk resolution to what each case passes
  // explicitly, so a set APLISAY_OUTBOUND_TRUNK_ID in the ambient environment
  // cannot introduce a third candidate trunk and make these cases flaky.
  const NO_ENV = { env: {} };
  const authorise = (calledId, extra = {}) => authoriseOutboundDestination({
    calledId, organisationId: orgId, userId, at: new Date(), ...extra,
  }, NO_ENV);

  describe('non-chargeable egress keeps the historical agent-authoritative behaviour', () => {
    test('defaults to UK geographic/mobile when the agent sets no filter', async () => {
      await expect(authorise('+447700900123', { aplisayId: byoTrunkId }))
        .resolves.toMatchObject({ allowed: true, chargeable: false });
      await expect(authorise('+18005550199', { aplisayId: byoTrunkId }))
        .resolves.toMatchObject({ allowed: false, code: 'default_filter' });
    });

    test('keeps the historical refusal wording', async () => {
      // listener-join-originate.test.mjs asserts these substrings, and they are
      // the strings the originate API has always returned to API clients.
      await expect(authorise('+1234567890', {
        aplisayId: byoTrunkId, agentOptions: { outboundCallFilter: '^\\+44\\d+$' },
      })).resolves.toMatchObject({
        reason: expect.stringContaining("does not match the agent's outbound call filter pattern"),
      });
      await expect(authorise('+1234567890', { aplisayId: byoTrunkId })).resolves.toMatchObject({
        reason: expect.stringContaining('is not a valid UK geographic or mobile number'),
      });
    });

    test("honours the agent's own filter, wide or narrow", async () => {
      await expect(authorise('+18005550199', {
        aplisayId: byoTrunkId, agentOptions: { outboundCallFilter: WIDE_OPEN_FILTER },
      })).resolves.toMatchObject({ allowed: true, chargeable: false });
      await expect(authorise('+447700900123', {
        aplisayId: byoTrunkId, agentOptions: { outboundCallFilter: '^\\+441632\\d+$' },
      })).resolves.toMatchObject({ allowed: false, code: 'agent_filter' });
    });

    test('a registration-originated leg is never chargeable, whatever trunk is around', async () => {
      const decision = await authorise('8092', {
        registrationOriginated: true,
        agentOptions: { outboundCallFilter: '^\\d{4}$' },
        outboundTrunkId: chargeableTrunkId,
      });
      expect(decision).toMatchObject({ allowed: true, chargeable: false, trunkId: null });
    });
  });

  describe('chargeable carrier trunk: operator policy wins', () => {
    test('a wide-open agent filter can no longer reach an unrated destination', async () => {
      const decision = await authorise('+18005550199', {
        outboundTrunkId: chargeableTrunkId,
        agentOptions: { outboundCallFilter: WIDE_OPEN_FILTER },
      });
      expect(decision.allowed).toBe(false);
      expect(decision.chargeable).toBe(true);
      // Blocked by the trunk's default UK-only filter, before rating is consulted.
      expect(decision.code).toBe('trunk_filter');
    });

    test('a UK premium-rate number passes a wide agent filter but is not rated', async () => {
      // Widen the trunk filter to all of +44 so the rating gate is what bites.
      await Trunk.update({ outboundCallFilter: '^\\+44\\d{9,10}$' }, { where: { id: chargeableTrunkId } });
      const decision = await authorise('+449098790123', {
        outboundTrunkId: chargeableTrunkId,
        agentOptions: { outboundCallFilter: WIDE_OPEN_FILTER },
      });
      expect(decision).toMatchObject({ allowed: false, code: 'not_rateable', chargeable: true });
      expect(decision.reason).toMatch(/not rated/);
      await Trunk.update({ outboundCallFilter: null }, { where: { id: chargeableTrunkId } });
    });

    test('a rated destination inside the trunk filter is allowed and reports its tariff', async () => {
      const decision = await authorise('+447700900123', { outboundTrunkId: chargeableTrunkId });
      expect(decision).toMatchObject({
        allowed: true, code: 'ok', chargeable: true, destination: '+447700900123',
        tariff: tariffName, prefix: '4477',
      });
    });

    test('the operator filter narrows a rateable destination', async () => {
      await Trunk.update({ outboundCallFilter: '^\\+4420\\d{8}$' }, { where: { id: chargeableTrunkId } });
      await expect(authorise('+447700900123', { outboundTrunkId: chargeableTrunkId }))
        .resolves.toMatchObject({ allowed: false, code: 'trunk_filter' });
      await expect(authorise('+442079460958', { outboundTrunkId: chargeableTrunkId }))
        .resolves.toMatchObject({ allowed: true });
      await Trunk.update({ outboundCallFilter: null }, { where: { id: chargeableTrunkId } });
    });

    test("the agent's filter may still narrow, never widen", async () => {
      await expect(authorise('+447700900123', {
        outboundTrunkId: chargeableTrunkId,
        agentOptions: { outboundCallFilter: '^\\+4420\\d+$' },
      })).resolves.toMatchObject({ allowed: false, code: 'agent_filter', chargeable: true });
    });

    test('a national-format destination is canonicalised before every check', async () => {
      await expect(authorise('07700900123', { outboundTrunkId: chargeableTrunkId }))
        .resolves.toMatchObject({ allowed: true, destination: '+447700900123' });
    });

    test('an undialable destination is refused outright', async () => {
      await expect(authorise('WebRTC', { outboundTrunkId: chargeableTrunkId }))
        .resolves.toMatchObject({ allowed: false, code: 'invalid_destination' });
      await expect(authoriseOutboundDestination({ calledId: '', organisationId: orgId }, NO_ENV))
        .resolves.toMatchObject({ allowed: false, code: 'invalid_destination' });
    });

    test('an org with no rate card cannot dial on our carrier at all', async () => {
      const unratedOrgId = randomUUID();
      unratedOrgIds.push(unratedOrgId);
      await Organisation.create({ id: unratedOrgId, name: 'Unrated Org', rateHistory: [] });
      const decision = await authoriseOutboundDestination({
        calledId: '+447700900123', organisationId: unratedOrgId,
        outboundTrunkId: chargeableTrunkId,
        agentOptions: { outboundCallFilter: WIDE_OPEN_FILTER },
      }, NO_ENV);
      expect(decision).toMatchObject({ allowed: false, code: 'not_rateable' });
      expect(decision.reason).toMatch(/no rate assigned/);
    });
  });

  describe('POST /api/agent-db/outbound-authorisation (the workers\' entry point)', () => {
    const mockLogger = {
      info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, child: () => mockLogger,
    };
    const req = (body = {}) => ({ body, params: {}, query: {}, headers: {}, log: mockLogger });
    const res = () => ({
      locals: { user: null }, _status: null, _body: null,
      status(c) { this._status = c; return this; },
      send(b) { this._body = b; this._status = this._status || 200; return this; },
    });
    let authorise;

    beforeAll(async () => {
      const mod = await import('../api/paths/agent-db/outbound-authorisation.js');
      authorise = mod.default(mockLogger, {}, {}).POST;
    });

    test('a refusal is a 200 decision, not an error — callers must distinguish it from "could not decide"', async () => {
      const s = res();
      await authorise(req({
        calledId: '+18005550199', organisationId: orgId, userId,
        outboundTrunkId: chargeableTrunkId,
        agentOptions: { outboundCallFilter: WIDE_OPEN_FILTER },
      }), s);
      expect(s._status).toBe(200);
      expect(s._body).toMatchObject({ allowed: false, code: 'trunk_filter' });
    });

    test('a missing destination is a 400', async () => {
      const s = res();
      await authorise(req({ organisationId: orgId }), s);
      expect(s._status).toBe(400);
    });

    test('an allowed destination reports the resolved tariff', async () => {
      const s = res();
      await authorise(req({
        calledId: '07700900123', organisationId: orgId, userId, outboundTrunkId: chargeableTrunkId,
      }), s);
      expect(s._body).toMatchObject({ allowed: true, destination: '+447700900123', tariff: tariffName });
    });
  });

  describe('helpers', () => {
    test('resolveEgressTrunk never charges a number on a registration trunk, even against the platform default', async () => {
      const regTrunkId = `${PREFIX}regtrunk`;
      await Trunk.create({ id: regTrunkId, name: 'Customer registration trunk', outbound: true, chargeable: false, flags: { provider: 'registration', registrationId: '11111111-2222-4333-8444-555555555555' } });
      try {
        const withDefault = { env: { APLISAY_OUTBOUND_TRUNK_ID: chargeableTrunkId } };
        const r = await resolveEgressTrunk({ aplisayId: regTrunkId }, withDefault);
        expect(r.chargeable).toBe(false);
        expect(r.trunk?.id).toBe(regTrunkId);
        // A plain BYO trunk still loses to the platform default, as before.
        const byo = await resolveEgressTrunk({ aplisayId: byoTrunkId }, withDefault);
        expect(byo.chargeable).toBe(true);
      } finally {
        await Trunk.destroy({ where: { id: regTrunkId } });
      }
    });

    test('resolveEgressTrunk prefers a chargeable trunk among the candidates', async () => {
      await expect(resolveEgressTrunk({ outboundTrunkId: byoTrunkId, aplisayId: chargeableTrunkId }, NO_ENV))
        .resolves.toMatchObject({ chargeable: true, trunk: expect.objectContaining({ id: chargeableTrunkId }) });
      await expect(resolveEgressTrunk({ aplisayId: byoTrunkId }, NO_ENV))
        .resolves.toMatchObject({ chargeable: false });
      await expect(resolveEgressTrunk({ aplisayId: 'no-such-trunk' }, NO_ENV))
        .resolves.toMatchObject({ chargeable: false, trunk: null });
    });

    test('isDestinationRateable mirrors the costing resolution', async () => {
      await expect(isDestinationRateable({ organisationId: orgId, userId, calledId: '+442079460958' }))
        .resolves.toMatchObject({ rateable: true, tariff: tariffName, prefix: '4420' });
      await expect(isDestinationRateable({ organisationId: orgId, userId, calledId: '+8801700000000' }))
        .resolves.toMatchObject({ rateable: false });
    });
  });
});
