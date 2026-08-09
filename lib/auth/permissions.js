/**
 * RBAC permission vocabulary, roles, and checks.
 *
 * Provider-agnostic: these are plain functions over the resolved Sequelize
 * `User` / `Organisation` rows (a `role` STRING + a `permissions` JSONB
 * override map), so they behave identically for Firebase, AuthKey, Better-Auth
 * and no-auth principals. Better-Auth's admin()/createAccessControl plugin is
 * intentionally NOT used — enforcement lives in our own Express layer (see
 * docs/implementation/rbac-implementation-plan.md §0/§1).
 *
 * Two orthogonal layers compose at every gated route:
 *   1. RBAC    — `can(user, resource, action)`            (this module)
 *   2. Tenancy — `scopeWhereForUser` (lib/scope.js) / `adminScope`
 *                (lib/auth/admin-scope.js)
 * RBAC decides "may you do this kind of action"; tenancy decides "on which rows".
 *
 * Effective permissions are the UNION of the organisation's baseline and the
 * user's own grants (R2 — org is the floor, the user can only add):
 *   effective = resolve(org) ∪ resolve(user)
 *   resolve(x) = statementsFor(x.role) ∪ x.permissions
 *
 * The text-vs-audio agent distinction is NOT modelled here: there is a single
 * `agent` resource, and which model families a principal may touch is governed
 * entirely by the model allow-list (lib/auth/model-access.js).
 */

// resource -> the full set of actions it supports (the vocabulary).
export const statements = {
  // Product — ONE agent resource (type/family gated by model-access.js).
  agent: ['create', 'read', 'update', 'delete', 'deploy', 'listen', 'originate', 'invoke'],
  agentSet: ['create', 'read', 'update', 'delete'],

  // Telephony / calls / billing
  phoneEndpoint: ['claim', 'read', 'update', 'release'],
  trunk: ['read', 'assign', 'create'],
  // `prune` = bulk-delete stored call ARTIFACTS (recordings / transcripts /
  // invocation logs) past a retention horizon — the call rows themselves are
  // never deleted. Held by superAdmin and the billingService seam so a client
  // system can apply its own retention policies.
  call: ['read', 'listen', 'prune'],
  recording: ['read', 'download', 'delete'],
  usage: ['read', 'readAll'], // readAll = cross-tenant
  // Pricing rate cards (Phase 2/3 billing). Platform pricing config — superAdmin
  // only; readAll = cross-tenant (cards are global, not org-scoped).
  rate: ['read', 'readAll', 'create', 'update', 'delete'],
  // Destination tariffs (Phase D billing) — prefix decks for telco-style
  // destination-number charging, linked from a rate card's `destination` line.
  // Same superAdmin-only platform-config posture as `rate`.
  tariff: ['read', 'readAll', 'create', 'update', 'delete'],

  // Self-service identity
  profile: ['read', 'update', 'verifyEmail', 'verifyPhone'],
  apiKey: ['create', 'read', 'revoke'],

  // Admin surfaces — `readAll` is the CROSS-TENANT marker (orgAdmin vs superAdmin).
  // `setRate` = assign an org's billing rate-name history (mirrors `setLimits`).
  // `credit` = adjust the org's balance (the Stripe-webhook seam; held by the
  // least-privilege `billingService` role, NOT bundled into setRate).
  // `billing` = operate the org's billing controls (billingBlocked flag +
  // billingConfig balance callbacks) — same service-seam posture as `credit`.
  organisation: ['create', 'read', 'readAll', 'update', 'delete', 'verify', 'setLimits', 'setRate', 'credit', 'billing', 'setPermissions'],
  user: ['create', 'read', 'readAll', 'update', 'delete', 'ban', 'setRole', 'setLimits', 'setPermissions', 'impersonate'],

  // Platform / staff
  system: ['readConfig', 'manage'],
};

