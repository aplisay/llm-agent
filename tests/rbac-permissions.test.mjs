import {
  roles,
  statementsFor,
  modelsFor,
  effectivePermissions,
  can,
  requirePermission,
  containsCrossTenant,
  isSubsetOf,
  actorCanGrant,
  intersectStatements,
  keyRestrictionStatements,
  validateRbacFields,
} from '../lib/auth/permissions.js';

function mockRes(user) {
  const res = { locals: { user }, statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}

describe('permissions — roles vocabulary', () => {
  test('owner grants agent:create but no user admin', () => {
    expect(statementsFor('owner').agent).toContain('create');
    expect(statementsFor('owner').user).toBeUndefined();
  });
  test('textOnly / audioOnly carry model defaults, not a separate permission split', () => {
    expect(modelsFor('textOnly')).toEqual(['text:']);
    expect(modelsFor('audioOnly')).toEqual(['livekit:', 'pipecat:', 'ultravox:']);
    // textOnly still has the full agent action set (one mechanism: the model list gates type)
    expect(statementsFor('textOnly').agent).toEqual(statementsFor('owner').agent);
  });
  test('orgAdmin can administer users but is NOT cross-tenant and cannot edit org RBAC baseline', () => {
    expect(statementsFor('orgAdmin').user).toContain('setRole');
    expect(statementsFor('orgAdmin').user).not.toContain('readAll');
    expect(statementsFor('orgAdmin').user).not.toContain('delete');
    expect(statementsFor('orgAdmin').organisation).toContain('update');
    expect(statementsFor('orgAdmin').organisation).not.toContain('setPermissions');
    expect(statementsFor('orgAdmin').organisation).not.toContain('create');
  });
  test('superAdmin is cross-tenant', () => {
    expect(statementsFor('superAdmin').user).toContain('readAll');
    expect(statementsFor('superAdmin').organisation).toContain('create');
  });
  test('rate cards (pricing) are superAdmin-only; org:setRate too', () => {
    for (const a of ['read', 'readAll', 'create', 'update', 'delete']) {
      expect(can({ role: 'superAdmin' }, 'rate', a)).toBe(true);
    }
    expect(can({ role: 'superAdmin' }, 'organisation', 'setRate')).toBe(true);
    // Not for owner / orgAdmin / member.
    expect(can({ role: 'owner' }, 'rate', 'read')).toBe(false);
    expect(can({ role: 'orgAdmin' }, 'rate', 'create')).toBe(false);
    expect(can({ role: 'orgAdmin' }, 'organisation', 'setRate')).toBe(false);
  });
  test('billingService can ONLY credit balance (least privilege)', () => {
    expect(can({ role: 'billingService' }, 'organisation', 'credit')).toBe(true);
    // Nothing else — not setRate, not read, not product.
    expect(can({ role: 'billingService' }, 'organisation', 'setRate')).toBe(false);
    expect(can({ role: 'billingService' }, 'organisation', 'read')).toBe(false);
    expect(can({ role: 'billingService' }, 'agent', 'read')).toBe(false);
    expect(can({ role: 'billingService' }, 'rate', 'read')).toBe(false);
    // superAdmin still holds credit (superset).
    expect(can({ role: 'superAdmin' }, 'organisation', 'credit')).toBe(true);
  });
  test('superAdmin is a SUPERSET — keeps owner product powers incl agent:create', () => {
    // Regression guard: without this, no-auth/bootstrap/super principals 403 on agent create.
    expect(can({ role: 'superAdmin' }, 'agent', 'create')).toBe(true);
    expect(can({ role: 'superAdmin' }, 'agentSet', 'create')).toBe(true);
    expect(can({ role: 'superAdmin' }, 'apiKey', 'create')).toBe(true);
  });
  test('unknown role resolves to empty', () => {
    expect(statementsFor('nope')).toEqual({});
    expect(modelsFor('nope')).toEqual([]);
  });
});

describe('permissions — effectivePermissions (R2: org baseline ∪ user grants)', () => {
  test('org baseline is a FLOOR a user cannot drop below', () => {
    // org grants owner; user is a bare member — effective still has agent:create from org.
    const eff = effectivePermissions({ role: 'member' }, { role: 'owner' });
    expect(eff.agent).toContain('create');
  });
  test('user permissions overrides union on top', () => {
    const eff = effectivePermissions({ role: 'member', permissions: { user: ['read'] } }, null);
    expect(eff.user).toEqual(['read']);
    expect(eff.agent).toContain('read'); // from member role
  });
  test('no org + owner user = owner statements', () => {
    expect(effectivePermissions({ role: 'owner' }, null).agent).toContain('delete');
  });
});

describe('permissions — can / requirePermission', () => {
  test('can() reads memoised _effectivePermissions when present', () => {
    const u = { _effectivePermissions: { agent: ['create'] } };
    expect(can(u, 'agent', 'create')).toBe(true);
    expect(can(u, 'agent', 'delete')).toBe(false);
  });
  test('can() falls back to role resolution when not memoised', () => {
    expect(can({ role: 'owner' }, 'agent', 'create')).toBe(true);
    expect(can({ role: 'member' }, 'agent', 'create')).toBe(false);
  });
  test('isSystem principal can do anything', () => {
    expect(can({ isSystem: true }, 'system', 'manage')).toBe(true);
  });
  test('null user can do nothing', () => {
    expect(can(null, 'agent', 'read')).toBe(false);
  });
  test('requirePermission sends 403 and returns false on deny', () => {
    const res = mockRes({ role: 'member' });
    expect(requirePermission(res, 'agent', 'create')).toBe(false);
    expect(res.statusCode).toBe(403);
    expect(res.body.message).toBe('forbidden');
  });
  test('requirePermission returns true (no response) on allow', () => {
    const res = mockRes({ role: 'owner' });
    expect(requirePermission(res, 'agent', 'create')).toBe(true);
    expect(res.statusCode).toBeNull();
  });
});

describe('permissions — containsCrossTenant (escalation guard)', () => {
  test('superAdmin/support resolved statements are cross-tenant', () => {
    expect(containsCrossTenant(statementsFor('superAdmin'))).toBe(true);
    expect(containsCrossTenant(statementsFor('support'))).toBe(true);
  });
  test('owner / orgAdmin are NOT cross-tenant', () => {
    expect(containsCrossTenant(statementsFor('owner'))).toBe(false);
    expect(containsCrossTenant(statementsFor('orgAdmin'))).toBe(false);
  });
  test('a raw permission override granting readAll is detected', () => {
    expect(containsCrossTenant({ user: ['read', 'readAll'] })).toBe(true);
    expect(containsCrossTenant({ user: ['read'] })).toBe(false);
    expect(containsCrossTenant(null)).toBe(false);
  });
});

describe('permissions — isSubsetOf / actorCanGrant ("grant only what you hold")', () => {
  test('isSubsetOf', () => {
    expect(isSubsetOf({ user: ['read'] }, { user: ['read', 'update'] })).toBe(true);
    expect(isSubsetOf({ user: ['delete'] }, { user: ['read'] })).toBe(false);
    expect(isSubsetOf({}, {})).toBe(true);
  });

  const orgAdmin = { role: 'orgAdmin' };
  const superA = { role: 'superAdmin' };

  test('orgAdmin can grant roles at or below its own level', () => {
    expect(actorCanGrant(orgAdmin, { role: 'owner' })).toBe(true);
    expect(actorCanGrant(orgAdmin, { role: 'member' })).toBe(true);
    expect(actorCanGrant(orgAdmin, { role: 'textOnly' })).toBe(true);
    expect(actorCanGrant(orgAdmin, { role: 'orgAdmin' })).toBe(true);
  });
  test('orgAdmin CANNOT grant a cross-tenant role (superAdmin/support)', () => {
    expect(actorCanGrant(orgAdmin, { role: 'superAdmin' })).toBe(false);
    expect(actorCanGrant(orgAdmin, { role: 'support' })).toBe(false);
  });
  test('orgAdmin CANNOT grant raw permissions it lacks (intra-tenant escalation by proxy)', () => {
    expect(actorCanGrant(orgAdmin, { permissions: { user: ['delete', 'impersonate'] } })).toBe(false);
    expect(actorCanGrant(orgAdmin, { permissions: { organisation: ['create'] } })).toBe(false);
    // but it MAY grant a permission it holds
    expect(actorCanGrant(orgAdmin, { permissions: { user: ['read'] } })).toBe(true);
  });
  test('superAdmin can grant anything; system can grant anything; empty grant is allowed', () => {
    expect(actorCanGrant(superA, { role: 'superAdmin' })).toBe(true);
    expect(actorCanGrant(superA, { permissions: { user: ['impersonate'] } })).toBe(true);
    expect(actorCanGrant({ isSystem: true }, { role: 'superAdmin' })).toBe(true);
    expect(actorCanGrant(orgAdmin, {})).toBe(true);
  });
});

describe('permissions — role tuning (full route coverage)', () => {
  test('owner can list trunks (trunk:read added for the DDI-claim UI)', () => {
    expect(can({ role: 'owner' }, 'trunk', 'read')).toBe(true);
  });
  test('member: full product READ + use, no create/manage/delete', () => {
    expect(can({ role: 'member' }, 'phoneEndpoint', 'read')).toBe(true);
    expect(can({ role: 'member' }, 'recording', 'download')).toBe(true);
    expect(can({ role: 'member' }, 'agent', 'invoke')).toBe(true);
    expect(can({ role: 'member' }, 'agent', 'create')).toBe(false);
    expect(can({ role: 'member' }, 'phoneEndpoint', 'claim')).toBe(false);
    expect(can({ role: 'member' }, 'agent', 'delete')).toBe(false);
  });
  test('support: own-org read-only (no use/download/mutate)', () => {
    expect(can({ role: 'support' }, 'recording', 'read')).toBe(true);
    expect(can({ role: 'support' }, 'recording', 'download')).toBe(false);
    expect(can({ role: 'support' }, 'agent', 'invoke')).toBe(false);
    expect(can({ role: 'support' }, 'agent', 'originate')).toBe(false);
  });
});

describe('permissions — intersectStatements (AuthKey: key never exceeds owner)', () => {
  test('keeps only actions present in BOTH', () => {
    expect(intersectStatements({ agent: ['read', 'create'], call: ['read'] }, { agent: ['read'], usage: ['read'] }))
      .toEqual({ agent: ['read'] });
  });
});

describe('permissions — keyRestrictionStatements (legacy-safe)', () => {
  test('null / empty / legacy {admin,join} => no restriction', () => {
    expect(keyRestrictionStatements(null)).toBeNull();
    expect(keyRestrictionStatements({})).toBeNull();
    expect(keyRestrictionStatements({ admin: true, join: true })).toBeNull();
  });
  test('a named-role string resolves to its statements', () => {
    expect(keyRestrictionStatements('member')).toEqual(statementsFor('member'));
  });
  test('a new-vocab statement map is honoured', () => {
    expect(keyRestrictionStatements({ agent: ['read'] })).toEqual({ agent: ['read'] });
  });
  test('the join-only key shape emitted by tools/agent-admin.js restricts to agent:invoke', () => {
    // tools/agent-admin.js --joinOnly now writes { agent: ['invoke'] } (new vocab)
    // instead of the legacy { join: true } bag, which keyRestrictionStatements reads
    // as "no restriction" — silently minting a FULL owner-perms key.
    const restriction = keyRestrictionStatements({ agent: ['invoke'] });
    expect(restriction).toEqual({ agent: ['invoke'] });
    // Intersected with an owner key, the key can ONLY invoke (join) agents.
    const owner = effectivePermissions({ role: 'owner' }, null);
    expect(intersectStatements(owner, restriction)).toEqual({ agent: ['invoke'] });
    // Contrast: the legacy shape would have left the key fully unrestricted.
    expect(keyRestrictionStatements({ join: true })).toBeNull();
  });
});

describe('permissions — validateRbacFields', () => {
  test('accepts null / valid shapes', () => {
    expect(validateRbacFields({})).toBeNull();
    expect(validateRbacFields({ allowedModels: null, permissions: null })).toBeNull();
    expect(validateRbacFields({ allowedModels: ['text:'], permissions: { agent: ['read'] } })).toBeNull();
  });
  test('rejects non-string-array allowedModels', () => {
    expect(validateRbacFields({ allowedModels: 'text:' })).toMatch(/allowedModels/);
    expect(validateRbacFields({ allowedModels: [1, 2] })).toMatch(/allowedModels/);
  });
  test('rejects malformed permissions', () => {
    expect(validateRbacFields({ permissions: ['x'] })).toMatch(/permissions/);
    expect(validateRbacFields({ permissions: { agent: 'read' } })).toMatch(/permissions/);
  });
});
