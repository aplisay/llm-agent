import { jest } from '@jest/globals';
import { Op } from 'sequelize';
import {
  scopeWhereForUser,
  scopeWhereForOrganisation,
  userOwnsRow,
  userOwnsPhoneNumber,
} from '../lib/scope.js';

describe('lib/scope.js — scopeWhereForUser', () => {
  test('returns Op.or fragment for user with both id and organisationId', () => {
    const where = scopeWhereForUser({ id: 'user-1', organisationId: 'org-1' });
    expect(where[Op.or]).toEqual([
      { userId: 'user-1' },
      { organisationId: 'org-1' },
    ]);
  });

  test('returns userId-only fragment for user without an organisation', () => {
    const where = scopeWhereForUser({ id: 'user-1', organisationId: null });
    expect(where).toEqual({ userId: 'user-1' });
  });

  test('returns userId-only fragment when organisationId is undefined', () => {
    const where = scopeWhereForUser({ id: 'user-1' });
    expect(where).toEqual({ userId: 'user-1' });
  });

  test('returns organisationId-only fragment when only organisationId is set', () => {
    const where = scopeWhereForUser({ organisationId: 'org-1' });
    expect(where).toEqual({ organisationId: 'org-1' });
  });

  test('throws when called without a user', () => {
    expect(() => scopeWhereForUser(null)).toThrow(/user is required/i);
    expect(() => scopeWhereForUser(undefined)).toThrow(/user is required/i);
  });

  test('throws when user has no identifying fields', () => {
    expect(() => scopeWhereForUser({})).toThrow(/neither id nor organisationId/i);
    expect(() => scopeWhereForUser({ id: null, organisationId: null })).toThrow(
      /neither id nor organisationId/i,
    );
  });

  test('result is spreadable into a parent where-clause', () => {
    const user = { id: 'u', organisationId: 'o' };
    const where = { id: 'call-1', ...scopeWhereForUser(user) };
    expect(where.id).toBe('call-1');
    expect(where[Op.or]).toEqual([{ userId: 'u' }, { organisationId: 'o' }]);
  });
});

describe('lib/scope.js — scopeWhereForOrganisation', () => {
  test('returns organisationId fragment when user has an organisation', () => {
    expect(scopeWhereForOrganisation({ id: 'u', organisationId: 'org-1' })).toEqual({
      organisationId: 'org-1',
    });
  });

  test('returns null for users with no organisation', () => {
    expect(scopeWhereForOrganisation({ id: 'u' })).toBeNull();
    expect(scopeWhereForOrganisation({ id: 'u', organisationId: null })).toBeNull();
    expect(scopeWhereForOrganisation({ id: 'u', organisationId: undefined })).toBeNull();
  });

  test('throws when called without a user', () => {
    expect(() => scopeWhereForOrganisation(null)).toThrow(/user is required/i);
  });
});

describe('lib/scope.js — userOwnsRow', () => {
  test('matches by userId when both sides are set and equal', () => {
    expect(userOwnsRow({ id: 'u-1' }, { userId: 'u-1' })).toBe(true);
  });

  test('matches by organisationId when both sides are set and equal', () => {
    expect(
      userOwnsRow({ organisationId: 'org-1' }, { organisationId: 'org-1' }),
    ).toBe(true);
  });

  test('matches when org-only row is owned by user via organisation', () => {
    expect(
      userOwnsRow(
        { id: 'u-1', organisationId: 'org-1' },
        { organisationId: 'org-1' },
      ),
    ).toBe(true);
  });

  // The vulnerability this whole helper exists to prevent.
  test('does NOT match when both organisationId values are null', () => {
    expect(
      userOwnsRow(
        { id: 'u-attacker', organisationId: null },
        { userId: 'u-victim', organisationId: null },
      ),
    ).toBe(false);
  });

  test('does NOT match when both organisationId values are undefined', () => {
    expect(
      userOwnsRow({ id: 'u-attacker' }, { userId: 'u-victim' }),
    ).toBe(false);
  });

  test('does NOT match when only the row has an organisation', () => {
    expect(
      userOwnsRow({ id: 'u' }, { userId: 'someone-else', organisationId: 'org-1' }),
    ).toBe(false);
  });

  test('does NOT match when only the user has an organisation', () => {
    expect(
      userOwnsRow({ id: 'u', organisationId: 'org-1' }, { userId: 'someone-else' }),
    ).toBe(false);
  });

  test('does NOT match when organisations are different', () => {
    expect(
      userOwnsRow(
        { id: 'u', organisationId: 'org-1' },
        { userId: 'someone-else', organisationId: 'org-2' },
      ),
    ).toBe(false);
  });

  test('returns false when caller or row is missing', () => {
    expect(userOwnsRow(null, { userId: 'u', organisationId: 'o' })).toBe(false);
    expect(userOwnsRow({ id: 'u' }, null)).toBe(false);
    expect(userOwnsRow(undefined, undefined)).toBe(false);
  });
});