// Shared by owner / textOnly / audioOnly / (base of) orgAdmin.
const OWNER_STATEMENTS = {
  agent: ['create', 'read', 'update', 'delete', 'deploy', 'listen', 'originate', 'invoke'],
  agentSet: ['create', 'read', 'update', 'delete'],
  phoneEndpoint: ['claim', 'read', 'update', 'release'],
  trunk: ['read'], // list trunks for the DDI-claim UI (assignment is super-only)
  call: ['read', 'listen'],
  recording: ['read', 'download', 'delete'],
  usage: ['read'],
  profile: ['read', 'update', 'verifyEmail', 'verifyPhone'],
  apiKey: ['create', 'read', 'revoke'],
};

/**
 * Named roles. A role resolves to BOTH action `statements` and an optional
 * default model allow-list (`models`). The `models` list is the *only*
 * type/family mechanism — `textOnly`/`audioOnly` differ from `owner` purely by
 * their `models` default (F3 — one mechanism).
 */
export const roles = {
  // Default for self-signup / existing users: full control of OWN org's product
  // resources, any model. Tenancy still confines them to their own rows.
  owner: { statements: OWNER_STATEMENTS },

  // Invited teammate: full READ + use of product resources, no create/manage/delete.
  member: {
    statements: {
      agent: ['read', 'listen', 'invoke'],
      agentSet: ['read'],
      phoneEndpoint: ['read'],
      trunk: ['read'],
      call: ['read', 'listen'],
      recording: ['read', 'download'],
      usage: ['read'],
      profile: ['read', 'update'],
      apiKey: ['create', 'read', 'revoke'],
    },
  },

  // F3 — owner actions restricted to a model family via the prefix list.
  textOnly: { statements: OWNER_STATEMENTS, models: ['text:'] },
  audioOnly: { statements: OWNER_STATEMENTS, models: ['livekit:', 'pipecat:', 'ultravox:'] },

  // Aplisay support: READ-only troubleshooting. Cross-tenant on the admin surfaces
  // (user/org/usage readAll); product reads are own-org (Q4). No mutate / no download.
  support: {
    statements: {
      agent: ['read'],
      agentSet: ['read'],
      phoneEndpoint: ['read'],
      trunk: ['read'],
      call: ['read'],
      recording: ['read'],
      usage: ['read', 'readAll'],
      user: ['read', 'readAll'],
      organisation: ['read', 'readAll'],
    },
  },

  // R3 — ORGANISATIONAL admin: manage OWN org + its users. No `readAll`
  // (own-org only), no user:delete/impersonate, no organisation:create/delete/verify.
  orgAdmin: {
    statements: {
      ...OWNER_STATEMENTS,
      user: ['create', 'read', 'update', 'ban', 'setRole', 'setLimits', 'setPermissions'],
      // NB: no organisation:setPermissions — the org's own RBAC/model baseline is
      // a platform policy editable only by superAdmin (and the org-edit modal is
      // super-only). orgAdmin may rename / set status / set the agent limit.
      organisation: ['read', 'update', 'setLimits'],
    },
  },

  // R4 — SUPER admin: a true SUPERSET — all owner PRODUCT powers (incl agent:create)
  // PLUS cross-tenant user/org administration. Spreading OWNER_STATEMENTS is what
  // lets no-auth / bootstrap / super principals still drive the product (without it,
  // requirePermission('agent','create') would 403 a super admin / no-auth box).
  superAdmin: {
    statements: {
      ...OWNER_STATEMENTS,
      call: ['read', 'listen', 'prune'],
      usage: ['read', 'readAll'],
      rate: ['read', 'readAll', 'create', 'update', 'delete'],
      tariff: ['read', 'readAll', 'create', 'update', 'delete'],
      trunk: ['read', 'assign', 'create'],
      system: ['readConfig', 'manage'],
      user: ['create', 'read', 'readAll', 'update', 'delete', 'ban', 'setRole', 'setLimits', 'setPermissions', 'impersonate'],
      organisation: ['create', 'read', 'readAll', 'update', 'delete', 'verify', 'setLimits', 'setRate', 'credit', 'billing', 'setPermissions'],
    },
  },

  // Machine identity for the polite-ai Stripe-webhook → balance-credit seam. A
  // synthetic service user holds an AuthKey with this role; it can ONLY adjust an
  // org's balance (signed credits) and billing controls (block flag + balance
  // callbacks) — no rate assignment, no product access — least privilege for a
  // server-to-server credential that lives in another process.
  billingService: {
    statements: {
      organisation: ['credit', 'billing'],
      // Retention seam: the client's billing service applies its own
      // call-artifact retention policies via POST /calls/prune. Artifact
      // deletion only — no call read/listen, no product access.
      call: ['prune'],
    },
  },

  // Machine identity for the polite-ai waitlist → invite → setup onboarding seam.
  // When an invited user completes account setup (password or OAuth), the polite-ai
  // BFF uses an AuthKey with this role to create the new organisation and flip the
  // just-created user to active. Deliberately narrow: no delete, no role/permission
  // grants, no product access — the invite lifecycle itself lives in polite-ai.
  onboardingService: {
    statements: {
      user: ['read', 'readAll', 'update'],
      organisation: ['create'],
    },
  },
};

