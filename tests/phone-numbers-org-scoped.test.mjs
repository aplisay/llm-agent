/**
 * Schema 61: a phone number's identity is (number, organisation), not the
 * number alone. Two organisations may each hold the same number on their own
 * trunks; one organisation may not hold it twice; one trunk may not carry it
 * twice; and every route addressed by number resolves to the caller's own row
 * (else the pool's), never to another organisation's.
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

const NUMBER = '442071234567';

describe('Phone numbers are organisation-scoped', () => {
  let createEndpoint;
  let getEndpoint;
  let agentDbList;
  let migrate;
  let org1;
  let org2;
  let trunk1;
  let trunk2;
  let carrier;

  const mockLogger = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child: () => mockLogger };

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    const collection = await import('../api/paths/phone-endpoints.js');
    const item = await import('../api/paths/phone-endpoints/{identifier}.js');
    const agentDb = await import('../api/paths/agent-db/phone-endpoints.js');
    ({ migratePhoneNumbersIdentity: migrate } = await import('../lib/database.js'));
    createEndpoint = collection.default(mockLogger, {}, {}).POST;
    getEndpoint = item.default(mockLogger, {}, {}).GET;
    agentDbList = agentDb.default(mockLogger, {}, {}).GET;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 30000);

  beforeEach(async () => {
    org1 = randomUUID();
    org2 = randomUUID();
    await Organisation.create({ id: org1, name: 'Org one' });
    await Organisation.create({ id: org2, name: 'Org two' });
    trunk1 = await Trunk.create({ id: `t1-${org1.slice(0, 8)}`, name: 'Org one PBX', handler: 'livekit' });
    await trunk1.addOrganisation(org1);
    trunk2 = await Trunk.create({ id: `t2-${org2.slice(0, 8)}`, name: 'Org two PBX', handler: 'livekit' });
    await trunk2.addOrganisation(org2);
    carrier = await Trunk.create({ id: `carrier-${org1.slice(0, 8)}`, name: 'Shared carrier', handler: 'livekit', chargeable: true });
  });

  afterEach(async () => {
    await PhoneNumber.destroy({ where: { number: NUMBER } });
    await Trunk.destroy({ where: { id: [trunk1.id, trunk2.id, carrier.id] } });
    await Organisation.destroy({ where: { id: [org1, org2] } });
  });

  const req = (extra = {}) => ({ params: {}, query: {}, body: {}, headers: {}, log: mockLogger, ...extra });
  const res = (organisationId) => {
    const r = {
      locals: { user: organisationId ? { role: 'owner', organisationId } : null },
      _status: null,
      _body: null,
      status(code) { this._status = code; return this; },
      send(body) { this._body = body; this._status = this._status || 200; return this; },
      json(body) { return this.send(body); },
      setHeader() { return this; },
    };
    return r;
  };

  const create = async (organisationId, trunkId) => {
    const r = res(organisationId);
    // The shared carrier trunk is chargeable, so its claims carry a reservation.
    const reservation = trunkId === carrier.id
      ? await NumberReservation.create({ number: NUMBER, trunkId, organisationId, expiresAt: new Date(Date.now() + 60000) })
      : null;
    await createEndpoint(req({ body: { type: 'e164-ddi', number: `+${NUMBER}`, trunkId, ...(reservation ? { reservationRef: reservation.id } : {}) } }), r);
    return r;
  };

  test('two organisations may each hold the same number on their own trunks', async () => {
    expect((await create(org1, trunk1.id))._status).toBe(201);
    expect((await create(org2, trunk2.id))._status).toBe(201);
    const rows = await PhoneNumber.findAll({ where: { number: NUMBER } });
    expect(rows.map((r) => r.organisationId).sort()).toEqual([org1, org2].sort());
    // Each row has its own surrogate id; the number is no longer the key.
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
  });

  test('an organisation may not hold the same number twice', async () => {
    expect((await create(org1, trunk1.id))._status).toBe(201);
    const again = await create(org1, trunk1.id);
    expect(again._status).toBe(409);
  });

  test('a shared trunk carries a number once, whichever organisation asks second', async () => {
    expect((await create(org1, carrier.id))._status).toBe(201);
    const second = await create(org2, carrier.id);
    expect(second._status).toBe(409);
    expect(second._body.error).toContain('trunk');
  });

  test('the unique indexes hold even when the pre-check is bypassed', async () => {
    await PhoneNumber.create({ number: NUMBER, handler: 'livekit', organisationId: org1, aplisayId: trunk1.id });
    await expect(
      PhoneNumber.create({ number: NUMBER, handler: 'livekit', organisationId: org1, aplisayId: trunk2.id }),
    ).rejects.toThrow(/unique|Validation/i);
    await expect(
      PhoneNumber.create({ number: NUMBER, handler: 'livekit', organisationId: org2, aplisayId: trunk1.id }),
    ).rejects.toThrow(/unique|Validation/i);
    // The pool holds a number once too: NULLs must not be treated as distinct.
    await PhoneNumber.create({ number: NUMBER, handler: 'livekit', organisationId: null, aplisayId: null });
    await expect(
      PhoneNumber.create({ number: NUMBER, handler: 'livekit', organisationId: null, aplisayId: null }),
    ).rejects.toThrow(/unique|Validation/i);
  });

  test('GET by number returns the caller’s own row, and another organisation’s is not found', async () => {
    await create(org1, trunk1.id);
    await create(org2, trunk2.id);
    const mine = res(org1);
    await getEndpoint(req({ params: { identifier: `+${NUMBER}` } }), mine);
    expect(mine._status).toBe(200);
    expect(mine._body.trunkId).toBe(trunk1.id);
    const theirs = res(org2);
    await getEndpoint(req({ params: { identifier: NUMBER } }), theirs);
    expect(theirs._status).toBe(200);
    expect(theirs._body.trunkId).toBe(trunk2.id);
    const nobody = res(randomUUID());
    await getEndpoint(req({ params: { identifier: NUMBER } }), nobody);
    expect(nobody._status).toBe(404);
  });

  test('a pool row is visible to any organisation that has no row of its own', async () => {
    await PhoneNumber.create({ number: NUMBER, handler: 'livekit', organisationId: null, aplisayId: carrier.id });
    await create(org1, trunk1.id);
    const own = res(org1);
    await getEndpoint(req({ params: { identifier: NUMBER } }), own);
    expect(own._body.trunkId).toBe(trunk1.id); // own row wins over the pool's
    const pool = res(org2);
    await getEndpoint(req({ params: { identifier: NUMBER } }), pool);
    expect(pool._status).toBe(200);
    expect(pool._body.trunkId).toBe(carrier.id);
  });

  test('the worker lookup selects by (number, trunk)', async () => {
    await create(org1, trunk1.id);
    await create(org2, trunk2.id);
    const r1 = res();
    await agentDbList(req({ query: { number: NUMBER, trunkId: trunk1.id } }), r1);
    expect(r1._status).toBe(200);
    expect(r1._body.items[0].organisationId).toBe(org1);
    const r2 = res();
    await agentDbList(req({ query: { number: NUMBER, trunkId: trunk2.id } }), r2);
    expect(r2._body.items[0].organisationId).toBe(org2);
    const r3 = res();
    await agentDbList(req({ query: { number: NUMBER, trunkId: carrier.id } }), r3);
    expect(r3._status).toBe(400);
    expect(r3._body.error).toContain('Trunk mismatch');
  });

  test('the migration moves a schema-60 table (number as primary key) to the new identity', async () => {
    const q = (sql) => PhoneNumber.sequelize.query(sql);
    // Rebuild the pre-61 shape: no surrogate id, number as the primary key,
    // none of the new indexes. The table must be empty of cross-org duplicates
    // for the old key to be re-creatable, which on the test database it is.
    await PhoneNumber.destroy({ where: {} });
    await q('DROP INDEX IF EXISTS "phone_numbers_number_organisation"');
    await q('DROP INDEX IF EXISTS "phone_numbers_number_pool"');
    await q('DROP INDEX IF EXISTS "phone_numbers_number_trunk"');
    await q('ALTER TABLE "phone_numbers" DROP CONSTRAINT IF EXISTS "phone_numbers_pkey"');
    await q('ALTER TABLE "phone_numbers" DROP COLUMN IF EXISTS "id"');
    await q('ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_pkey" PRIMARY KEY ("number")');
    await q(`INSERT INTO "phone_numbers" ("number", "handler", "organisation_id", "aplisay_id", "created_at", "updated_at")
             VALUES ('${NUMBER}', 'livekit', '${org1}', '${trunk1.id}', now(), now())`);

    await migrate();

    const [pk] = await q(
      `SELECT a.attname FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
        WHERE i.indrelid = 'public.phone_numbers'::regclass AND i.indisprimary`,
    );
    expect(pk.map((r) => r.attname)).toEqual(['id']);
    const [idx] = await q(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'phone_numbers' AND indexname LIKE 'phone_numbers_number_%' ORDER BY indexname`,
    );
    expect(idx.map((r) => r.indexname)).toEqual([
      'phone_numbers_number_organisation',
      'phone_numbers_number_pool',
      'phone_numbers_number_trunk',
    ]);
    // The existing row was given an id and is still addressable by number.
    const row = await PhoneNumber.findOne({ where: { number: NUMBER } });
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.organisationId).toBe(org1);
    // And the identity now permits what the old key forbade.
    expect((await create(org2, trunk2.id))._status).toBe(201);
  });

  test('the migration is idempotent on a database that already has the new identity', async () => {
    await create(org1, trunk1.id);
    await migrate();
    await migrate();
    const rows = await PhoneNumber.findAll({ where: { number: NUMBER } });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
