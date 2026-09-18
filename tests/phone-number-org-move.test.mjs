/**
 * Moving a number between organisations (PUT /phone-endpoints/{number} with
 * organisationId) is platform administration, and it is refused while the
 * number is attached to an agent: detach first, then move.
 */
import {
  setupRealDatabase,
  teardownRealDatabase,
  PhoneNumber,
  Organisation,
  Trunk,
  User,
  Agent,
  Instance,
  databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

describe('Moving a number between organisations', () => {
  let updateEndpoint;
  let org1;
  let org2;
  let carrier;
  let ownTrunk;
  let userId;
  let seq = 0;

  const mockLogger = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child: () => mockLogger };

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    const item = await import('../api/paths/phone-endpoints/{identifier}.js');
    updateEndpoint = item.default(mockLogger, {}, {}).PUT;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 30000);

  beforeEach(async () => {
    org1 = randomUUID();
    org2 = randomUUID();
    await Organisation.create({ id: org1, name: 'From org' });
    await Organisation.create({ id: org2, name: 'To org' });
    carrier = await Trunk.create({ id: `carrier-${org1.slice(0, 8)}`, name: 'Carrier', handler: 'livekit', chargeable: true });
    ownTrunk = await Trunk.create({ id: `own-${org1.slice(0, 8)}`, name: 'Own', handler: 'livekit', chargeable: false });
    await ownTrunk.addOrganisation(org1);
    userId = randomUUID();
    await User.create({
      id: userId, name: 'Mover', email: `mover-${userId.slice(0, 8)}@test.example.com`, emailVerified: true,
      phone: '+10000000000', phoneVerified: true, picture: '', role: 'owner', organisationId: org1,
    });
  });

  afterEach(async () => {
    await PhoneNumber.destroy({ where: { aplisayId: [carrier.id, ownTrunk.id] } });
    await Instance.destroy({ where: { organisationId: org1 } });
    await Agent.destroy({ where: { organisationId: org1 } });
    await User.destroy({ where: { id: userId } });
    await Trunk.destroy({ where: { id: [carrier.id, ownTrunk.id] } });
    await Organisation.destroy({ where: { id: [org1, org2] } });
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
  const superUser = () => ({ role: 'superAdmin' });
  const nextNumber = () => `4420796${String(10000 + seq++).slice(1)}`;

  const move = async (number, body, user = superUser()) => {
    const r = res(user);
    await updateEndpoint(req({ params: { identifier: `+${number}` }, body }), r);
    return r;
  };

  const attach = async (row) => {
    const agent = await Agent.create({
      name: 'Holder', description: 't', modelName: 'livekit:ultravox/ultravox-v0.7', prompt: 'p',
      options: {}, functions: {}, keys: [], userId, organisationId: org1,
    });
    const instance = await Instance.create({ agentId: agent.id, type: 'livekit', key: 'k', userId, organisationId: org1 });
    await row.update({ instanceId: instance.id });
    return instance;
  };

  test('an operator moves an unattached number to another organisation, and back to the pool', async () => {
    const number = nextNumber();
    await PhoneNumber.create({ number, handler: 'livekit', organisationId: org1, aplisayId: carrier.id });
    const moved = await move(number, { organisationId: org2, fromOrganisationId: org1 });
    expect(moved._status).toBe(200);
    expect(moved._body).toMatchObject({ success: true, organisationId: org2 });
    expect((await PhoneNumber.findOne({ where: { number } })).organisationId).toBe(org2);

    const pooled = await move(number, { organisationId: null, fromOrganisationId: org2 });
    expect(pooled._status).toBe(200);
    expect((await PhoneNumber.findOne({ where: { number } })).organisationId).toBeNull();

    // A pool row is the default source for an operator with no organisation.
    const adopted = await move(number, { organisationId: org1 });
    expect(adopted._status).toBe(200);
    expect((await PhoneNumber.findOne({ where: { number } })).organisationId).toBe(org1);
  });

  test('a number attached to an agent does not move until it is detached', async () => {
    const number = nextNumber();
    const row = await PhoneNumber.create({ number, handler: 'livekit', organisationId: org1, aplisayId: carrier.id });
    await attach(row);

    const refused = await move(number, { organisationId: org2, fromOrganisationId: org1 });
    expect(refused._status).toBe(409);
    expect(refused._body.code).toBe('number_in_use');
    expect((await PhoneNumber.findOne({ where: { number } })).organisationId).toBe(org1);

    await row.update({ instanceId: null });
    expect((await move(number, { organisationId: org2, fromOrganisationId: org1 }))._status).toBe(200);
  });

  test('the model refuses the move even when the API is bypassed', async () => {
    const number = nextNumber();
    const row = await PhoneNumber.create({ number, handler: 'livekit', organisationId: org1, aplisayId: carrier.id });
    await attach(row);
    await expect(row.update({ organisationId: org2 })).rejects.toMatchObject({ code: 'number_in_use' });
    // Attaching and moving in one write is the same move.
    const other = await PhoneNumber.create({ number: nextNumber(), handler: 'livekit', organisationId: org1, aplisayId: carrier.id });
    await expect(other.update({ organisationId: org2, instanceId: row.instanceId })).rejects.toMatchObject({ code: 'number_in_use' });
    // Changing something else on an attached number is fine. (Reload first:
    // a rejected update leaves the refused value dirty on the instance.)
    await row.reload();
    await expect(row.update({ outbound: true })).resolves.toBeTruthy();
  });

  test('organisation roles cannot move numbers; the ordinary update path ignores nothing silently', async () => {
    const number = nextNumber();
    await PhoneNumber.create({ number, handler: 'livekit', organisationId: org1, aplisayId: carrier.id });
    const owner = await move(number, { organisationId: org2 }, { role: 'owner', organisationId: org1 });
    expect(owner._status).toBe(403);
    const admin = await move(number, { organisationId: org2 }, { role: 'orgAdmin', organisationId: org1 });
    expect(admin._status).toBe(403);
    expect((await PhoneNumber.findOne({ where: { number } })).organisationId).toBe(org1);
  });

  test('the target must exist, must not already hold the number, and must be assigned the number’s customer trunk', async () => {
    const number = nextNumber();
    await PhoneNumber.create({ number, handler: 'livekit', organisationId: org1, aplisayId: carrier.id });
    expect((await move(number, { organisationId: randomUUID(), fromOrganisationId: org1 }))._status).toBe(404);
    expect((await move(number, { organisationId: 'nope', fromOrganisationId: org1 }))._status).toBe(400);
    expect((await move(nextNumber(), { organisationId: org2, fromOrganisationId: org1 }))._status).toBe(404);

    await PhoneNumber.create({ number, handler: 'livekit', organisationId: org2, aplisayId: ownTrunk.id });
    const clash = await move(number, { organisationId: org2, fromOrganisationId: org1 });
    expect(clash._status).toBe(409);
    expect(clash._body.code).toBeUndefined();

    const onOwn = nextNumber();
    await PhoneNumber.create({ number: onOwn, handler: 'livekit', organisationId: org1, aplisayId: ownTrunk.id });
    const outruns = await move(onOwn, { organisationId: org2, fromOrganisationId: org1 });
    expect(outruns._status).toBe(409);
    expect(outruns._body.error).toContain('trunk');
    await ownTrunk.addOrganisation(org2);
    expect((await move(onOwn, { organisationId: org2, fromOrganisationId: org1 }))._status).toBe(200);
  });
});
