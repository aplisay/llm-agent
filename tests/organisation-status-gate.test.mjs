import { jest } from '@jest/globals';

/**
 * PATCH /api/organisations/{organisationId} — cross-tenant `status` gate.
 *
 * `organisation:update` is held cross-tenant by the onboardingService principal
 * (issue #207), but `status` is the soft-delete lever (DELETE sets
 * status='deactivated'). Changing another tenant's status therefore requires
 * `organisation:delete`; an org's own admin editing their OWN status is
 * unaffected.
 */
const rows = new Map();

jest.unstable_mockModule('../lib/database.js', () => ({
  Organisation: {
    findByPk: async (id) => rows.get(id) || null,
  },
}));

const { default: orgItem } = await import('../api/paths/organisations/{organisationId}.js');

const mockLogger = { info() { }, error() { }, warn() { }, debug() { } };
const patch = orgItem(mockLogger).PATCH;

const makeOrg = (id, extra = {}) => {
  const org = { id, name: 'Acme', status: 'active', saved: false, ...extra };
  org.save = async () => { org.saved = true; };
  rows.set(id, org);
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

const call = async ({ user, orgId, body }) => {
  const req = { params: { organisationId: orgId }, body, log: mockLogger };
  const res = makeRes();
  res.locals.user = user;
  await patch(req, res);
  return res;
};

describe('organisation PATCH — cross-tenant status gate', () => {
  beforeEach(() => rows.clear());

  test('onboardingService may NOT change another org status (403)', async () => {
    const org = makeOrg('org-target');
    const res = await call({
      user: { role: 'onboardingService', organisationId: 'org-service' },
      orgId: 'org-target',
      body: { status: 'deactivated' },
    });
    expect(res._status).toBe(403);
    expect(res._body.detail).toMatch(/organisation:delete/);
    expect(org.status).toBe('active');
    expect(org.saved).toBe(false);
  });

  test('onboardingService may still update a name cross-tenant', async () => {
    const org = makeOrg('org-target');
    const res = await call({
      user: { role: 'onboardingService', organisationId: 'org-service' },
      orgId: 'org-target',
      body: { name: 'Renamed' },
    });
    expect(res._status).toBe(200);
    expect(org.name).toBe('Renamed');
  });

  test('orgAdmin may set status on their OWN org', async () => {
    const org = makeOrg('org-1');
    const res = await call({
      user: { role: 'orgAdmin', organisationId: 'org-1' },
      orgId: 'org-1',
      body: { status: 'suspended' },
    });
    expect(res._status).toBe(200);
    expect(org.status).toBe('suspended');
  });

  test('superAdmin (holds organisation:delete) may set status cross-tenant', async () => {
    const org = makeOrg('org-target');
    const res = await call({
      user: { role: 'superAdmin', organisationId: 'org-other' },
      orgId: 'org-target',
      body: { status: 'deactivated' },
    });
    expect(res._status).toBe(200);
    expect(org.status).toBe('deactivated');
  });
});