/** Per-resource union of two statement maps `{ resource: [actions] }`. */
export function mergeStatements(a = {}, b = {}) {
  const out = {};
  for (const src of [a, b]) {
    if (!src) continue;
    for (const [resource, actions] of Object.entries(src)) {
      if (!Array.isArray(actions)) continue;
      out[resource] = [...new Set([...(out[resource] || []), ...actions])];
    }
  }
  return out;
}

/** The action statements granted by a named role (empty for unknown roles). */
export function statementsFor(roleName) {
  return roles[roleName]?.statements || {};
}

/** The default model-prefix list contributed by a named role (empty by default). */
export function modelsFor(roleName) {
  return roles[roleName]?.models || [];
}

/** Resolve one entity (user OR org): its role's statements ∪ its `permissions` overrides. */
function resolveStatements(entity) {
  return mergeStatements(statementsFor(entity?.role), entity?.permissions || {});
}

/**
 * Effective action permissions for a user, with their organisation as the
 * baseline floor (R2). `org` is normally the eager-loaded `user.Organisation`.
 */
export function effectivePermissions(user, org) {
  return mergeStatements(resolveStatements(org), resolveStatements(user));
}

/**
 * Does `user` hold `resource:action`?
 *
 * Prefers the value memoised on the principal at auth time
 * (`_effectivePermissions`, set by middleware/auth.js → attachRbac), falling
 * back to computing it from the loaded `role`/`Organisation`. The internal
 * system principal (`x-shared-token`) is allowed everything.
 */
export function can(user, resource, action) {
  if (!user) return false;
  if (user.isSystem === true) return true;
  const eff = user._effectivePermissions ?? effectivePermissions(user, user.Organisation);
  return Array.isArray(eff[resource]) && eff[resource].includes(action);
}

/**
 * Route guard mirroring `gateProvisional(res)`: sends a 403 and returns `false`
 * when the principal lacks `resource:action`; returns `true` otherwise. Run
 * after the auth middleware, before tenancy scoping.
 *
 *   if (!requirePermission(res, 'agent', 'create')) return;
 */
export function requirePermission(res, resource, action) {
  if (!can(res.locals.user, resource, action)) {
    res.status(403).json({ message: 'forbidden', detail: `Requires ${resource}:${action}` });
    return false;
  }
  return true;
}

/**
 * Does a statement map confer ANY cross-tenant (`readAll`) capability? Used by
 * the admin routes to stop a non-super actor (orgAdmin) granting a role or
 * permission override that would escalate a user/org across tenants.
 */