describe('lib/scope.js — userOwnsPhoneNumber', () => {
  // Direct ownership branches mirror userOwnsRow.
  test('matches when phone number organisation matches user', () => {
    expect(
      userOwnsPhoneNumber(
        { id: 'u', organisationId: 'org-1' },
        { number: '447x', organisationId: 'org-1' },
      ),
    ).toBe(true);
  });

  test('does NOT match cross-org phone number', () => {
    expect(
      userOwnsPhoneNumber(
        { id: 'u', organisationId: 'org-1' },
        { number: '447x', organisationId: 'org-2' },
      ),
    ).toBe(false);
  });

  // The pool case: org-less number, no-org user, claimed via listener.
  test('matches a pool number when its bound Instance is owned by the no-org user', () => {
    const user = { id: 'no-org-user-1', organisationId: null };
    const pn = {
      number: '447x',
      organisationId: null,
      instanceId: 'inst-1',
      Instance: { id: 'inst-1', userId: 'no-org-user-1', organisationId: null },
    };
    expect(userOwnsPhoneNumber(user, pn)).toBe(true);
  });

  test('refuses a pool number whose Instance belongs to a different no-org user', () => {
    const user = { id: 'no-org-user-attacker', organisationId: null };
    const pn = {
      number: '447x',
      organisationId: null,
      instanceId: 'inst-1',
      Instance: { id: 'inst-1', userId: 'no-org-user-victim', organisationId: null },
    };
    // Critical regression check: the previous null===null code accepted
    // this; userOwnsRow refuses; userOwnsPhoneNumber must also refuse.
    expect(userOwnsPhoneNumber(user, pn)).toBe(false);
  });

  test('refuses an unbound pool number (instanceId is null)', () => {
    const user = { id: 'no-org-user-1', organisationId: null };
    const pn = {
      number: '447x',
      organisationId: null,
      instanceId: null,
      Instance: null,
    };
    expect(userOwnsPhoneNumber(user, pn)).toBe(false);
  });

  test('refuses when Instance was not eagerly loaded (transitive branch unavailable)', () => {
    const user = { id: 'no-org-user-1', organisationId: null };
    const pn = { number: '447x', organisationId: null, instanceId: 'inst-1' };
    // No Instance attached → no way to verify transitive ownership.
    expect(userOwnsPhoneNumber(user, pn)).toBe(false);
  });

  test('accepts lowercase `instance` alias as well as Sequelize-default `Instance`', () => {
    const user = { id: 'u', organisationId: null };
    const pn = {
      organisationId: null,
      instance: { userId: 'u', organisationId: null },
    };
    expect(userOwnsPhoneNumber(user, pn)).toBe(true);
  });

  test('org user matches via direct org even when bound Instance is in a different org', () => {
    // (Synthetic case — shouldn't normally happen, but the helper should
    // honour direct ownership as the primary path.)
    const user = { id: 'u', organisationId: 'org-1' };
    const pn = {
      organisationId: 'org-1',
      Instance: { userId: 'u-other', organisationId: 'org-2' },
    };
    expect(userOwnsPhoneNumber(user, pn)).toBe(true);
  });

  test('returns false when caller or row is missing', () => {
    expect(userOwnsPhoneNumber(null, { organisationId: 'org' })).toBe(false);
    expect(userOwnsPhoneNumber({ id: 'u' }, null)).toBe(false);
  });
});
