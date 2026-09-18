import { setupRealDatabase, teardownRealDatabase, PhoneNumber, Organisation, Trunk, NumberReservation } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * Chargeable trunks are shared PLATFORM carrier trunks: organisations consume
 * but do not own them (no TrunkOrganisation row). So createPhoneEndpoint must
 * let any org allocate onto a chargeable trunk regardless of association, while
 * still requiring ownership for non-chargeable BYO trunks. The Buy-number flow
 * discovers them via GET /api/trunks?chargeable=true (global) and matches the
 * carrier by flags.provider, which superAdmin sets via PATCH /api/trunks/{id}.
 */
describe('Chargeable trunks are global (not org-owned)', () => {
  let createPhoneEndpoint;
  let listTrunks;
  let patchTrunk;

  let orgId;
  let otherOrgId;
  let chargeableTrunkId;
  let byoTrunkId;
  let unique;
  let seq;

  const mockLogger = {
    info: () => { }, error: () => { }, warn: () => { }, debug: () => { }, child: () => mockLogger,
  };

  const req = (data = {}) => ({ body: data.body || {}, params: data.params || {}, query: data.query || {}, headers: {}, log: mockLogger, ...data });
  const res = () => ({
    locals: { user: null },
    _status: null,
    _body: null,
    status(c) { this._status = c; return this; },
    send(b) { this._body = b; this._status = this._status || 200; return this; },
    json(b) { this._body = b; this._status = this._status || 200; return this; },
  });

  const nextNumber = () => `+44${unique}${String(seq++).padStart(3, '0')}`;


  // Claims onto a chargeable trunk must present a reservation minted by the
  // carrier seam (schema 63); mint one per claim so these tests keep
  // exercising the limit, not the gate.
  const reserve = async (number, trunkId, organisationId) =>
    NumberReservation.create({ number: number.replace(/^\+/, ''), trunkId, organisationId, expiresAt: new Date(Date.now() + 60000) });

  const claim = async (trunkId, { user, number } = {}) => {
    const n = number || nextNumber();
    const u = user || { role: 'owner', organisationId: orgId };
    const reservation = trunkId === chargeableTrunkId && u.organisationId ? await reserve(n, trunkId, u.organisationId) : null;
    const r = req({ body: { type: 'e164-ddi', number: n, trunkId, ...(reservation ? { reservationRef: reservation.id } : {}) } });
    const s = res();
    s.locals.user = u;
    await createPhoneEndpoint(r, s);
    return s;
  };

  beforeAll(async () => {
    await setupRealDatabase();
    const phoneEndpointsModule = await import('../api/paths/phone-endpoints.js');
    const trunksModule = await import('../api/paths/trunks.js');
    const trunkItemModule = await import('../api/paths/trunks/{trunkId}.js');
    createPhoneEndpoint = phoneEndpointsModule.default(mockLogger, {}, {}).POST;
    listTrunks = trunksModule.default(mockLogger).GET;
    patchTrunk = trunkItemModule.default(mockLogger).PATCH;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    orgId = randomUUID();
    otherOrgId = randomUUID();
    unique = `3301${String(Math.floor(Math.random() * 90000) + 10000)}`;
    seq = 0;
    await Organisation.create({ id: orgId, name: 'Consuming Org' });
    await Organisation.create({ id: otherOrgId, name: 'Other Org' });

    // A GLOBAL chargeable trunk — deliberately NOT associated with any org.
    chargeableTrunkId = `test-global-chargeable-${orgId.slice(0, 8)}`;
    await Trunk.create({
      id: chargeableTrunkId,
      name: 'Aplisay carrier (Magrathea)',
      handler: 'jambonz',
      outbound: false,
      chargeable: true,
      flags: { provider: 'magrathea' },
    });

    // A non-chargeable BYO trunk owned by `otherOrgId` (NOT our org).
    byoTrunkId = `test-byo-${orgId.slice(0, 8)}`;
    const byo = await Trunk.create({
      id: byoTrunkId, name: 'Someone else PBX', handler: 'livekit', outbound: false, chargeable: false,
    });
    await byo.addOrganisation(otherOrgId);
  });

  afterEach(async () => {
    await PhoneNumber.destroy({ where: { organisationId: [orgId, otherOrgId] } });
    await Trunk.destroy({ where: { id: [chargeableTrunkId, byoTrunkId] } });
    await Organisation.destroy({ where: { id: [orgId, otherOrgId] } });
  });

  test('an org with NO trunk assignments can allocate onto a global chargeable trunk', async () => {
    const s = await claim(chargeableTrunkId);
    expect(s._status).toBe(201);
    expect(s._body).toMatchObject({ success: true, trunkId: chargeableTrunkId });
    const row = await PhoneNumber.findOne({ where: { number: s._body.number } });
    expect(row.organisationId).toBe(orgId);
    expect(row.aplisayId).toBe(chargeableTrunkId);
    // Handler is derived from the trunk (routes the number to the right ingress).
    expect(row.handler).toBe('jambonz');
  });

  test('a non-chargeable trunk the org does NOT own is still rejected', async () => {
    const s = await claim(byoTrunkId);
    expect(s._status).toBe(400);
    expect(s._body.error).toMatch(/not associated with your organisation/i);
  });

  test('an unknown trunk is rejected as not found', async () => {
    const s = await claim(`no-such-trunk-${orgId.slice(0, 8)}`);
    expect(s._status).toBe(400);
    expect(s._body.error).toMatch(/not found/i);
  });

  test('a non-chargeable trunk the org DOES own still works (regression)', async () => {
    const ownTrunkId = `test-own-${orgId.slice(0, 8)}`;
    const own = await Trunk.create({ id: ownTrunkId, name: 'My PBX', handler: 'livekit', outbound: false, chargeable: false });
    await own.addOrganisation(orgId);
    try {
      const s = await claim(ownTrunkId);
      expect(s._status).toBe(201);
    } finally {
      await PhoneNumber.destroy({ where: { aplisayId: ownTrunkId } });
      await Trunk.destroy({ where: { id: ownTrunkId } });
    }
  });

  test('GET /trunks?chargeable=true returns the global chargeable trunk with its provider, for an org that owns nothing', async () => {
    const r = req({ query: { chargeable: 'true' } });
    const s = res();
    s.locals.user = { role: 'owner', organisationId: orgId };
    await listTrunks(r, s);
    expect(s._status).toBe(200);
    const mine = s._body.items.find((t) => t.id === chargeableTrunkId);
    expect(mine).toBeTruthy();
    expect(mine.chargeable).toBe(true);
    expect(mine.flags?.provider).toBe('magrathea');
    // The default org-scoped listing must NOT surface it (org owns no trunks).
    const r2 = req({ query: {} });
    const s2 = res();
    s2.locals.user = { role: 'owner', organisationId: orgId };
    await listTrunks(r2, s2);
    expect(s2._body.items.find((t) => t.id === chargeableTrunkId)).toBeFalsy();
  });

  test('chargeable is honoured as a COERCED boolean (as express-openapi delivers it), not just the string', async () => {
    // In the running app the `chargeable` query param is declared type:boolean,
    // so it arrives as the boolean `true`, not the string 'true'. A non-super
    // org owning nothing must STILL get the global chargeable trunk — otherwise
    // it silently falls through to the empty org-scoped list (the staging bug).
    const r = req({ query: { chargeable: true } });
    const s = res();
    s.locals.user = { role: 'owner', organisationId: otherOrgId }; // owns nothing chargeable
    await listTrunks(r, s);
    expect(s._status).toBe(200);
    expect(s._body.items.find((t) => t.id === chargeableTrunkId)).toBeTruthy();
  });

  test('superAdmin can set and clear flags.provider on a trunk', async () => {
    const set = res();
    set.locals.user = { role: 'superAdmin' };
    await patchTrunk(req({ params: { trunkId: chargeableTrunkId }, body: { provider: 'gamma' } }), set);
    expect(set._status).toBe(200);
    expect(set._body.flags.provider).toBe('gamma');

    const cleared = res();
    cleared.locals.user = { role: 'superAdmin' };
    await patchTrunk(req({ params: { trunkId: chargeableTrunkId }, body: { provider: null } }), cleared);
    expect(cleared._status).toBe(200);
    expect(cleared._body.flags?.provider ?? null).toBeNull();
  });

  test('setting provider does not disturb other flags', async () => {
    await Trunk.update({ flags: { host: 'sbc.aplisay.net', provider: 'magrathea' } }, { where: { id: chargeableTrunkId } });
    const s = res();
    s.locals.user = { role: 'superAdmin' };
    await patchTrunk(req({ params: { trunkId: chargeableTrunkId }, body: { provider: 'twilio' } }), s);
    expect(s._status).toBe(200);
    expect(s._body.flags).toMatchObject({ host: 'sbc.aplisay.net', provider: 'twilio' });
  });

  test('a non-super caller cannot set provider', async () => {
    const s = res();
    s.locals.user = { role: 'owner', organisationId: orgId };
    await patchTrunk(req({ params: { trunkId: chargeableTrunkId }, body: { provider: 'x' } }), s);
    expect(s._status).toBe(403);
  });

  test('provider of the wrong type is rejected', async () => {
    const s = res();
    s.locals.user = { role: 'superAdmin' };
    await patchTrunk(req({ params: { trunkId: chargeableTrunkId }, body: { provider: 123 } }), s);
    expect(s._status).toBe(400);
  });
});
