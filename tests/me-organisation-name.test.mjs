/**
 * Regression: GET /api/me must report the caller's organisation NAME (issue #203).
 *
 * The bug was upstream of the handler: attachRbac lazy-loaded the Organisation
 * with an attribute allow-list that omitted `name`, so `u.Organisation.name`
 * was undefined and `?? null` made it look like a legitimate "unnamed org".
 * Both halves are asserted here: the load selects `name`, and the handler
 * surfaces it.
 */
import { ORGANISATION_RBAC_ATTRIBUTES } from '../lib/auth/permissions.js';
import meRoute from '../api/paths/me.js';

const logger = { info() { }, error() { }, debug() { }, warn() { } };

function mockRes(user) {
  const res = { locals: { user }, statusCode: 200, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.send = (b) => { res.body = b; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

async function getMe(user) {
  const res = mockRes(user);
  await meRoute(logger).GET({}, res);
  return res;
}

describe('/api/me organisation name (#203)', () => {
  test('the RBAC organisation load selects name alongside the RBAC inputs', () => {
    expect(ORGANISATION_RBAC_ATTRIBUTES).toContain('name');
    // still narrow — the RBAC inputs are all that may join it
    expect([...ORGANISATION_RBAC_ATTRIBUTES].sort())
      .toEqual(['allowedModels', 'id', 'name', 'permissions', 'role', 'status']);
  });

  test('returns the organisation name for a user attached to a named org', async () => {
    const org = { id: 'org-1', name: 'Pennine Flow Controls', status: 'active', role: 'owner' };
    const res = await getMe({ id: 'u1', role: 'owner', status: 'active', organisationId: org.id, Organisation: org });
    expect(res.statusCode).toBe(200);
    expect(res.body.organisationId).toBe('org-1');
    expect(res.body.organisationName).toBe('Pennine Flow Controls');
  });

  test('stays null when there is genuinely no organisation', async () => {
    const res = await getMe({ id: 'u2', role: 'owner', status: 'active' });
    expect(res.body.organisationId).toBeNull();
    expect(res.body.organisationName).toBeNull();
  });
});
