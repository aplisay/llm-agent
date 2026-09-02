/**
 * Schema 63: a number claimed onto a CHARGEABLE trunk must present a
 * reservation minted under phoneEndpoint:reserve for that number, trunk and
 * organisation. The claim consumes it; a used, expired, mismatched or made-up
 * reference is refused. Operators holding trunk:create may claim without one.
 * Numbers on an organisation's own trunk need nothing.
 */
import {
  setupRealDatabase,
  teardownRealDatabase,
  PhoneNumber,
  NumberReservation,
  Organisation,
  Trunk,
  databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

describe('Number reservations', () => {
  let createEndpoint;
  let createReservation;
  let orgId;
  let otherOrgId;
  let carrierId;
  let ownTrunkId;
  let seq = 0;

  const mockLogger = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child: () => mockLogger };

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    const collection = await import('../api/paths/phone-endpoints.js');
    const reservations = await import('../api/paths/number-reservations.js');
    createEndpoint = collection.default(mockLogger, {}, {}).POST;
    createReservation = reservations.default(mockLogger).POST;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 30000);

  beforeEach(async () => {
    orgId = randomUUID();
    otherOrgId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Buyer org', chargeableNumberLimit: null });
    await Organisation.create({ id: otherOrgId, name: 'Other org', chargeableNumberLimit: null });
    carrierId = `carrier-${orgId.slice(0, 8)}`;
    await Trunk.create({ id: carrierId, name: 'Carrier', handler: 'livekit', outbound: true, chargeable: true });
    ownTrunkId = `own-${orgId.slice(0, 8)}`;
    const own = await Trunk.create({ id: ownTrunkId, name: 'Own', handler: 'livekit', chargeable: false });
    await own.addOrganisation(orgId);
  });

  afterEach(async () => {
    await PhoneNumber.destroy({ where: { aplisayId: [carrierId, ownTrunkId] } });
    await NumberReservation.destroy({ where: { trunkId: carrierId } });
    await Trunk.destroy({ where: { id: [carrierId, ownTrunkId] } });
    await Organisation.destroy({ where: { id: [orgId, otherOrgId] } });
  });

  const req = (extra = {}) => ({ params: {}, query: {}, body: {}, headers: {}, log: mockLogger, ...extra });
  const res = (user) => ({
    locals: { user },
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    send(body) { this._body = body; this._status = this._status || 200; return this; },
    json(body) { return this.send(body); },
  });
  const owner = (organisationId = orgId) => ({ role: 'owner', organisationId });
  const seam = () => ({ role: 'billingService', id: 'billing-key' });
  const superUser = () => ({ role: 'superAdmin' });
  const nextNumber = () => `+4420795${String(10000 + seq++).slice(1)}`;

  const reserve = async (body, user = seam()) => {
    const r = res(user);
    await createReservation(req({ body: { organisationId: orgId, trunkId: carrierId, ...body } }), r);
    return r;
  };
  const claim = async (body, user = owner()) => {
    const r = res(user);
    await createEndpoint(req({ body: { type: 'e164-ddi', trunkId: carrierId, ...body } }), r);
    return r;
  };

  test('the seam mints a reservation; an organisation role cannot', async () => {
    const number = nextNumber();
    const minted = await reserve({ number, provider: 'magrathea', carrierRef: { allocated: number } });
    expect(minted._status).toBe(201);
    expect(minted._body).toMatchObject({ number: number.slice(1), trunkId: carrierId, organisationId: orgId });
    expect(new Date(minted._body.expiresAt).getTime()).toBeGreaterThan(Date.now() + 10 * 60 * 1000);
    const row = await NumberReservation.findByPk(minted._body.id);
    expect(row.carrierRef).toEqual({ allocated: number });
    expect(row.createdBy).toBe('billing-key');

    expect((await reserve({ number: nextNumber() }, owner()))._status).toBe(403);
    expect((await reserve({ number: nextNumber() }, { role: 'orgAdmin', organisationId: orgId }))._status).toBe(403);
    expect((await reserve({ number: nextNumber() }, superUser()))._status).toBe(201);
  });

  test('a reservation needs a chargeable trunk, a real organisation and a valid number', async () => {
    expect((await reserve({ number: nextNumber(), trunkId: ownTrunkId }))._status).toBe(400);
    expect((await reserve({ number: nextNumber(), trunkId: 'no-such-trunk' }))._status).toBe(400);
    expect((await reserve({ number: nextNumber(), organisationId: randomUUID() }))._status).toBe(404);
    expect((await reserve({ number: 'not-a-number' }))._status).toBe(400);
    expect((await reserve({ number: nextNumber(), organisationId: 'nope' }))._status).toBe(400);
  });

  test('a claim onto a chargeable trunk without a reservation is refused; with one it succeeds and consumes it', async () => {
    const number = nextNumber();
    const bare = await claim({ number });
    expect(bare._status).toBe(403);
    expect(bare._body.code).toBe('reservation_required');
    expect(await PhoneNumber.count({ where: { aplisayId: carrierId } })).toBe(0);

    const minted = await reserve({ number });
    const ok = await claim({ number, reservationRef: minted._body.id, outbound: true });
    expect(ok._status).toBe(201);
    const created = await PhoneNumber.findOne({ where: { number: number.slice(1), organisationId: orgId } });
    expect(created.aplisayId).toBe(carrierId);
    const row = await NumberReservation.findByPk(minted._body.id);
    expect(row.consumedAt).toBeTruthy();
    expect(row.phoneNumberId).toBe(created.id);

    // Spent: the same reference cannot claim again (even after the number is released).
    await PhoneNumber.destroy({ where: { id: created.id } });
    const again = await claim({ number, reservationRef: minted._body.id });
    expect(again._status).toBe(403);
    expect(again._body.code).toBe('reservation_invalid');
  });

  test('a reservation is bound to its number, trunk and organisation', async () => {
    const number = nextNumber();
    const minted = await reserve({ number });
    const other = nextNumber();

    const wrongNumber = await claim({ number: other, reservationRef: minted._body.id });
    expect(wrongNumber._status).toBe(403);
    expect(wrongNumber._body.code).toBe('reservation_invalid');

    const wrongOrg = await claim({ number, reservationRef: minted._body.id }, owner(otherOrgId));
    expect(wrongOrg._status).toBe(403);
    expect(wrongOrg._body.code).toBe('reservation_invalid');

    const madeUp = await claim({ number, reservationRef: randomUUID() });
    expect(madeUp._status).toBe(403);
    expect(madeUp._body.code).toBe('reservation_invalid');

    const garbage = await claim({ number, reservationRef: 'not-a-uuid' });
    expect(garbage._status).toBe(403);
    expect(garbage._body.code).toBe('reservation_invalid');

    // Nothing above spent the ticket; the right claim still works.
    expect((await claim({ number, reservationRef: minted._body.id }))._status).toBe(201);
  });

  test('an expired reservation is refused', async () => {
    const number = nextNumber();
    const stale = await NumberReservation.create({
      number: number.slice(1), trunkId: carrierId, organisationId: orgId, expiresAt: new Date(Date.now() - 1000),
    });
    const r = await claim({ number, reservationRef: stale.id });
    expect(r._status).toBe(403);
    expect(r._body.code).toBe('reservation_invalid');
  });

  test('two claims racing on one reservation yield exactly one number', async () => {
    const number = nextNumber();
    const minted = await reserve({ number });
    // Different organisations cannot share a ticket, so race the same org on
    // the same number: the second claim is either the duplicate 409 or the
    // consumed-ticket 403, never a second row.
    const results = await Promise.all([
      claim({ number, reservationRef: minted._body.id }),
      claim({ number, reservationRef: minted._body.id }),
    ]);
    expect(results.filter((r) => r._status === 201)).toHaveLength(1);
    expect(results.filter((r) => r._status !== 201).every((r) => [403, 409].includes(r._status))).toBe(true);
    expect(await PhoneNumber.count({ where: { number: number.slice(1) } })).toBe(1);
  });

  test('operators may claim onto a chargeable trunk without a reservation; a presented one is still checked', async () => {
    const number = nextNumber();
    const byHand = await claim({ number }, { role: 'superAdmin', organisationId: orgId });
    expect(byHand._status).toBe(201);

    const bogus = await claim({ number: nextNumber(), reservationRef: randomUUID() }, { role: 'superAdmin', organisationId: orgId });
    expect(bogus._status).toBe(403);
    expect(bogus._body.code).toBe('reservation_invalid');
  });

  test("a number on the organisation's own trunk needs no reservation", async () => {
    const r = await claim({ number: nextNumber(), trunkId: ownTrunkId });
    expect(r._status).toBe(201);
  });
});
