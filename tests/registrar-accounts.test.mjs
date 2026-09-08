/**
 * Registrar accounts through the real route handlers against the test
 * database: create with minted credentials, the read shape, the immutable
 * identity on update, reveal and rotate, the bindings mirror, the trunk case,
 * and the partial unique index one realm per deployment relies on.
 *
 * Design: aplisay-strategy implementation/regserver-tactical-spec.md §2.
 */
import { setupRealDatabase, teardownRealDatabase, PhoneRegistration, User, Organisation, Trunk, Op } from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';

const REALM = 'sip.test.polite.ai';

describe('registrar accounts', () => {
  let testOrgId;
  let testUserId;
  const created = [];

  let createPhoneEndpoint;
  let listPhoneEndpoints;
  let getPhoneEndpoint;
  let updatePhoneEndpoint;
  let revealCredentials;
  let rotateCredentials;
  let getBindings;

  const mockLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {}, child: () => mockLogger };

  beforeAll(async () => {
    process.env.REGSERVER_REGISTRAR = REALM;
    await setupRealDatabase();

    const phoneEndpointsModule = await import('../api/paths/phone-endpoints.js');
    const identifierModule = await import('../api/paths/phone-endpoints/{identifier}.js');
    const credentialsModule = await import('../api/paths/phone-endpoints/{identifier}/credentials.js');
    const rotateModule = await import('../api/paths/phone-endpoints/{identifier}/credentials/rotate.js');
    const bindingsModule = await import('../api/paths/phone-endpoints/{identifier}/bindings.js');

    const phoneEndpoints = phoneEndpointsModule.default(mockLogger, {}, {});
    const identifier = identifierModule.default(mockLogger);
    createPhoneEndpoint = phoneEndpoints.POST;
    listPhoneEndpoints = phoneEndpoints.GET;
    getPhoneEndpoint = identifier.GET;
    updatePhoneEndpoint = identifier.PUT;
    revealCredentials = credentialsModule.default(mockLogger).GET;
    rotateCredentials = rotateModule.default(mockLogger).POST;
    getBindings = bindingsModule.default(mockLogger).GET;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    testOrgId = randomUUID();
    testUserId = randomUUID();
    await Organisation.create({ id: testOrgId, name: 'Registrar accounts test org' });
    await User.create({ id: testUserId, organisationId: testOrgId, name: 'Test User', email: `${testUserId}@example.com` });
  });

  afterEach(async () => {
    try {
      const rows = await PhoneRegistration.findAll({ where: { organisationId: testOrgId } });
      const trunkIds = rows.map((r) => r.trunkId).filter(Boolean);
      await PhoneRegistration.destroy({ where: { organisationId: testOrgId } });
      if (trunkIds.length) await Trunk.destroy({ where: { id: { [Op.in]: trunkIds } } });
      await User.destroy({ where: { id: testUserId } });
      await Organisation.destroy({ where: { id: testOrgId } });
    } catch (err) {
      // best effort
    }
    created.length = 0;
  });

  const req = (overrides = {}) => ({ body: {}, params: {}, query: {}, headers: {}, log: mockLogger, ...overrides });
  const res = (user) => ({
    _status: null,
    _body: null,
    _headers: {},
    locals: { user: user || { id: testUserId, role: 'owner', organisationId: testOrgId } },
    status(code) { this._status = code; return this; },
    send(data) { this._body = data; this._status = this._status || 200; return this; },
    json(data) { return this.send(data); },
    setHeader(k, v) { this._headers[k] = v; }
  });

  const createAccount = async (extra = {}) => {
    const r = res();
    await createPhoneEndpoint(req({ body: { type: 'phone-registration', mode: 'registrar', name: 'Office 3CX', ...extra } }), r);
    if (r._status === 201) created.push(r._body.id);
    return r;
  };

  test('creates an account with minted credentials, shown once', async () => {
    const r = await createAccount();
    expect(r._status).toBe(201);
    expect(r._body).toMatchObject({ success: true, mode: 'registrar', registrar: REALM, port: 5061, transport: 'tls', trunkId: null });
    expect(r._body.username).toMatch(/^pbx-[a-z2-7]{10}$/);
    expect(r._body.password).toMatch(/^[A-Za-z0-9]{24}$/);

    const row = await PhoneRegistration.findByPk(r._body.id);
    expect(row.mode).toBe('registrar');
    expect(row.kind).toBe('pbx');
    expect(row.registrar).toBe(REALM);
    expect(row.username).toBe(r._body.username);
    expect(row.password).toBe(r._body.password); // the getter decrypts
    expect(row.getDataValue('password')).not.toBe(r._body.password); // and it is sealed at rest
    expect(row.status).toBe('disabled');
    expect(row.state).toBe('initial');
    expect(row.b2buaId).toBeNull();
    expect(row.bindings).toBeNull();
  });

  test('refuses an identity supplied by the caller', async () => {
    const r = await createAccount({ registrar: 'sip.example.com', username: 'me', password: 'p' });
    expect(r._status).toBe(400);
    expect(r._body.details.join(' ')).toMatch(/registrar is issued by the platform/);

    const withNode = await createAccount({ b2buaId: '203.0.113.10' });
    expect(withNode._status).toBe(400);

    const device = await createAccount({ kind: 'device' });
    expect(device._status).toBe(400);
  });

  test('is unavailable on a deployment with no registrar configured', async () => {
    const saved = process.env.REGSERVER_REGISTRAR;
    delete process.env.REGSERVER_REGISTRAR;
    try {
      const r = await createAccount();
      expect(r._status).toBe(503);
      expect(r._body.code).toBe('registrar_unavailable');
    } finally {
      process.env.REGSERVER_REGISTRAR = saved;
    }
  });

  test('reads back with mode, kind and an empty bindings mirror, never the password', async () => {
    const createdRes = await createAccount();
    const r = res();
    await getPhoneEndpoint(req({ params: { identifier: createdRes._body.id } }), r);
    expect(r._status).toBe(200);
    expect(r._body).toMatchObject({ id: createdRes._body.id, mode: 'registrar', kind: 'pbx', registrar: REALM, bindings: [], bindingsUpdatedAt: null });
    expect(r._body.password).toBeUndefined();

    const list = res();
    await listPhoneEndpoints(req({ query: { type: 'phone-registration' } }), list);
    expect(list._status).toBe(200);
    const item = list._body.items.find((i) => i.id === createdRes._body.id);
    expect(item).toMatchObject({ mode: 'registrar', kind: 'pbx' });
    expect(item.password).toBeUndefined();
  });

  test('a client-mode line reads back as mode client with no bindings field', async () => {
    const r = res();
    await createPhoneEndpoint(req({ body: { type: 'phone-registration', name: 'Line', registrar: 'sip.example.com', username: 'u1', password: 'p1' } }), r);
    expect(r._status).toBe(201);
    expect(r._body.password).toBeUndefined();
    const g = res();
    await getPhoneEndpoint(req({ params: { identifier: r._body.id } }), g);
    expect(g._body.mode).toBe('client');
    expect(g._body.kind).toBeNull();
    expect(g._body.bindings).toBeUndefined();
  });

  test('the identity is immutable through PUT; other fields still update', async () => {
    const createdRes = await createAccount();
    const id = createdRes._body.id;

    for (const body of [{ password: 'new' }, { username: 'other' }, { registrar: 'sip.example.com' }, { b2buaId: 'lon1-1.sip.polite.ai' }]) {
      const r = res();
      await updatePhoneEndpoint(req({ params: { identifier: id }, body }), r);
      expect(r._status).toBe(400);
      expect(r._body.code).toBe('registrar_identity_immutable');
    }

    const modeChange = res();
    await updatePhoneEndpoint(req({ params: { identifier: id }, body: { mode: 'client' } }), modeChange);
    expect(modeChange._status).toBe(400);
    expect(modeChange._body.code).toBe('mode_immutable');

    const rename = res();
    await updatePhoneEndpoint(req({ params: { identifier: id }, body: { name: 'Renamed', options: { max_bindings: 2 } } }), rename);
    expect(rename._status).toBe(200);
    const row = await PhoneRegistration.findByPk(id);
    expect(row.name).toBe('Renamed');
    expect(row.options).toEqual({ max_bindings: 2 });
    expect(row.username).toBe(createdRes._body.username);
  });

  test('reveals and rotates the credentials, and refuses both for a line', async () => {
    const createdRes = await createAccount();
    const id = createdRes._body.id;

    const reveal = res();
    await revealCredentials(req({ params: { identifier: id } }), reveal);
    expect(reveal._status).toBe(200);
    expect(reveal._body).toEqual({ id, registrar: REALM, port: 5061, transport: 'tls', username: createdRes._body.username, password: createdRes._body.password });

    await PhoneRegistration.update({ state: 'registered' }, { where: { id } });
    const rotate = res();
    await rotateCredentials(req({ params: { identifier: id } }), rotate);
    expect(rotate._status).toBe(200);
    expect(rotate._body.username).toBe(createdRes._body.username);
    expect(rotate._body.password).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(rotate._body.password).not.toBe(createdRes._body.password);

    const row = await PhoneRegistration.findByPk(id);
    expect(row.password).toBe(rotate._body.password);
    expect(row.state).toBe('initial');
    expect(row.error).toBeNull();

    const line = res();
    await createPhoneEndpoint(req({ body: { type: 'phone-registration', name: 'Line', registrar: 'sip.example.com', username: 'u2', password: 'p2' } }), line);
    const lineReveal = res();
    await revealCredentials(req({ params: { identifier: line._body.id } }), lineReveal);
    expect(lineReveal._status).toBe(404);
    expect(lineReveal._body.code).toBe('not_registrar_account');
    const lineRotate = res();
    await rotateCredentials(req({ params: { identifier: line._body.id } }), lineRotate);
    expect(lineRotate._status).toBe(404);
  });

  test('refuses reveal to another organisation and to a caller without update', async () => {
    const createdRes = await createAccount();
    const other = res({ id: randomUUID(), role: 'owner', organisationId: randomUUID() });
    await revealCredentials(req({ params: { identifier: createdRes._body.id } }), other);
    expect(other._status).toBe(403);

    const reader = res({ id: testUserId, role: 'user', organisationId: testOrgId });
    await revealCredentials(req({ params: { identifier: createdRes._body.id } }), reader);
    expect(reader._status).toBe(403);
  });

  test('serves the bindings mirror the owning node wrote onto the row', async () => {
    const createdRes = await createAccount();
    const id = createdRes._body.id;
    const binding = {
      contact: 'sip:10000@192.168.1.10:5061;transport=tls',
      received: '203.0.113.7:51844',
      transport: 'tls',
      userAgent: '3CX Phone System 20.0.4.1',
      registeredAt: '2026-09-04T10:00:00.000Z',
      expiresAt: '2026-09-04T10:10:00.000Z',
      node: 'lon1-1.sip.polite.ai'
    };
    await PhoneRegistration.update(
      { b2buaId: 'lon1-1.sip.polite.ai', state: 'registered', bindings: [binding], bindingsUpdatedAt: new Date('2026-09-04T10:00:01Z') },
      { where: { id } }
    );

    const r = res();
    await getBindings(req({ params: { identifier: id }, query: {} }), r);
    expect(r._status).toBe(200);
    expect(r._body).toMatchObject({ registrationId: id, node: 'lon1-1.sip.polite.ai', live: false, bindings: [binding], bindingsUpdatedAt: '2026-09-04T10:00:01.000Z', fetchedAt: null });

    const g = res();
    await getPhoneEndpoint(req({ params: { identifier: id } }), g);
    expect(g._body.bindings).toEqual([binding]);
    expect(g._body.b2buaId).toBe('lon1-1.sip.polite.ai');
  });

  test('a registrar account can be a registration trunk', async () => {
    const r = await createAccount({ trunk: true, didSource: 'to', didCountry: 'gb' });
    expect(r._status).toBe(201);
    expect(r._body.trunkId).toBe(`reg-${r._body.id}`);
    const trunk = await Trunk.findByPk(r._body.trunkId);
    expect(trunk.flags).toMatchObject({ provider: 'registration', registrationId: r._body.id });
    const row = await PhoneRegistration.findByPk(r._body.id);
    expect(row.didSource).toBe('to');
    expect(row.didCountry).toBe('GB');
  });

  test('usernames are unique across the realm: the partial index refuses a duplicate', async () => {
    const first = await createAccount();
    const second = await createAccount();
    expect(first._body.username).not.toBe(second._body.username);

    const duplicate = PhoneRegistration.create({
      mode: 'registrar', kind: 'pbx', registrar: REALM, username: first._body.username, password: 'x',
      organisationId: testOrgId, status: 'disabled', state: 'initial'
    });
    await expect(duplicate).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });

    // A client-mode line may reuse the string: the index is partial.
    const line = await PhoneRegistration.create({
      mode: 'client', registrar: 'sip.example.com', username: first._body.username, password: 'x',
      organisationId: testOrgId, status: 'disabled', state: 'initial'
    });
    expect(line.id).toBeTruthy();
  });
});
