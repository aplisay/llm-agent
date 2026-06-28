import { adminScope, targetInScope } from '../lib/auth/admin-scope.js';

const superAdmin = { role: 'superAdmin' };                                  // has user/org readAll
const orgAdmin = { role: 'orgAdmin', organisationId: 'org-1' };             // own org only
const orgless = { role: 'orgAdmin', organisationId: null };

describe('admin-scope — adminScope (list filter)', () => {
  test('cross-tenant principal => no filter, for both resources', () => {
    expect(adminScope(superAdmin, 'user')).toEqual({});
    expect(adminScope(superAdmin, 'organisation')).toEqual({});
  });
  test('orgAdmin => users scoped by organisationId', () => {
    expect(adminScope(orgAdmin, 'user')).toEqual({ organisationId: 'org-1' });
  });
  test('orgAdmin => organisations scoped by their own id', () => {
    expect(adminScope(orgAdmin, 'organisation')).toEqual({ id: 'org-1' });
  });
  test('org-less admin matches nothing (fail-closed sentinel)', () => {
    expect(adminScope(orgless, 'user')).toEqual({ organisationId: '__none__' });
  });
});

describe('admin-scope — targetInScope (item guard)', () => {
  test('cross-tenant principal may touch any target', () => {
    expect(targetInScope(superAdmin, 'user', { organisationId: 'other' })).toBe(true);
    expect(targetInScope(superAdmin, 'organisation', { id: 'other' })).toBe(true);
  });
  test('orgAdmin may touch a user in their own org', () => {
    expect(targetInScope(orgAdmin, 'user', { organisationId: 'org-1' })).toBe(true);
  });
  test('orgAdmin may NOT touch a user in another org', () => {
    expect(targetInScope(orgAdmin, 'user', { organisationId: 'org-2' })).toBe(false);
  });
  test('orgAdmin may touch only their own organisation row', () => {
    expect(targetInScope(orgAdmin, 'organisation', { id: 'org-1' })).toBe(true);
    expect(targetInScope(orgAdmin, 'organisation', { id: 'org-2' })).toBe(false);
  });
  test('org-less admin can touch nothing', () => {
    expect(targetInScope(orgless, 'user', { organisationId: null })).toBe(false);
  });
});
