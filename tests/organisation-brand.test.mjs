/**
 * Brands on organisations: the pure parts. The routes are in
 * organisation-brand-api.test.mjs.
 */
import { validateBrandId, validateBrandFields, capabilitiesForNewOrganisation, principalBrand } from '../lib/brands.js';
import { statementsFor, can, actorCanGrant } from '../lib/auth/permissions.js';
import { adminScope, targetInScope } from '../lib/auth/admin-scope.js';
import meRoute from '../api/paths/me.js';

const logger = { info() {}, error() {}, debug() {}, warn() {} };

async function getMe(user) {
  const res = { locals: { user }, statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.body = body; return res; };
  res.json = res.send;
  await meRoute(logger).GET({}, res);
  return res;
}

describe('brand ids and defaults', () => {
  test('a brand id is a short lower case slug', () => {
    for (const ok of ['polite', 'acme-2', 'a', 'x'.repeat(32)]) expect(validateBrandId(ok)).toBeNull();
    for (const bad of ['', 'Acme', '-acme', 'acme corp', 'x'.repeat(33), null, 7]) expect(validateBrandId(bad)).not.toBeNull();
  });

  test('default capabilities must be known ones', () => {
    expect(validateBrandFields({ defaultCapabilities: ['phoneSystem'] })).toBeNull();
    expect(validateBrandFields({ defaultCapabilities: ['teleport'] })).toMatch(/Unknown capability/);
    expect(validateBrandFields({ defaultCapabilities: ['phoneSystem', 'phoneRedirect'] })).toMatch(/Not a brand default/);
    expect(validateBrandFields({ defaultCapabilities: 'phoneSystem' })).toMatch(/array/);
    expect(validateBrandFields({ name: 'x'.repeat(121) })).toMatch(/name/);
  });

  test('a new organisation takes its brand defaults, and none without a brand', () => {
    expect(capabilitiesForNewOrganisation({ defaultCapabilities: ['phoneSystem', 'phoneSystem'] })).toEqual(['phoneSystem']);
    expect(capabilitiesForNewOrganisation({ defaultCapabilities: [] })).toEqual([]);
    expect(capabilitiesForNewOrganisation(null)).toEqual([]);
  });

  test('the brand of a principal comes from its key only', () => {
    expect(principalBrand({ _brand: 'acme' })).toBe('acme');
    expect(principalBrand({ brand: 'acme' })).toBeNull();
    expect(principalBrand(null)).toBeNull();
  });
});

describe('roles', () => {
  test('an owner may read and change its organisation, and nothing more of it', () => {
    for (const role of ['owner', 'textOnly', 'audioOnly']) {
      expect(statementsFor(role).organisation).toEqual(['read', 'update']);
      expect(can({ role }, 'organisation', 'setLimits')).toBe(false);
      expect(can({ role }, 'organisation', 'setCapabilities')).toBe(false);
      expect(can({ role }, 'organisation', 'readAll')).toBe(false);
    }
    expect(statementsFor('member').organisation).toBeUndefined();
  });

  test('a brand service may create organisations and set capabilities, and nothing else', () => {
    expect(statementsFor('brandService')).toEqual({
      organisation: ['create', 'read', 'readAll', 'setCapabilities'],
      brand: ['read'],
    });
    expect(can({ role: 'brandService' }, 'brand', 'update')).toBe(false);
    expect(can({ role: 'brandService' }, 'user', 'read')).toBe(false);
    expect(can({ role: 'brandService' }, 'directory', 'read')).toBe(false);
  });

  test('only a platform operator sets brand defaults, and an organisation admin cannot hand out a brand role', () => {
    expect(can({ role: 'superAdmin' }, 'brand', 'update')).toBe(true);
    for (const role of ['owner', 'orgAdmin', 'support', 'onboardingService', 'billingService']) {
      expect(can({ role }, 'brand', 'update')).toBe(false);
    }
    expect(actorCanGrant({ role: 'orgAdmin' }, { role: 'brandService' })).toBe(false);
  });
});

describe('tenancy for a principal with a brand', () => {
  const brandKey = { role: 'brandService', organisationId: null, _brand: 'acme' };
  const operator = { role: 'superAdmin', organisationId: null };

  test('lists only the organisations of its brand', () => {
    expect(adminScope(brandKey, 'organisation')).toEqual({ brand: 'acme' });
    expect(adminScope(operator, 'organisation')).toEqual({});
  });

  test('reaches an organisation of its brand and no other', () => {
    expect(targetInScope(brandKey, 'organisation', { id: 'o1', brand: 'acme' })).toBe(true);
    expect(targetInScope(brandKey, 'organisation', { id: 'o2', brand: 'other' })).toBe(false);
    expect(targetInScope(brandKey, 'organisation', { id: 'o3', brand: null })).toBe(false);
    expect(targetInScope(brandKey, 'organisation', null)).toBe(false);
    expect(targetInScope(operator, 'organisation', { id: 'o2', brand: 'other' })).toBe(true);
  });

  test('reaches no user rows, even with user:readAll', () => {
    const wide = { ...brandKey, _effectivePermissions: { user: ['read', 'readAll'] } };
    expect(adminScope(wide, 'user')).toEqual({ organisationId: '__none__' });
    expect(targetInScope(wide, 'user', { organisationId: null })).toBe(false);
  });
});

describe('GET /me', () => {
  test("gives the organisation's brand and capabilities", async () => {
    const Organisation = { id: 'org-1', name: 'Acme Ltd', status: 'active', brand: 'acme', capabilities: ['phoneSystem'] };
    const res = await getMe({ id: 'u1', role: 'owner', status: 'active', organisationId: 'org-1', Organisation });
    expect(res.body.organisation).toEqual({ id: 'org-1', name: 'Acme Ltd', brand: 'acme', capabilities: ['phoneSystem'] });
    expect(res.body.organisationName).toBe('Acme Ltd');
    expect(res.body.brand).toBeNull();
  });

  test('gives an empty list for an organisation with no capabilities, and null with no organisation', async () => {
    const res = await getMe({ id: 'u1', role: 'owner', organisationId: 'org-2', Organisation: { id: 'org-2', name: 'B' } });
    expect(res.body.organisation).toEqual({ id: 'org-2', name: 'B', brand: null, capabilities: [] });
    expect((await getMe({ id: 'u2', role: 'owner' })).body.organisation).toBeNull();
  });

  test("gives a brand key's brand", async () => {
    const res = await getMe({ id: 'svc', role: 'brandService', status: 'active', _brand: 'acme' });
    expect(res.body.brand).toBe('acme');
    expect(res.body.organisation).toBeNull();
  });
});
