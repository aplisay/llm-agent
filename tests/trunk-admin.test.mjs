import { setupRealDatabase, teardownRealDatabase, Trunk, Organisation, Op } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

/**
 * SuperAdmin trunk administration:
 *  - GET /api/trunks?scope=all → EVERY trunk with organisationIds (trunk:assign).
 *  - POST /api/trunks → create a trunk with an admin-supplied id (trunk:create).
 * Both are super-only; ordinary callers keep the org-scoped list and no create.
 */
describe('SuperAdmin trunk administration', () => {
  let listTrunks;
  let createTrunk;

  let orgId;
  let tag;

  const mockLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, child: () => mockLogger };
  const req = (data = {}) => ({ body: data.body || {}, params: data.params || {}, query: data.query || {}, headers: {}, log: mockLogger, ...data });
  const res = () => ({
    locals: { user: null },
    _status: null,
    _body: null,
    status(c) { this._status = c; return this; },
    send(b) { this._body = b; this._status = this._status || 200; return this; },
    json(b) { this._body = b; this._status = this._status || 200; return this; },
  });

  const superUser = () => ({ role: 'superAdmin' });
  const ownerUser = () => ({ role: 'owner', organisationId: orgId });

  beforeAll(async () => {
    await setupRealDatabase();
    const trunksModule = await import('../api/paths/trunks.js');
    listTrunks = trunksModule.default(mockLogger).GET;
    createTrunk = trunksModule.default(mockLogger).POST;
  }, 30000);

  afterAll(async () => { await teardownRealDatabase(); }, 60000);

  beforeEach(async () => {
    orgId = randomUUID();
    tag = orgId.slice(0, 8);
    await Organisation.create({ id: orgId, name: 'Trunk Admin Test Org' });
  });

  afterEach(async () => {
    await Trunk.destroy({ where: { id: { [Op.like]: `ta-${tag}-%` } } }).catch(() => {});
    await Organisation.destroy({ where: { id: orgId } });
  });

  const create = async (body, user = superUser()) => {
    const r = req({ body }); const s = res(); s.locals.user = user;
    await createTrunk(r, s); return s;
  };

  test('superAdmin creates a trunk with an admin-supplied id, provider and org assignment', async () => {
    const id = `ta-${tag}-carrier`;
    const s = await create({ id, name: 'Carrier', handler: 'jambonz', outbound: true, chargeable: true, provider: 'magrathea', organisationIds: [orgId] });
    expect(s._status).toBe(201);
    expect(s._body).toMatchObject({ id, name: 'Carrier', handler: 'jambonz', outbound: true, chargeable: true });
    expect(s._body.flags.provider).toBe('magrathea');
    expect(s._body.organisationIds).toEqual([orgId]);
    const row = await Trunk.findByPk(id);
    expect(row).toBeTruthy();
  });

  test('duplicate id is a 409', async () => {
    const id = `ta-${tag}-dup`;
    expect((await create({ id })). _status).toBe(201);
    expect((await create({ id })). _status).toBe(409);
  });

  test('a bad id is rejected', async () => {
    for (const id of ['', '   ', 'has space', '.startsdot', 'x'.repeat(129)]) {
      expect((await create({ id })). _status).toBe(400);
    }
  });

  test('an unknown handler is rejected', async () => {
    expect((await create({ id: `ta-${tag}-h`, handler: 'nope' })). _status).toBe(400);
  });

  test('a non-existent organisationId is rejected before any create', async () => {
    const id = `ta-${tag}-badorg`;
    const s = await create({ id, organisationIds: ['no-such-org'] });
    expect(s._status).toBe(400);
    expect(await Trunk.findByPk(id)).toBeNull();
  });

  test('a non-super caller cannot create a trunk', async () => {
    const s = await create({ id: `ta-${tag}-x` }, ownerUser());
    expect(s._status).toBe(403);
  });

  test('scope=all returns every trunk with organisationIds (superAdmin)', async () => {
    const a = `ta-${tag}-a`, b = `ta-${tag}-b`;
    await create({ id: a, chargeable: true, provider: 'magrathea' });
    await create({ id: b, organisationIds: [orgId] });

    const r = req({ query: { scope: 'all', pageSize: '200' } }); const s = res(); s.locals.user = superUser();
    await listTrunks(r, s);
    expect(s._status).toBe(200);
    const ids = s._body.items.map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining([a, b]));
    const bRow = s._body.items.find((t) => t.id === b);
    expect(bRow.organisationIds).toEqual([orgId]);
  });

  test('a non-super caller cannot use scope=all', async () => {
    const r = req({ query: { scope: 'all' } }); const s = res(); s.locals.user = ownerUser();
    await listTrunks(r, s);
    expect(s._status).toBe(403);
  });

  test('the default listing stays org-scoped (no cross-tenant leak)', async () => {
    const mine = `ta-${tag}-mine`, other = `ta-${tag}-other`;
    await create({ id: mine, organisationIds: [orgId] });
    await create({ id: other }); // assigned to nobody
    const r = req({ query: { pageSize: '200' } }); const s = res(); s.locals.user = ownerUser();
    await listTrunks(r, s);
    const ids = s._body.items.map((t) => t.id);
    expect(ids).toContain(mine);
    expect(ids).not.toContain(other);
  });
});