export function containsCrossTenant(statementMap) {
  return Object.values(statementMap || {}).some((actions) => Array.isArray(actions) && actions.includes('readAll'));
}

/**
 * Is every resource:action in `granted` also present in `held`? Basis of the
 * "an admin may only grant capabilities it already holds" rule.
 */
export function isSubsetOf(granted, held) {
  for (const [resource, actions] of Object.entries(granted || {})) {
    if (!Array.isArray(actions)) continue;
    const have = held?.[resource] || [];
    for (const a of actions) if (!have.includes(a)) return false;
  }
  return true;
}

/**
 * May `actor` grant the given named role and/or permission overrides? True iff
 * everything the grant would confer is within the actor's OWN effective
 * permissions — blocking both cross-tenant (`readAll`) escalation AND intra-tenant
 * capability escalation by proxy (an orgAdmin minting/raising a user — or editing
 * its own row — to powers the orgAdmin role itself lacks).
 */
export function actorCanGrant(actor, { role, permissions } = {}) {
  if (actor?.isSystem === true) return true;
  const granted = mergeStatements(statementsFor(role), permissions || {});
  const held = actor?._effectivePermissions ?? effectivePermissions(actor, actor?.Organisation);
  return isSubsetOf(granted, held);
}

/** Per-resource INTERSECTION of two statement maps (actions present in BOTH). */
export function intersectStatements(a = {}, b = {}) {
  const out = {};
  for (const [resource, actions] of Object.entries(a || {})) {
    if (!Array.isArray(actions)) continue;
    const other = b?.[resource] || [];
    const both = actions.filter((x) => other.includes(x));
    if (both.length) out[resource] = both;
  }
  return out;
}

/**
 * Interpret an AuthKey's legacy `roleRestriction` as a statement map to INTERSECT
 * with the owner's effective permissions (§4.6 — a key can never exceed its owner).
 * Returns null = "no restriction" for an absent / empty / LEGACY-shaped value (e.g.
 * the old {admin,join} bag) so pre-existing keys keep full owner perms; a new-vocab
 * named-role string or a {resource:[actions]} map is honoured.
 */
export function keyRestrictionStatements(roleRestriction) {
  if (typeof roleRestriction === 'string' && roleRestriction) return statementsFor(roleRestriction);
  if (roleRestriction && typeof roleRestriction === 'object' && !Array.isArray(roleRestriction)) {
    const keys = Object.keys(roleRestriction);
    if (keys.length && keys.every((k) => Array.isArray(roleRestriction[k]) && roleRestriction[k].every((a) => typeof a === 'string'))) {
      return roleRestriction;
    }
  }
  return null; // null / empty / legacy {admin,join} => no restriction
}

/**
 * Validate the RBAC fields an admin may submit: `permissions` must be null or a
 * {resource:[string]} map; `allowedModels` must be null or a string[]. Returns an
 * error message, or null when valid. Prevents arbitrary JSON persisting and later
 * crashing allowedModelsWhere / isModelAllowed.
 */
export function validateRbacFields(body = {}) {
  if ('allowedModels' in body && body.allowedModels != null) {
    const am = body.allowedModels;
    if (!Array.isArray(am) || !am.every((s) => typeof s === 'string')) {
      return 'allowedModels must be null or an array of strings';
    }
  }
  if ('permissions' in body && body.permissions != null) {
    const p = body.permissions;
    if (typeof p !== 'object' || Array.isArray(p)) return 'permissions must be null or an object';
    for (const v of Object.values(p)) {
      if (!Array.isArray(v) || !v.every((a) => typeof a === 'string')) {
        return 'permissions values must be arrays of strings';
      }
    }
  }
  return null;
}

export default { statements, roles, mergeStatements, statementsFor, modelsFor, effectivePermissions, can, requirePermission, containsCrossTenant, isSubsetOf, actorCanGrant, intersectStatements, keyRestrictionStatements, validateRbacFields };
