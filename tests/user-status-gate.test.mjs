import { jest } from '@jest/globals';

/**
 * PATCH /api/users/{userId} — `status` transition gate (issues #215 / #216).
 *
 * `user:update` is held cross-tenant by the onboardingService principal, but
 * `status` is the soft-delete lever (DELETE sets status='deactivated'). Moving
 * ANOTHER tenant's user to a non-`active` status therefore requires `user:delete`;
 * `active` stays open (the onboarding accept seam), and an orgAdmin editing their
 * OWN org's users is unaffected.
 *
 * The provisional-org activation side-effect that rides on { status: 'active' } is
 * an organisation mutation, so it needs `organisation:update` in tenancy scope.
 */
const users = new Map();
const orgs = new Map();

jest.unstable_mockModule('../lib/database.js', () => ({
  User: { findByPk: async (id) => users.get(id) || null },
  Organisation: { findByPk: async (id) => orgs.get(id) || null },
}));

const { default: userItem } = await import('../api/paths/users/{userId}.js');

const mockLogger = { info() { }, error() { }, warn() { }, debug() { } };
const patch = userItem(mockLogger).PATCH;

const makeUser = (id, organisationId, extra = {}) => {
  const u = { id, organisationId, status: 'provisional', saved: false, ...extra };
  u.save = async () => { u.saved = true; };
  users.set(id, u);
  return u;
};

const makeOrg = (id, status = 'provisional') => {
  const org = { id, status, saved: false };
  org.save = async () => { org.saved = true; };
  orgs.set(id, org);
  return org;
};

const makeRes = () => ({
  locals: { user: null },
  _status: null,
  _body: null,
  status(code) { this._status = code; return this; },
  send(body) { this._body = body; this._status = this._status || 200; return this; },
  json(body) { this._body = body; this._status = this._status || 200; return this; },
});

const call = async ({ user, userId, body }) => {
  const req = { params: { userId }, body, log: mockLogger };
  const res = makeRes();
  res.locals.user = user;
  await patch(req, res);
  return res;
};

