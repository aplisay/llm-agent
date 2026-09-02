import { setupRealDatabase, teardownRealDatabase, PhoneNumber, Organisation, Trunk, NumberReservation } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * Organisation.chargeableNumberLimit — caps how many numbers an org may hold on
 * chargeable (non-owned, carrier) trunks. Enforced in createPhoneEndpoint;
 * numbers on the org's own (chargeable=false) trunks are never counted.
 * Reported by GET /api/number-quota; editable only via the superAdmin billing
 * policy action (organisation:setRate), NOT orgAdmin's setLimits.
 */
describe('Chargeable number limit', () => {
  let createPhoneEndpoint;
  let updatePhoneEndpoint;
  let getNumberQuota;
  let patchOrganisation;

  let orgId;
  let chargeableTrunkId;
  let ownTrunkId;
  let unique;
  let seq;

  const mockLogger = {
    info: () => { },
    error: () => { },
    warn: () => { },
    debug: () => { },
    child: () => mockLogger
  };

  const createMockRequest = (data = {}) => ({
    body: data.body || {},
    params: data.params || {},
    query: data.query || {},
    headers: data.headers || {},
    log: mockLogger,
    ...data
  });

  const createMockResponse = () => ({
    locals: { user: null },
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    send(body) { this._body = body; this._status = this._status || 200; return this; },
    json(body) { this._body = body; this._status = this._status || 200; return this; },
  });

  // Distinct E.164 numbers per test run (PhoneNumber PK is the number itself).
  const nextNumber = () => `+44${unique}${String(seq++).padStart(3, '0')}`;


  // Claims onto a chargeable trunk must present a reservation minted by the
  // carrier seam (schema 63); mint one per claim so these tests keep
  // exercising the limit, not the gate.
  const reserve = async (number, trunkId, organisationId) =>
    NumberReservation.create({ number: number.replace(/^\+/, ''), trunkId, organisationId, expiresAt: new Date(Date.now() + 60000) });

  const claim = async (trunkId, { user, number } = {}) => {
    const n = number || nextNumber();
    const u = user || { role: 'owner', organisationId: orgId };
    const reservation = trunkId === chargeableTrunkId ? await reserve(n, trunkId, u.organisationId) : null;
    const req = createMockRequest({ body: { type: 'e164-ddi', number: n, trunkId, ...(reservation ? { reservationRef: reservation.id } : {}) } });
    const res = createMockResponse();
    res.locals.user = u;
    await createPhoneEndpoint(req, res);
    return res;
  };

  beforeAll(async () => {
    await setupRealDatabase();
    const phoneEndpointsModule = await import('../api/paths/phone-endpoints.js');
    const identifierModule = await import('../api/paths/phone-endpoints/{identifier}.js');
    const quotaModule = await import('../api/paths/number-quota.js');
    const orgItemModule = await import('../api/paths/organisations/{organisationId}.js');
    createPhoneEndpoint = phoneEndpointsModule.default(mockLogger, {}, {}).POST;
    updatePhoneEndpoint = identifierModule.default(mockLogger, {}, {}).PUT;
    getNumberQuota = quotaModule.default(mockLogger).GET;
    patchOrganisation = orgItemModule.default(mockLogger).PATCH;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    orgId = randomUUID();
    // 9 unique digits: 3300 + 5 random; nextNumber appends 3 more (12 digits total).
    unique = `3300${String(Math.floor(Math.random() * 90000) + 10000)}`;
    seq = 0;
    await Organisation.create({ id: orgId, name: 'Chargeable Limit Test Org' });

    chargeableTrunkId = `test-chargeable-${orgId.slice(0, 8)}`;
    const chargeableTrunk = await Trunk.create({
      id: chargeableTrunkId,
      name: 'Shared carrier trunk (we pay)',
      handler: 'livekit',
      outbound: false,
      chargeable: true
    });
    await chargeableTrunk.addOrganisation(orgId);

    ownTrunkId = `test-own-${orgId.slice(0, 8)}`;
    const ownTrunk = await Trunk.create({
      id: ownTrunkId,
      name: 'Customer BYO trunk',
      handler: 'livekit',
      outbound: false,
      chargeable: false
    });
    await ownTrunk.addOrganisation(orgId);
  });

  afterEach(async () => {
    await PhoneNumber.destroy({ where: { organisationId: orgId } });
    await Trunk.destroy({ where: { id: [chargeableTrunkId, ownTrunkId] } });
    await Organisation.destroy({ where: { id: orgId } });
  });

  test('defaults to 3 on new organisations', async () => {
    const org = await Organisation.findByPk(orgId);
    expect(org.chargeableNumberLimit).toBe(3);
  });

  test('allows claims up to the limit on a chargeable trunk, rejects the next', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await claim(chargeableTrunkId);
      expect(res._status).toBe(201);
      expect(res._body).toHaveProperty('success', true);
    }
    const rejected = await claim(chargeableTrunkId);
    expect(rejected._status).toBe(403);
    expect(rejected._body).toMatchObject({
      code: 'chargeable_number_limit',
      limit: 3,
      used: 3
    });
  });

  test("never counts or limits numbers on the org's own (non-chargeable) trunks", async () => {
    // Well over the limit on the org's own trunk — all fine.
    for (let i = 0; i < 5; i++) {
      const res = await claim(ownTrunkId);
      expect(res._status).toBe(201);
    }
    // The chargeable allowance is untouched by those.
    for (let i = 0; i < 3; i++) {
      const res = await claim(chargeableTrunkId);
      expect(res._status).toBe(201);
    }
    const rejected = await claim(chargeableTrunkId);
    expect(rejected._status).toBe(403);
    expect(rejected._body.code).toBe('chargeable_number_limit');
  });

  test('null limit means unlimited', async () => {
    await Organisation.update({ chargeableNumberLimit: null }, { where: { id: orgId } });
    for (let i = 0; i < 5; i++) {
      const res = await claim(chargeableTrunkId);
      expect(res._status).toBe(201);
    }
  });

  test('zero limit blocks all chargeable claims', async () => {
    await Organisation.update({ chargeableNumberLimit: 0 }, { where: { id: orgId } });
    const rejected = await claim(chargeableTrunkId);
    expect(rejected._status).toBe(403);
    expect(rejected._body).toMatchObject({ code: 'chargeable_number_limit', limit: 0, used: 0 });
  });

  test('number-quota reports limit / used / remaining for the caller org', async () => {
    await claim(chargeableTrunkId);
    // A number on the org's own trunk must not appear in `used`.
    await claim(ownTrunkId);

    const req = createMockRequest();
    const res = createMockResponse();
    res.locals.user = { role: 'owner', organisationId: orgId };
    await getNumberQuota(req, res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ limit: 3, used: 1, remaining: 2 });
  });

  test('number-quota reports unlimited as null limit/remaining', async () => {
    await Organisation.update({ chargeableNumberLimit: null }, { where: { id: orgId } });
    const req = createMockRequest();
    const res = createMockResponse();
    res.locals.user = { role: 'owner', organisationId: orgId };
    await getNumberQuota(req, res);
    expect(res._status).toBe(200);
    expect(res._body).toEqual({ limit: null, used: 0, remaining: null });
  });

  test('number-quota requires an organisation', async () => {
    const req = createMockRequest();
    const res = createMockResponse();
    res.locals.user = { role: 'owner' };
    await getNumberQuota(req, res);
    expect(res._status).toBe(403);
  });

  test('orgAdmin cannot raise their own chargeableNumberLimit (spend policy, not capacity)', async () => {
    const req = createMockRequest({
      params: { organisationId: orgId },
      body: { chargeableNumberLimit: 100 }
    });
    const res = createMockResponse();
    res.locals.user = { role: 'orgAdmin', organisationId: orgId };
    await patchOrganisation(req, res);
    expect(res._status).toBe(403);

    const org = await Organisation.findByPk(orgId);
    expect(org.chargeableNumberLimit).toBe(3);
  });

  test('superAdmin can set chargeableNumberLimit', async () => {
    const req = createMockRequest({
      params: { organisationId: orgId },
      body: { chargeableNumberLimit: 5 }
    });
    const res = createMockResponse();
    res.locals.user = { role: 'superAdmin', organisationId: randomUUID() };
    await patchOrganisation(req, res);
    expect(res._status).toBe(200);

    const org = await Organisation.findByPk(orgId);
    expect(org.chargeableNumberLimit).toBe(5);

    // And the raised limit is live for claims.
    for (let i = 0; i < 5; i++) {
      const claimed = await claim(chargeableTrunkId);
      expect(claimed._status).toBe(201);
    }
    const rejected = await claim(chargeableTrunkId);
    expect(rejected._status).toBe(403);
  });

  test('provisioned is settable via PUT once carrier work completes', async () => {
    const number = nextNumber();
    const created = await claim(chargeableTrunkId, { number });
    expect(created._status).toBe(201);

    const req = createMockRequest({
      params: { identifier: number },
      body: { provisioned: true }
    });
    const res = createMockResponse();
    res.locals.user = { role: 'owner', organisationId: orgId };
    await updatePhoneEndpoint(req, res);
    expect(res._status).toBe(200);

    const row = await PhoneNumber.findOne({ where: { number: number.replace(/^\+/, '') } });
    expect(row.provisioned).toBe(true);

    // Bad type is rejected.
    const badReq = createMockRequest({
      params: { identifier: number },
      body: { provisioned: 'yes' }
    });
    const badRes = createMockResponse();
    badRes.locals.user = { role: 'owner', organisationId: orgId };
    await updatePhoneEndpoint(badReq, badRes);
    expect(badRes._status).toBe(400);
  });

  test('concurrent claims cannot race past the limit', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, () => claim(chargeableTrunkId))
    );
    const created = results.filter((r) => r._status === 201);
    const rejected = results.filter((r) => r._status === 403);
    expect(created.length).toBe(3);
    expect(rejected.length).toBe(3);
  });
});
