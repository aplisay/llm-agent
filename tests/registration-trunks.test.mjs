/**
 * Schema 62: a phone-registration created with `trunk: true` owns a trunks
 * row that numbers attach to. The registration is never attached to an agent
 * itself; its numbers are. Turning a trunk back into a line, or deleting it,
 * is refused while numbers still sit on it.
 */
import {
  setupRealDatabase,
  teardownRealDatabase,
  PhoneNumber,
  PhoneRegistration,
  Organisation,
  Trunk,
  databaseStarted,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

describe('Registration trunks', () => {
  let createEndpoint;
  let getEndpoint;
  let updateEndpoint;
  let deleteEndpoint;
  let agentDbList;
  let orgId;

  const mockLogger = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child: () => mockLogger };

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    const collection = await import('../api/paths/phone-endpoints.js');
    const item = await import('../api/paths/phone-endpoints/{identifier}.js');
    const agentDb = await import('../api/paths/agent-db/phone-endpoints.js');
    createEndpoint = collection.default(mockLogger, {}, {}).POST;
    const handlers = item.default(mockLogger, {}, {});
    getEndpoint = handlers.GET;
    updateEndpoint = handlers.PUT;
    deleteEndpoint = handlers.DELETE;
    agentDbList = agentDb.default(mockLogger, {}, {}).GET;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 30000);

  beforeEach(async () => {
    orgId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Trunk org' });
  });

  afterEach(async () => {
    const regs = await PhoneRegistration.findAll({ where: { organisationId: orgId } });
    const trunkIds = regs.map((r) => r.trunkId).filter(Boolean);
    await PhoneNumber.destroy({ where: { organisationId: orgId } });
    await PhoneRegistration.destroy({ where: { organisationId: orgId } });
    if (trunkIds.length) await Trunk.destroy({ where: { id: trunkIds } });
    await Trunk.destroy({ where: { id: 'migrated-sbc-trunk' } });
    await Organisation.destroy({ where: { id: orgId } });
  });

  const req = (extra = {}) => ({ params: {}, query: {}, body: {}, headers: {}, log: mockLogger, ...extra });
  const res = (user) => ({
    locals: { user },
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    send(body) { this._body = body; this._status = this._status || 200; return this; },
    json(body) { return this.send(body); },
    setHeader() { return this; },
  });
  const owner = () => ({ role: 'owner', organisationId: orgId });
  const superUser = () => ({ role: 'superAdmin', organisationId: orgId });

  const create = async (user, body) => {
    const r = res(user);
    await createEndpoint(
      req({ body: { type: 'phone-registration', registrar: 'pbx.example.com', username: `u${Math.random().toString(36).slice(2, 8)}`, password: 'pw', handler: 'pipecat', ...body } }),
      r,
    );
    return r;
  };

  test('a plain registration owns no trunk', async () => {
    const r = await create(owner(), {});
    expect(r._status).toBe(201);
    expect(r._body.trunkId).toBeNull();
    const g = res(owner());
    await getEndpoint(req({ params: { identifier: r._body.id } }), g);
    expect(g._body.trunk).toBe(false);
  });

  test('trunk: true creates the trunk, assigns it to the org and copies handler and outbound', async () => {
    const r = await create(owner(), { trunk: true, outbound: true, didSource: 'header:P-Called-Party-ID', didCountry: 'gb' });
    expect(r._status).toBe(201);
    expect(r._body.trunkId).toBe(`reg-${r._body.id}`);
    const trunk = await Trunk.findByPk(r._body.trunkId);
    expect(trunk).toMatchObject({ handler: 'pipecat', outbound: true, chargeable: false });
    expect(trunk.flags).toEqual({ provider: 'registration', registrationId: r._body.id });
    expect(await trunk.hasOrganisation(orgId)).toBe(true);
    const g = res(owner());
    await getEndpoint(req({ params: { identifier: r._body.id } }), g);
    expect(g._body).toMatchObject({ trunk: true, trunkId: r._body.trunkId, didSource: 'header:P-Called-Party-ID', didCountry: 'GB' });
  });

  test('numbers attach to the trunk through the ordinary e164-ddi path', async () => {
    const r = await create(owner(), { trunk: true });
    const n = res(owner());
    await createEndpoint(req({ body: { type: 'e164-ddi', number: '+442079460100', trunkId: r._body.trunkId } }), n);
    expect(n._status).toBe(201);
    const row = await PhoneNumber.findOne({ where: { number: '442079460100', organisationId: orgId } });
    expect(row.aplisayId).toBe(r._body.trunkId);
    expect(row.handler).toBe('pipecat');
    // The worker's lookup by (number, trunk) finds it.
    const w = res();
    await agentDbList(req({ query: { number: '442079460100', trunkId: r._body.trunkId } }), w);
    expect(w._status).toBe(200);
    expect(w._body.items[0].trunk.flags.registrationId).toBe(r._body.id);
  });

  test('naming the trunk needs trunk:create; a super migrating an SBC trunk keeps its id', async () => {
    const denied = await create(owner(), { trunk: true, trunkId: 'migrated-sbc-trunk' });
    expect(denied._status).toBe(403);
    const named = await create(superUser(), { trunk: true, trunkId: 'migrated-sbc-trunk' });
    expect(named._status).toBe(201);
    expect(named._body.trunkId).toBe('migrated-sbc-trunk');
    const again = await create(superUser(), { trunk: true, trunkId: 'migrated-sbc-trunk' });
    expect(again._status).toBe(409);
  });

  test('trunkId without trunk: true, and a bad didSource, are rejected', async () => {
    expect((await create(superUser(), { trunkId: 'x' }))._status).toBe(400);
    expect((await create(owner(), { didSource: 'nonsense' }))._status).toBe(400);
    expect((await create(owner(), { didCountry: 'GBR' }))._status).toBe(400);
  });

  test('a line becomes a trunk on PUT, and a trunk mirrors handler and outbound changes', async () => {
    const r = await create(owner(), {});
    const u = res(owner());
    await updateEndpoint(req({ params: { identifier: r._body.id }, body: { trunk: true } }), u);
    expect(u._status).toBe(200);
    const reg = await PhoneRegistration.findByPk(r._body.id);
    expect(reg.trunkId).toBe(`reg-${r._body.id}`);
    const u2 = res(owner());
    await updateEndpoint(req({ params: { identifier: r._body.id }, body: { outbound: true, handler: 'livekit' } }), u2);
    expect(u2._status).toBe(200);
    const trunk = await Trunk.findByPk(reg.trunkId);
    expect(trunk).toMatchObject({ outbound: true, handler: 'livekit' });
  });

  test('a trunk with numbers cannot become a line or be deleted; an empty one can', async () => {
    const r = await create(owner(), { trunk: true });
    const n = res(owner());
    await createEndpoint(req({ body: { type: 'e164-ddi', number: '+442079460101', trunkId: r._body.trunkId } }), n);
    expect(n._status).toBe(201);

    const off = res(owner());
    await updateEndpoint(req({ params: { identifier: r._body.id }, body: { trunk: false } }), off);
    expect(off._status).toBe(409);
    const del = res(owner());
    await deleteEndpoint(req({ params: { identifier: r._body.id } }), del);
    expect(del._status).toBe(409);

    await PhoneNumber.destroy({ where: { number: '442079460101', organisationId: orgId } });
    const off2 = res(owner());
    await updateEndpoint(req({ params: { identifier: r._body.id }, body: { trunk: false } }), off2);
    expect(off2._status).toBe(200);
    expect(await Trunk.findByPk(r._body.trunkId)).toBeNull();
    expect((await PhoneRegistration.findByPk(r._body.id)).trunkId).toBeNull();
  });

  test('deleting an empty trunk registration removes its trunk row too', async () => {
    const r = await create(owner(), { trunk: true });
    const del = res(owner());
    await deleteEndpoint(req({ params: { identifier: r._body.id } }), del);
    expect(del._status).toBe(200);
    expect(await Trunk.findByPk(r._body.trunkId)).toBeNull();
    const [[joins]] = await Trunk.sequelize.query('SELECT count(*)::int AS n FROM trunk_organisations WHERE trunk_id = $1', { bind: [r._body.trunkId] });
    expect(joins.n).toBe(0);
  });

  test('the worker lookup by registration id reports the trunk', async () => {
    const r = await create(owner(), { trunk: true });
    const w = res();
    await agentDbList(req({ query: { id: r._body.id } }), w);
    expect(w._status).toBe(200);
    expect(w._body.items[0].trunkId).toBe(r._body.trunkId);
    expect(w._body.items[0].instanceId ?? null).toBeNull();
  });
});