describe('user PATCH — cross-tenant status gate (#215)', () => {
  beforeEach(() => { users.clear(); orgs.clear(); });

  test('onboardingService may NOT deactivate another tenant\'s user (403)', async () => {
    const u = makeUser('u-1', 'org-target', { status: 'active' });
    const res = await call({
      user: { role: 'onboardingService', organisationId: null },
      userId: 'u-1',
      body: { status: 'deactivated' },
    });
    expect(res._status).toBe(403);
    expect(res._body.detail).toMatch(/user:delete/);
    expect(u.status).toBe('active');
    expect(u.saved).toBe(false);
  });

  test('suspension is gated the same way as deactivation', async () => {
    const u = makeUser('u-1', 'org-target', { status: 'active' });
    const res = await call({
      user: { role: 'onboardingService', organisationId: null },
      userId: 'u-1',
      body: { status: 'suspended' },
    });
    expect(res._status).toBe(403);
    expect(u.saved).toBe(false);
  });

  test('onboardingService may still ACTIVATE a user cross-tenant (the accept seam)', async () => {
    const u = makeUser('u-1', 'org-target');
    makeOrg('org-target');
    const res = await call({
      user: { role: 'onboardingService', organisationId: null },
      userId: 'u-1',
      body: { status: 'active' },
    });
    expect(res._status).toBe(200);
    expect(u.status).toBe('active');
  });

  // A self-signup user is auto-activated on first Firebase login (lib/database.js)
  // while their ORG stays provisional; the accept PATCH (or a retry of a partially
  // applied one) must still succeed and run the org side-effect.
  test('accept still works for an ALREADY-ACTIVE user whose org is provisional', async () => {
    const u = makeUser('u-1', 'org-target', { status: 'active' });
    const org = makeOrg('org-target');
    const res = await call({
      user: { role: 'onboardingService', organisationId: null },
      userId: 'u-1',
      body: { status: 'active' },
    });
    expect(res._status).toBe(200);
    expect(u.status).toBe('active');
    expect(org.status).toBe('active');
  });

  test('onboardingService may still edit a non-status field cross-tenant', async () => {
    const u = makeUser('u-1', 'org-target');
    const res = await call({
      user: { role: 'onboardingService', organisationId: null },
      userId: 'u-1',
      body: { name: 'Renamed' },
    });
    expect(res._status).toBe(200);
    expect(u.name).toBe('Renamed');
  });

  test('orgAdmin may deactivate a user in their OWN org', async () => {
    const u = makeUser('u-1', 'org-1', { status: 'active' });
    const res = await call({
      user: { id: 'admin-1', role: 'orgAdmin', organisationId: 'org-1' },
      userId: 'u-1',
      body: { status: 'deactivated' },
    });
    expect(res._status).toBe(200);
    expect(u.status).toBe('deactivated');
  });

  test('orgAdmin may NOT deactivate a user in another org (404 — out of scope)', async () => {
    const u = makeUser('u-1', 'org-2', { status: 'active' });
    const res = await call({
      user: { id: 'admin-1', role: 'orgAdmin', organisationId: 'org-1' },
      userId: 'u-1',
      body: { status: 'deactivated' },
    });
    expect(res._status).toBe(404);
    expect(u.saved).toBe(false);
  });

  test('superAdmin (holds user:delete) may deactivate cross-tenant', async () => {
    const u = makeUser('u-1', 'org-target', { status: 'active' });
    const res = await call({
      user: { id: 'su', role: 'superAdmin', organisationId: 'org-other' },
      userId: 'u-1',
      body: { status: 'deactivated' },
    });
    expect(res._status).toBe(200);
    expect(u.status).toBe('deactivated');
  });

  const svc = { id: 'svc', permissions: { user: ['read', 'readAll', 'update'] }, organisationId: 'org-me' };

  test('a readAll principal cannot launder the gate by first moving the user into its own org', async () => {
    const u = makeUser('u-1', 'org-target', { status: 'active' });
    // step 1: the org move itself is still allowed (user:readAll)
    const move = await call({ user: svc, userId: 'u-1', body: { organisationId: 'org-me' } });
    expect(move._status).toBe(200);
    expect(u.organisationId).toBe('org-me');
    // step 2: the status change is STILL cross-tenant (the actor holds user:readAll)
    const res = await call({ user: svc, userId: 'u-1', body: { status: 'deactivated' } });
    expect(res._status).toBe(403);
    expect(u.status).toBe('active');
  });

  test('a readAll principal cannot deactivate in the same request as the org move', async () => {
    const u = makeUser('u-1', 'org-me', { status: 'active' });
    const res = await call({
      user: svc, userId: 'u-1', body: { organisationId: 'org-me', status: 'deactivated' },
    });
    expect(res._status).toBe(403);
    expect(u.status).toBe('active');
  });

  test('a cross-tenant principal without user:delete cannot RE-activate a deactivated user', async () => {
    const u = makeUser('u-1', 'org-target', { status: 'deactivated' });
    const res = await call({
      user: { role: 'onboardingService', organisationId: null },
      userId: 'u-1',
      body: { status: 'active' },
    });
    expect(res._status).toBe(403);
    expect(u.status).toBe('deactivated');
    expect(u.saved).toBe(false);
  });

  test('...nor un-suspend a suspended user', async () => {
    const u = makeUser('u-1', 'org-target', { status: 'suspended' });
    const res = await call({
      user: { role: 'onboardingService', organisationId: null },
      userId: 'u-1',
      body: { status: 'active' },
    });
    expect(res._status).toBe(403);
    expect(u.status).toBe('suspended');
  });

  test('superAdmin may re-activate a deactivated user cross-tenant', async () => {
    const u = makeUser('u-1', 'org-target', { status: 'deactivated' });
    const res = await call({
      user: { id: 'su', role: 'superAdmin', organisationId: 'org-other' },
      userId: 'u-1',
      body: { status: 'active' },
    });
    expect(res._status).toBe(200);
    expect(u.status).toBe('active');
  });
});

describe('user PATCH — provisional-org activation side-effect (#216)', () => {
  beforeEach(() => { users.clear(); orgs.clear(); });

  test('onboardingService (holds organisation:update + readAll) still activates the provisional org', async () => {
    makeUser('u-1', 'org-target');
    const org = makeOrg('org-target');
    const res = await call({
      user: { role: 'onboardingService', organisationId: null },
      userId: 'u-1',
      body: { status: 'active' },
    });
    expect(res._status).toBe(200);
    expect(org.status).toBe('active');
    expect(org.saved).toBe(true);
  });

  test('a user-only cross-tenant principal activates the user but NOT the org', async () => {
    const u = makeUser('u-1', 'org-target');
    const org = makeOrg('org-target');
    const res = await call({
      user: { id: 'svc', permissions: { user: ['read', 'readAll', 'update'] }, organisationId: null },
      userId: 'u-1',
      body: { status: 'active' },
    });
    expect(res._status).toBe(200);
    expect(u.status).toBe('active');
    expect(org.status).toBe('provisional');
    expect(org.saved).toBe(false);
  });

  test('orgAdmin activating a user in their own provisional org still activates the org', async () => {
    makeUser('u-1', 'org-1');
    const org = makeOrg('org-1');
    const res = await call({
      user: { id: 'admin-1', role: 'orgAdmin', organisationId: 'org-1' },
      userId: 'u-1',
      body: { status: 'active' },
    });
    expect(res._status).toBe(200);
    expect(org.status).toBe('active');
  });

  test('an already-active org is left alone', async () => {
    makeUser('u-1', 'org-target');
    const org = makeOrg('org-target', 'active');
    await call({
      user: { role: 'onboardingService', organisationId: null },
      userId: 'u-1',
      body: { status: 'active' },
    });
    expect(org.saved).toBe(false);
  });
});
