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
  // `reserve` mints a carrier reservation that a claim onto a CHARGEABLE
  // trunk must present (see api/paths/number-reservations.js). Held by the
  // seam that actually buys numbers at the carrier, never by an org role.
  // `assign` moves a number between organisations, or into and out of the
  // unallocated pool. Platform operators only, like trunk:assign.
  phoneEndpoint: ['claim', 'read', 'update', 'release', 'reserve', 'assign'],
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
      phoneEndpoint: [...OWNER_STATEMENTS.phoneEndpoint, 'reserve', 'assign'],
      system: ['readConfig', 'manage'],
      user: ['create', 'read', 'readAll', 'update', 'delete', 'ban', 'setRole', 'setLimits', 'setPermissions', 'impersonate'],
      organisation: ['create', 'read', 'readAll', 'update', 'delete', 'verify', 'setLimits', 'setRate', 'credit', 'billing', 'setPermissions'],
    },
  },

  // Machine identity for the polite-ai billing seam. A synthetic service user
  // holds an AuthKey with this role; it adjusts an org's balance (signed
  // credits), its billing controls (block flag + balance callbacks), and the
  // rate card the org's subscription package implies — no product access, no
  // user administration. Least privilege for a server-to-server credential that
  // lives in another process.
  //
  // `rate:read` + `organisation:read`/`readAll`/`setRate` are what let the seam
  // put an org on the card its package implies when an account is approved or
  // its subscription changes. WHICH card a package maps to is the client's
  // pricing policy and stays entirely on its side; this vocabulary only says the
  // seam may assign one. Without these three the assignment 403s at its first
  // call (`Requires rate:read`) — and because that path is fail-soft by design
  // it fails SILENTLY, leaving every org it touches unrated: usage rows land
  // `cost_status='no_rate'`, so they are metered but never charged.
  //
  // `readAll` is required, not optional: this principal has no `organisationId`
  // of its own, so `targetInScope` (lib/auth/admin-scope.js) would 404 every org
  // row without the cross-tenant capability. Reading is likewise not optional —
  // assignment must be idempotent, which means reading the existing timeline
  // before deciding whether to write a new one.
  //
  // Keys minted by scripts/provision-billing-service.mjs store role_restriction
  // as the ROLE NAME, so existing keys pick these widened statements up on the
  // next deploy with no re-mint and no secret rotation; any key whose
  // role_restriction is a literal statement MAP is frozen at its minted actions
  // and must be re-minted (scripts/verify-billing-service.mjs reports which).
  billingService: {
    statements: {
      organisation: ['read', 'readAll', 'setRate', 'credit', 'billing'],
      rate: ['read'],
      // Number-purchase seam: the client mints a reservation for the number it
      // has bought at the carrier before the user's own key claims it. Mint
      // only — no claim, read, update or release of numbers.
      phoneEndpoint: ['reserve'],
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
  //
  // `organisation:readAll` is required alongside `read`/`update`, not optional:
  // this principal has no `organisationId` of its own, so `targetInScope`
  // (lib/auth/admin-scope.js) would 404 every org row without the cross-tenant
  // capability. Keys minted by scripts/provision-onboarding-service.mjs store
  // role_restriction as the ROLE NAME, so they pick these widened statements up
  // on the next deploy; any key whose role_restriction is a literal statement MAP
  // is frozen at its minted actions and must be re-minted.
  //
  // KNOWN GAP (tracked separately): PATCH /api/organisations/{organisationId}
  // treats `status` as covered by the bare `organisation:update` entry check, so
  // `readAll` + `update` lets this key set status='deactivated' on ANY org — the
  // same soft-delete the DELETE route reserves for `organisation:delete`. The
  // field-level gate belongs in that route handler, not in this vocabulary; until
  // it lands, "no delete" below means no `organisation:delete` action, NOT that
  // the key is incapable of cross-tenant org deactivation. Keep it server-held.
  onboardingService: {
    statements: {
      user: ['read', 'readAll', 'update'],
      organisation: ['create', 'read', 'readAll', 'update'],
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
 * The Organisation columns an RBAC principal load needs (middleware/auth.js →
 * attachRbac). Kept deliberately narrow so the per-request load stays cheap:
 * the RBAC inputs (`status`/`role`/`permissions`/`allowedModels`) plus `name`,
 * which is the one presentational field principals read back (GET /api/me
 * labels a dashboard shell with it — omitting it silently rendered
 * `organisationName: null` for every lazily-loaded principal, issue #203).
 */
export const ORGANISATION_RBAC_ATTRIBUTES = ['id', 'name', 'status', 'role', 'permissions', 'allowedModels'];

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

export default { statements, roles, ORGANISATION_RBAC_ATTRIBUTES, mergeStatements, statementsFor, modelsFor, effectivePermissions, can, requirePermission, containsCrossTenant, isSubsetOf, actorCanGrant, intersectStatements, keyRestrictionStatements, validateRbacFields };
