> **Internal design doc — DRAFT, awaiting review (not yet implemented).** Branch `better-auth-rbac` (worktree off `better-auth`). This is the concrete build plan for the **RBAC enforcement** slice that the migration plan designed (§4) but left unwired, **plus** four new requirements: prefix-based model access control, org-inherited (baseline) permissions, an organisation-scoped user admin, and a cross-tenant super admin. See also [better-auth-migration-plan.md](./better-auth-migration-plan.md) (canonical RBAC vocabulary, §4) and [users-api-design.md](./users-api-design.md) (the `/api/users` resource this re-gates).

# RBAC enforcement + model access control (llm-agent → llm-frontend)

Verified against the live tree on 2026-06-25 (`9c9b342`). All paths absolute or repo-relative. The provisional gate, `/api/users`, `/api/organisations` (list-only), the Better-Auth parallel branch, and `scopeWhereForUser` tenancy are **already committed**; this plan adds the *action*-authorisation layer on top, which today does not exist (`lib/auth/permissions.js`, `requirePermission`, and any reading of `users.role` are all absent).

---

## 0. Requirements & decisions at a glance

| # | Requirement | Decision |
|---|---|---|
| **R1** | Constrain agent creation/listing to specific models, by **modelName prefix**, as a per-user/per-org list. `text:` = any text model, `pipecat:ultravox` = that family, `livekit:openai-realtime/gpt-realtime` = exact, `*` = any. No list ⇒ no restriction. | New `allowedModels` JSONB list on **User** and **Organisation**. **Boundary-aware** prefix match. Enforced on `/api/models`, agent **create**, agent **list**, agent **get**. This is the **single mechanism** for type/family restriction — there is no `voiceAgent`/`textAgent` permission (§1.1). |
| **R2** | User RBAC = **merge** of org RBAC (baseline) **+** additional user grants. Org is the floor. | Effective perms = `resolve(org) ∪ resolve(user)`, where `resolve(x)=statementsFor(x.role) ∪ x.permissions`. Strictly **additive** (union). New `role`/`permissions` on both entities. |
| **R3** | **Organisational user admin** — restricted `/users` + `/organisation` actions on **own org and its users** only. | New `orgAdmin` role; admin routes scoped by `adminScope()` to `organisationId = user.organisationId` (no `readAll`). |
| **R4** | **Super user admin** — `/users` + `/organisations` admin on **any** user/org. | `superAdmin` role (= the plan's `platformAdmin`), cross-tenant via the `readAll` actions + `system:manage`. `ADMIN_USER_IDS` env stays as the **bootstrap** super-admin. |
| **F1** (decided) | Model-list merge when one level is empty. | **Union of literal lists; an empty list contributes nothing.** Total-empty (and any `*`) ⇒ unrestricted. A user list can therefore *tighten* a user inside an otherwise-open org. |
| **F2** (decided) | `role` storage. | **Migrate `users.role` JSONB → STRING in place** (guarded raw cast on the 41→42 upgrade), backfill every row to `'owner'`, update signup/admin-create/PG-default code paths. |
| **F3** (decided) | `textOnly`/`audioOnly` mechanism + `audioOnly` definition. | **One mechanism — the model-prefix list.** The `voiceAgent`/`textAgent` split is collapsed into a single `agent` resource; type/family is gated only by `allowedModels`. `textOnly`=`['text:']` (exact — `text` is the only text handler). `audioOnly`=`['livekit:','pipecat:','ultravox:']` = any livekit/pipecat/ultravox agent (realtime **+ pipeline**; **excludes** `jambonz:`). Prefixes can't isolate realtime-only (livekit/pipecat carry both, distinguished only by per-model flags), so this role is "WebRTC/modern audio", not strictly realtime. |
| | better-auth `admin()` plugin / `createAccessControl`? | **No.** Enforcement is plain provider-agnostic functions over the Sequelize `User`/`Organisation` rows, so it works identically for Firebase, AuthKey, Better-Auth and no-auth principals, and needs no plugin enabled. |

**Behavioural-safety invariant:** every existing row backfills to `role='owner'`, which resolves to today's "full perms within own org". So switching enforcement on is a **no-op for current users** — only newly-restricted roles or model lists change anything.

---

## 1. The permissions module — `lib/auth/permissions.js` (NEW)

Pure functions, no Better-Auth import (so it loads even when `BETTER_AUTH_ENABLED` is off). Mirrors the migration plan's §4.2/§4.3 vocabulary, extended for the admin tiers.

### 1.1 Statements (resource → actions)

```js
export const statements = {
  // Product — ONE agent resource. Type/family (text vs audio) is gated by the
  // allowedModels prefix list (§2), NOT by separate voiceAgent/textAgent perms.
  agent:    ['create','read','update','delete','deploy','listen','originate','invoke'],
  agentSet: ['create','read','update','delete'],

  // Telephony / calls / billing
  phoneEndpoint: ['claim','read','update','release'],
  trunk:         ['read','assign'],
  call:          ['read','listen'],
  recording:     ['read','download','delete'],
  usage:         ['read','readAll'],            // readAll = cross-tenant

  // Self-service identity
  profile: ['read','update','verifyEmail','verifyPhone'],
  apiKey:  ['create','read','revoke'],

  // Admin surfaces — `readAll` is the CROSS-TENANT marker (R3 vs R4)
  organisation: ['create','read','readAll','update','delete','verify','setLimits','setPermissions'],
  user:         ['create','read','readAll','update','delete','ban','setRole','setLimits','setPermissions','impersonate'],

  // Platform / staff
  system: ['readConfig','manage'],
};
```

### 1.2 Roles

A role resolves to **both** action statements and (optionally) a default model
allow-list (`models`). The `models` list is the *only* type/family mechanism —
`textOnly`/`audioOnly` differ from `owner` purely by their `models` default.

```js
const OWNER_STATEMENTS = {
  agent:['create','read','update','delete','deploy','listen','originate','invoke'],
  agentSet:['create','read','update','delete'],
  phoneEndpoint:['claim','read','update','release'], call:['read','listen'],
  recording:['read','download','delete'], usage:['read'],
  profile:['read','update','verifyEmail','verifyPhone'], apiKey:['create','read','revoke'],
};

export const roles = {
  // Default self-signup: full control of OWN org's product resources, any model.
  owner: { statements: OWNER_STATEMENTS },

  member: { statements: {  // invited teammate: use, no create
    agent:['read','listen','invoke'], agentSet:['read'],
    call:['read','listen'], recording:['read'], usage:['read'],
    profile:['read','update'], apiKey:['create','read','revoke'],
  } },

  // F3 — textOnly / audioOnly == owner actions + a model-prefix restriction.
  // ONE mechanism: the only difference from `owner` is the `models` default.
  textOnly:  { statements: OWNER_STATEMENTS, models: ['text:'] },
  audioOnly: { statements: OWNER_STATEMENTS, models: ['livekit:','pipecat:','ultravox:'] },

  support: { statements: {  // Aplisay support: CROSS-TENANT read, no mutate / no secrets
    agent:['read'], agentSet:['read'], phoneEndpoint:['read'], call:['read'],
    usage:['read','readAll'], user:['read','readAll'], organisation:['read','readAll'],
  } },

  // R3 — ORGANISATIONAL admin: manage OWN org + its users. NO readAll (own-org only),
  // no user:delete/impersonate, no organisation:create/delete/verify.
  orgAdmin: { statements: {
    ...OWNER_STATEMENTS,
    user:['create','read','update','ban','setRole','setLimits','setPermissions'],
    organisation:['read','update','setLimits','setPermissions'],
  } },

  // R4 — SUPER admin: a true SUPERSET — all owner PRODUCT powers (incl agent:create)
  // PLUS cross-tenant admin. MUST spread OWNER_STATEMENTS, else requirePermission
  // ('agent','create') 403s a super admin / no-auth box.
  superAdmin: { statements: {
    ...OWNER_STATEMENTS,
    usage:['read','readAll'], trunk:['read','assign'], system:['readConfig','manage'],
    user:['create','read','readAll','update','delete','ban','setRole','setLimits','setPermissions','impersonate'],
    organisation:['create','read','readAll','update','delete','verify','setLimits','setPermissions'],
  } },
};
```

### 1.3 Resolution & checks

```js
// per-resource union of two statement maps {resource:[actions]}
function mergeStatements(a = {}, b = {}) { /* union arrays per key */ }

export function statementsFor(roleName) { return roles[roleName]?.statements || {}; }
export function modelsFor(roleName)     { return roles[roleName]?.models     || []; }

// resolve one entity (user OR org): its named role's statements ∪ per-entity overrides
function resolveStatements(e) { return mergeStatements(statementsFor(e?.role), e?.permissions || {}); }

// R2 — org baseline ∪ user grants. `org` may be the eager-loaded user.Organisation.
export function effectivePermissions(user, org) {
  return mergeStatements(resolveStatements(org), resolveStatements(user));
}

export function can(user, resource, action) {
  const eff = user?._effectivePermissions /* memoised at auth time */ ?? effectivePermissions(user, user?.Organisation);
  return Array.isArray(eff[resource]) && eff[resource].includes(action);
}

// Route guard mirroring gateProvisional(res): sends 403 + returns false when denied.
export function requirePermission(res, resource, action) {
  if (!can(res.locals.user, resource, action)) {
    res.status(403).json({ message: 'forbidden', detail: `Requires ${resource}:${action}` });
    return false;
  }
  return true;
}
```

`no-auth.js`'s `defaultUser` and the `isSystem` principal are treated as `superAdmin` (full perms) so single-tenant / internal callers are never gated.

---

## 2. Model access control (R1)

### 2.1 modelName grammar (verified)

`[<handler>:]<provider>/<model>`, built at `lib/handlers/handler.js:81` as `` `${this.name}:${name}` `` and parsed by `Handler.parseName` (`handler.js:98`). Handlers: `text`, `jambonz`, `livekit`, `pipecat`, `ultravox`. Examples: `text:anthropic/claude-opus-4-8`, `pipecat:ultravox/ultravox-v0.7`, `livekit:openai-realtime/gpt-realtime`.

### 2.2 Prefix matching — boundary-aware (`lib/auth/model-access.js`, NEW)

A prefix matches only at a **structural boundary** (`:` or `/`), so `pipecat:ultravox` matches `pipecat:ultravox/*` but **not** `pipecat:ultravoxXL/*`.

```js
export function matchModelPrefix(modelName, prefix) {
  if (prefix === '*') return true;
  if (modelName === prefix) return true;
  if (!modelName.startsWith(prefix)) return false;
  const endsOnBoundary = prefix.endsWith(':') || prefix.endsWith('/');
  const next = modelName[prefix.length];
  return endsOnBoundary || next === ':' || next === '/';
}
```

### 2.3 Merge (decision F1) & test

```js
// Union of literal lists; empty contributes nothing; total-empty or any '*' ⇒ unrestricted (null).
function unionModels(...lists) {
  const merged = [...new Set(lists.flat().filter(Boolean))];
  if (merged.length === 0 || merged.includes('*')) return null; // null = unrestricted
  return merged;
}
export function isModelAllowed(modelName, mergedList) {
  if (mergedList == null) return true;
  return mergedList.some((p) => matchModelPrefix(modelName, p));
}

// The effective list draws from FOUR sources unioned together (F3 + R1/R2):
//   org role-default models ∪ org.allowedModels ∪ user role-default models ∪ user.allowedModels
// e.g. role 'textOnly' contributes ['text:']; an explicit column adds more.
export function effectiveAllowedModels(user, org) {
  return unionModels(
    modelsFor(org?.role),  org?.allowedModels,
    modelsFor(user?.role), user?.allowedModels,
  );
}
```

Truth table (org list × user list → effective):

| org | user | effective | result |
|---|---|---|---|
| `null`/`[]` | `null`/`[]` | unrestricted | all models |
| `['text:']` | `[]` | `['text:']` | text only |
| `[]` | `['text:']` | `['text:']` | **Bob tightened** to text in an open org (F1) |
| `['text:']` | `['pipecat:ultravox']` | both | text + pipecat-ultravox (user widened) |
| `['pipecat:ultravox']` | `['text:']` | both | user can't *remove* the org's pipecat grant |
| `['*']` | `['text:']` | unrestricted | `*` dominates |

### 2.4 Enforcement points

The merged list is computed once at auth time and memoised on the principal as `user._allowedModels` (alongside `user._effectivePermissions`).

| Site | File:line (today) | Change |
|---|---|---|
| **Catalogue** | `api/paths/models.js:17` | Filter the `.map(...)` entries: keep only `isModelAllowed(name, user._allowedModels)`. (R1: "/models lists only models in the list".) |
| **Create** | `api/paths/agents.js:25` | `if (!requirePermission(res,'agent','create')) return;` then `if (!isModelAllowed(modelName, user._allowedModels)) return res.status(403).json({message:'model_not_permitted'});` — type/family is enforced **solely** by the model gate (no voice/text permission branch). |
| **List** | `api/paths/agents.js:206` | Filter `agents` rows **and** the `builtins` by `isModelAllowed(row.modelName, ...)`. |
| **Get** | `api/paths/agents/{agentId}.js` | If the loaded agent's `modelName` is not allowed → `403 {message:'model_not_permitted'}`. |
| **Update** | `api/paths/agents/{agentId}.js` (PUT) | `requirePermission(res,'agent','update')` then, when `modelName` is in the body, `isModelAllowed(modelName, …)` — a model CHANGE is squarely an R1 path (else a restricted user could PUT onto a disallowed model). |

**Edge (flagged):** because list/get filter by the *current* allow-list, narrowing a user's list **hides their own pre-existing agents** on now-disallowed models. This is the literal reading of R1 ("listing, reading … restricted to just models in the list"). Operate-time gates (update/invoke/listen/deploy) are an easy follow-up using the same helper but are out of the explicit R1 scope.

---

## 3. Admin tiers & scoping (R3 / R4)

Two layers compose: **RBAC** ("may you do this action at all", §1) then **admin scope** ("on whose rows"). Cross-tenant is gated by the `readAll` action.

```js
// lib/auth/admin-scope.js (NEW) — used by /api/users and /api/organisations
export function adminScope(user, resource /* 'user' | 'organisation' */) {
  if (can(user, resource, 'readAll')) return {};                       // super/support: all orgs
  return { organisationId: user.organisationId ?? '__none__' };        // orgAdmin: own org only
}
export function targetInScope(user, resource, targetOrgId) {
  return can(user, resource, 'readAll') || targetOrgId === user.organisationId;
}
```

- **List** (`GET /users`, `GET /organisations`): `where: { ...adminScope(user, resource) }`.
- **Item mutate** (`PATCH/DELETE /users/{id}`, `/organisations/{id}`): load target, then `if (!targetInScope(user, resource, target.organisationId)) return 404`. For `/organisations/{id}` the org's own id is the scope key.
- **Self-protection (implemented):** an admin may not edit their **own** `role`/`permissions`/`status`/`organisationId`/`allowedModels` via `/users/{id}` (the route compares `req.params.userId` to `res.locals.user.id` and 403s) — `allowedModels` is included so an admin can't self-widen their own model access past an admin-set restriction. Bootstrap super-admins are env-driven so this never locks them out; `name`/`agentLimit` self-edits are allowed.
- **Grant-only-what-you-hold (implemented):** `actorCanGrant(actor, {role, permissions})` (permissions.js) requires every `resource:action` in the granted role/permissions to be within the actor's own effective permissions. This is **stronger than a `readAll`-only check** — it blocks an orgAdmin minting/raising a user (or org baseline) with *any* capability the orgAdmin lacks (e.g. `user:delete`, `organisation:create`), not just cross-tenant `readAll`. Applied on user create/update and org create/update. (`containsCrossTenant` is retained as a helper but the routes use `actorCanGrant`.)

`lib/admin-gate.js` `requireAdmin()` is **reimplemented** (call-sites unchanged) as:
```js
export function requireAdmin(user) {
  if (!user) return false;
  if (user.isSystem === true) return true;
  if (ADMIN_USER_IDS.includes(user.id)) return true;   // bootstrap super-admin
  return can(user, 'user', 'read');                      // any org/super admin
}
export function isSuperAdmin(user) {
  return !!user && (user.isSystem === true || ADMIN_USER_IDS.includes(user.id) || can(user,'user','readAll'));
}
```
`ADMIN_USER_IDS` stays so the **first** super-admin exists before any role is assigned; treat those ids as `superAdmin` when resolving perms (inject `system:manage`/`*:readAll` for them in `effectivePermissions`, or simply short-circuit `can()` to true).

---

## 4. Routes

### 4.1 `/api/users` — re-gate (was env-allowlist `requireAdmin`)
`api/paths/users.js` + `api/paths/users/{userId}.js`:
- Swap each `if (!requireAdmin(...))` for `if (!requirePermission(res,'user',<action>)) return;` (`read` for GET, `create` for POST, `update` for PATCH, `delete` for DELETE).
- `GET` list: add `where: { ...adminScope(user,'user') }` (orgAdmin sees own org; super sees all). Include keeps Organisation.
- `PATCH`/`DELETE`: `targetInScope` check after `findByPk`.
- Extend `EDITABLE` to `['status','role','agentLimit','name','permissions','allowedModels','organisationId']`; `role` apiDoc becomes a **string enum** (`owner|member|textOnly|orgAdmin|superAdmin|support`); guard `setRole`/`organisationId` changes by actor scope.
- Admin-create (`POST /users`): `role` defaults `'owner'` (string), may set `permissions`/`allowedModels`.

### 4.2 `/api/organisations` — extend to full CRUD
- `api/paths/organisations.js`: re-gate list with `requirePermission(res,'organisation','read')` + `adminScope(user,'organisation')`; widen the returned attrs (id,name,status,agentLimit,role,allowedModels) for admins; add **`POST`** create (`organisation:create`, super-only). Keep the lean `{id,name}` shape available for the existing org-filter dropdown (param or separate light response).
- **NEW** `api/paths/organisations/{organisationId}.js`: `GET`/`PATCH`/`DELETE`. PATCH editable = `name, agentLimit, status, role, permissions, allowedModels`. `targetInScope` so an orgAdmin can only touch their own org; create/delete are super-only. This route backs the **frontend org-edit modal**.

---

## 5. Schema & migration (decision F2) — `lib/database.js`

### 5.1 Model definitions
**User** (`User.init`, ~`:1330`):
```js
role:          { type: DataTypes.STRING, allowNull: false, defaultValue: 'owner' }, // was JSONB
permissions:   { type: DataTypes.JSONB,  allowNull: true },   // additive per-user overrides (R2)
allowedModels: { type: DataTypes.JSONB,  allowNull: true },   // prefix list (R1); null = no extra restriction
```
**Organisation** (`Organisation.init`, ~`:1369`):
```js
role:          { type: DataTypes.STRING, allowNull: true },   // baseline named role (nullable)
permissions:   { type: DataTypes.JSONB,  allowNull: true },   // baseline grants (R2)
allowedModels: { type: DataTypes.JSONB,  allowNull: true },   // baseline prefix list (R1)
```

### 5.2 Bump `schemaVersion` 41 → 42 (`database.js:17`).

### 5.3 The role JSONB→STRING cast — **before** `User.sync` (the footgun)
`sync({alter:true})` cannot implicitly cast jsonb→varchar, so pre-convert with an idempotent guarded step inserted in the boot chain *ahead of* `User.sync({alter:true})` (`database.js:1710`):
```sql
-- only when users.role is still jsonb
ALTER TABLE "users" ALTER COLUMN "role" DROP DEFAULT;
ALTER TABLE "users" ALTER COLUMN "role" TYPE varchar(255) USING 'owner';   -- backfill every row to owner
ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'owner';
```
Guard by reading `information_schema.columns.data_type` for `users.role`; run the cast only if `= 'jsonb'`. After it, `User.sync({alter:true})` sees `role` already STRING (no-op) and **adds** `permissions`/`allowed_models` (User) and `role`/`permissions`/`allowed_models` (Organisation).

**Run it UNCONDITIONALLY (outside the `doUpgrade` gate), before the sync chain.** It is idempotent + type-guarded, so on a fresh DB it no-ops (no `users` table yet) and on a v42 DB it always runs. This matters because `setColumnDefault('users','role',\`'owner'\`)` runs on every boot — if the cast were gated behind `doUpgrade`/`DB_FORCE_SYNC`, a v42 DB booted without forceSync would keep a `jsonb` column and `SET DEFAULT 'owner'` would error at the SQL layer.

### 5.4 PG column defaults (Better-Auth Kysely path) — `database.js:1732`
```js
await setColumnDefault('users', 'role', `'owner'`);          // was '{"admin":true,"join":true}'::jsonb
await setColumnDefault('users', 'signup_method', `'better-auth'`);
await setColumnDefault('users', 'status', `'provisional'`);
```

### 5.5 Code paths that wrote JSONB `role`
- `User.import` (`database.js:1267,1270`) — Firebase users: default `role: 'owner'` (string) instead of `{admin,join}`.
- `api/paths/users/signup.js` — drop `role:{}`; rely on `'owner'` default (status='provisional' still gates).
- `api/paths/users.js` admin-create — `role ?? 'owner'`; apiDoc string enum.
- `api/paths/users/{userId}.js` — `role` apiDoc string enum; add `permissions`/`allowedModels` to `EDITABLE`.

---

## 6. Auth middleware — load org RBAC + memoise (`middleware/auth.js`)

Each **human/key** branch already resolves a Sequelize `User`. Add one helper, called right after the user is resolved in the Better-Auth, Firebase, and AuthKey branches (before `gateProvisional`/`next`):

```js
async function attachRbac(user) {
  if (user && user.organisationId && !user.Organisation) {
    user.Organisation = await Organisation.findByPk(user.organisationId,
      { attributes: ['id','role','permissions','allowedModels'] });
  }
  user._effectivePermissions = effectivePermissions(user, user.Organisation);
  user._allowedModels = effectiveAllowedModels(user, user.Organisation);
  return user;
}
```
- Better-Auth branch: prefer `User.findByPk(id, { include: Organisation })` so the org is loaded inside the **session cache** (org-perm changes then lag ≤ the 60s TTL, same accepted trade as role/status — hardening risk 6).
- AuthKey branch: `AuthKey.roleRestriction` (plan §4.6) **intersects** with the owner's effective perms — fold in here as a follow-up (`_effectivePermissions = intersect(owner, keyRole)`); not blocking for R1–R4.
- `isSystem` / no-auth `defaultUser`: set `_effectivePermissions = roles.superAdmin`, `_allowedModels = null`.

---

## 7. Ordered task list (llm-agent)

1. `lib/auth/permissions.js` — statements, roles, `mergeStatements`, `effectivePermissions`, `can`, `requirePermission`.
2. `lib/auth/model-access.js` — `matchModelPrefix`, `mergeAllowedModels`, `isModelAllowed`.
3. `lib/auth/admin-scope.js` — `adminScope`, `targetInScope`.
4. `lib/database.js` — schema fields (User+Org), `schemaVersion` 42, guarded JSONB→STRING cast before `User.sync`, PG defaults, `User.import` role string. **One commit (schema + cast + defaults).**
5. `middleware/auth.js` — `attachRbac` in the 3 principal branches; import Organisation; BA branch eager-loads org.
6. `lib/admin-gate.js` — reimplement `requireAdmin`/add `isSuperAdmin` over `can()`; keep `ADMIN_USER_IDS` bootstrap.
7. `api/paths/models.js` — filter catalogue by `_allowedModels`.
8. `api/paths/agents.js` — create: `requirePermission(res,'agent','create')` + `isModelAllowed`; list: filter rows+builtins.
9. `api/paths/agents/{agentId}.js` — get: `isModelAllowed` 403.
10. `api/paths/users.js` + `users/{userId}.js` — `requirePermission` + `adminScope`/`targetInScope`; `EDITABLE`+apiDoc; string role.
11. `api/paths/organisations.js` — re-gate + scope + `POST` create; `api/paths/organisations/{organisationId}.js` (NEW) GET/PATCH/DELETE.
12. `api/api-doc.yaml` — string `Role` enum, `AllowedModels`, org/user RBAC fields on the schemas.
13. **Tests** (`tests/`): prefix matcher + merge truth-table; `effectivePermissions` org∪user; `requirePermission` allow/deny incl. voice-vs-text; `/models` filtering; agent create/list model gate; orgAdmin own-org vs superAdmin cross-tenant scoping; role-migration smoke (JSONB→STRING, owner backfill).
14. Schema upgrade run (`DB_FORCE_SYNC`/`forceSync`) against staging; verify cast + backfill + new columns.

## 8. Frontend (llm-frontend) — IMPLEMENTED (branch `better-auth-rbac`, worktree `/Users/rob/Aplisay/code/llm-frontend-rbac`)

- **`GET /api/me`** (NEW backend route, `api/paths/me.js`) — returns the caller's `{ role, organisationId, permissions, allowedModels, isAdmin, isSuperAdmin, assignableRoles }`. Not admin-gated (self only); the SPA's single source for admin gating. `assignableRoles` = the roles the caller may actually grant (`actorCanGrant`), so the UI never offers a role the backend would 403.
- `src/api/use-me.js` (`useMe()`, module-cached) + `useIsAdmin` re-derived from `/me` (replaces the old 403-probe; `App.js` Users-tab gate unchanged). Old `checkIsAdmin` removed.
- `src/api/users-admin.js`: `fetchMe`, `updateOrganisation` (`PATCH /organisations/{id}`), `createOrganisation` (`POST /organisations`); `updateUser` now sends a string `role` + `allowedModels`.
- `UsersPanel.js`: user role editor is a **string `Select`** (options = `me.assignableRoles` + current); **`allowedModels`** comma-separated editor; **super-admin-only** "New organisation" button + per-row **Edit** → an org create/edit modal (name/status/agentLimit/baseline role/allowedModels). Non-super users keep the checkbox-filter behaviour.
- `/api/models` is filtered server-side, so the agent-create model picker auto-narrows — **no client change** for R1's catalogue. Verified.
- *Deferred:* raw per-user/per-org `permissions` JSONB editing in the UI (role + allowedModels cover the practical cases); add a JSON editor later if needed.

## 9. Risks

1. **JSONB→STRING cast** must run before `User.sync({alter:true})` or sync errors on the implicit cast; idempotency via the `information_schema` type guard. Ship schema+cast+defaults+`User.import` in one commit (mirrors the §2.4 backfill-ordering rule in users-api-design).
2. **Org-perm staleness** lags ≤ the 60s session-cache TTL per instance (same trade as role/status, hardening risk 6). Acceptable; invalidate the cache entry on org mutate for immediacy if needed.
3. **Hiding own agents** when a user's model list narrows (§2.4 edge) — intended per R1; confirm UX copy in the frontend.
4. **Bootstrap lock-out**: ensure at least one `ADMIN_USER_IDS` (or `isSystem`) principal exists before relying solely on assigned `superAdmin` roles, or no one can grant the first role.
5. **Self-escalation**: orgAdmin must not grant `superAdmin` or move users cross-org — enforced by the `readAll`-gated `setRole`/`organisationId` checks (§3).
