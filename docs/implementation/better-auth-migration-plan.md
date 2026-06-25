# Better-Auth migration plan (Firebase → Better-Auth)

**Status:** draft / proposal
**Branch:** `better-auth`
**Author:** Rob + Claude
**Date:** 2026-06-22

A phased transition that deprecates Firebase auth in favour of
[Better-Auth](https://better-auth.com), converging on a **single, Sequelize-owned
`users` table** that is the source of truth for identity *and* fine-grained
permissions (RBAC).

---

## 1. How auth works today (the seam)

Authentication is **middleware-only** — there are no auth declarations in the
OpenAPI spec, and no `/auth`/`/login`/`/session` endpoints in this backend (the
playground SPA, a separate repo, does Firebase client-side sign-in and sends the
ID token as a Bearer header).

[`middleware/auth.js`](../middleware/auth.js) recognises four principal types,
all of which converge on a single shape — `res.locals.user` (carrying `user.id`,
`user.organisationId`) produced via `User.import()`:

| Principal | Mechanism | Source |
|-----------|-----------|--------|
| Firebase ID token | `Bearer <jwt>` → `firebase.verifyIdToken()` → `User.import({...user, id: user.user_id})` | `auth.js:92-99` |
| Static API key | `Bearer <key>` → `AuthKey.verify()` | `auth.js:82-90` |
| Instance join token | `Bearer <base64('instance:<id>')>`, path-locked to room join | `auth.js:64-78` |
| Internal/system | `x-shared-token: <SHARED_API_TOKEN>` | `auth.js:36-47` |

Two facts make a parallel provider genuinely additive:

1. **One identity contract.** Every route scopes off `res.locals.user` through
   `scopeWhereForUser` ([`lib/scope.js`](../lib/scope.js)). Nothing downstream
   knows *how* a request was authenticated.
2. **`users.id` is a STRING PK** (currently the Firebase UID), not a UUID
   ([`lib/database.js:1282`](../lib/database.js)). Better-Auth user ids are also
   strings, so they coexist in one column.

### The permissions reality today

`user.role` is **written but never enforced.** The only touches are
`User.import` defaulting it to `{admin: true, join: true}`
([`database.js:1270`](../lib/database.js)) and `AuthKey.verify` overriding it
with `roleRestriction` ([`database.js:1418`](../lib/database.js)). No route gate
ever reads it. The *real* access control today is purely **tenancy** —
`scopeWhereForUser` deciding which rows a principal may see.

**Consequence:** fine-grained permissions is effectively greenfield. We are not
migrating an RBAC system, we are building one — so it can be designed cleanly
with no legacy to reconcile.

---

## 2. Target architecture: one unified, Sequelize-owned `users` table

### 2.1 Decision

Better-Auth's `user` model points at the **existing `users` table**
(`modelName: "users"`), with its core identity columns mapped to our columns and
our domain columns declared as `additionalFields`. Sequelize remains the DDL
owner throughout. The satellite auth tables (`account` — where password hashes
and OAuth tokens live; `session`; `verification`; `jwks`) stay as Better-Auth's
own tables: they are pure auth plumbing with no reason to merge.

The end state is **simpler and more flexible** than a federated two-table design:
one physical record per human carrying identity + role + permission scopes, which
is exactly what the future RBAC and user-management work wants.

### 2.2 Temporary scaffolding (parallel phase only — 1–2 release cycles)

While Firebase and Better-Auth run in parallel, two pieces of scaffolding exist
**and are explicitly temporary**:

- **`User.import` field restriction.** During the parallel period a Firebase-
  authed request still calls `User.import` → `User.upsert`, which would clobber
  Better-Auth-managed columns (`emailVerified`, `name`, `picture`) on a shared
  row. So `User.import` is narrowed to upsert only Firebase-owned fields and to
  not overwrite Better-Auth-managed ones. *(Deleted in Phase 3.)*

### 2.4 Identity bridge (implemented — no custom resolver needed)

Because the `users` table is unified, an existing Firebase-era row already *looks
like* a Better-Auth user (same email, `email_verified`). Better-Auth's own logic
therefore **never creates a duplicate** for a known email — it links or refuses:

- **Social (Google):** sign-in *links* the OAuth account to the existing row,
  preserving its id and all FK'd data, when the local email is verified
  (`account.accountLinking.requireLocalEmailVerified`, default true); otherwise it
  refuses rather than duplicating. Configured via `account.accountLinking`
  (`trustedProviders: ['google']`). Google emails arrive verified, so this is the
  automatic path for migrating Google users. *(`oauth2/link-account.mjs`.)*
- **Email/password:** sign-up *errors* on a known email (no dup). The migrating
  user runs *forgot password* → `resetPassword` **creates** a `credential`
  account on their existing row when none exists (`password.mjs:152`), preserving
  id + data. Enabled by configuring `emailAndPassword.sendResetPassword`.
- **Edge case:** an *unverified* Firebase row won't auto-link on social sign-in
  (anti-takeover); such users migrate via the password path or a later verified
  re-link.

This bridge is **permanent** migration machinery (unlike the `User.import`
restriction above) and needs no `appUserId` column or middleware email lookup.

### 2.3 Better-Auth config sketch (illustrative — verify field names against current docs)

```js
// lib/auth/index.js
import { betterAuth } from "better-auth";
import { jwt, bearer, admin } from "better-auth/plugins";
import { Pool } from "pg";
import { ac, roles } from "./permissions.js";

export const auth = betterAuth({
  database: new Pool({ /* existing POSTGRES_* env */ }),
  user: {
    modelName: "users",                 // ← use OUR table, not "user"
    fields: { image: "picture" },       // ← map BA `image` → our `picture` column
    additionalFields: {
      role:           { type: "string", defaultValue: "owner", input: false },
      permissions:    { type: "json",   required: false, input: false }, // per-user scope overrides
      organisationId: { type: "string", required: false, input: false },
      agentLimit:     { type: "number", required: false, input: false },
      phone:          { type: "string", required: false },
      phoneVerified:  { type: "boolean", defaultValue: false },
      status:         { type: "string", defaultValue: "active", input: false },
    },
  },
  emailAndPassword: { enabled: true },
  socialProviders: { google: { /* … */ } },   // mirror current Firebase methods
  plugins: [
    jwt(),     // issue verifiable JWTs (the Firebase-ID-token analog)
    bearer(),  // accept Authorization: Bearer
    admin({ ac, roles }),   // RBAC + block/deactivate (banned/banReason/banExpires)
  ],
  trustedOrigins: [ /* same as CORS origins in index.mjs */ ],
});
```

Sequelize stays the DDL owner: add the matching columns to `User.init()` (see §5)
and run `better-auth generate` only to **diff** what BA expects — never
`better-auth migrate` against the shared table.

---

## 3. Phasing

### Phase 0 — Backend parallel (this branch)
- Add `better-auth` + `jose`; configure `lib/auth/index.js` against the existing
  `users` table (§2.3).
- Mount `server.all('/api/auth/*', toNodeHandler(auth))` in `index.mjs`
  **before `express.json()`** (BA needs the raw body — documented footgun; json
  is currently first at `index.mjs:44`).
- Add a `/api/auth` skip + a **fifth verification branch** to `middleware/auth.js`,
  ordered: shared-token → instance → AuthKey → **Better-Auth** → Firebase. First
  success wins. (Verification mechanism — superseded by §8.1: implemented as
  `getSession` + a short-TTL in-process cache, **not** stateless JWKS. See
  `better-auth-hardening-plan.md` item F.)
- Add the temporary `User.import` field restriction. (Identity bridge is
  Better-Auth-native — see §2.4 — so no custom resolver is needed.)
- Ship dark behind `BETTER_AUTH_ENABLED` (default off); enable dev → staging → prod.

### Phase 1 — Frontend (separate playground repo)
- Adopt `better-auth/client`, add a sign-in path (behind a flag for now), send the
  BA JWT as `Authorization: Bearer` exactly where the Firebase token goes today.
- Both providers live; users can sign in via either.

### Phase 2 — Migrate + RBAC foundation
- Backfill existing Firebase users into Better-Auth, **preserving their ids**.
- Introduce the RBAC vocabulary + `role`/`permissions` columns + route-level
  enforcement (starting with the text/voice agent split, §4.4).
- Backfill all existing users to `role = 'owner'` (matches today's "full perms
  within own org" behaviour).
- Fold `AuthKey.roleRestriction` into the same permission vocabulary.

### Phase 3 — Deprecate Firebase → clean SSoT
- Remove the Firebase branch from `middleware/auth.js`; drop `firebase-admin`
  (already only an `optionalDependency`); retire the Firebase project.
- **Delete `User.import` and the temporary import restriction** — Better-Auth
  `databaseHooks` become the sole writer to `users`. The shared Sequelize schema
  is now the clean single source of truth.
- Optional hardening: migrate Bearer-JWT → native Better-Auth cookie sessions.

### Phase 4 — User-management server (future; placeholders only)
A new, **not-yet-designed** backend (next phase after Firebase deprecation) that
uses this DB schema to provide:
1. **Self-signup with strong ID verification** — email capture+verify, SMS
   capture+verify, organisation record creation+verify.
2. **Staff user-management app** — adjust permissions, block/deactivate, manually
   create users.
3. **Self-service** — users manage contact details and API key create/delete.

This plan only provides **schema + RBAC placeholders** (§4.7, §5) so that server
can be built without another migration churn. It does **not** design that server.

---

## 4. RBAC model

### 4.1 Two orthogonal axes — do not conflate

| Axis | Question | Where it lives |
|------|----------|----------------|
| **Tenancy** | *Which rows may this principal see?* | `scopeWhereForUser` (unchanged) |
| **RBAC** | *Which actions may this principal perform?* | Better-Auth access control + `users.role`/`permissions` |

RBAC says "may you do this *kind* of action"; tenancy says "on which rows".
Enforcement runs RBAC first, then tenancy scoping filters the rows.

### 4.2 Resource / action vocabulary

```js
// lib/auth/permissions.js
import { createAccessControl } from "better-auth/plugins/access";

export const statements = {
  // ── Product: agents are split by type (voice vs text) ──
  voiceAgent: ["create", "read", "update", "delete", "deploy", "listen", "originate"],
  textAgent:  ["create", "read", "update", "delete", "invoke"],
  agentSet:   ["create", "read", "update", "delete"],

  // ── Product: telephony, calls, billing ──
  phoneEndpoint: ["claim", "read", "update", "release"],  // PhoneNumber + PhoneRegistration
  trunk:         ["read", "assign"],
  call:          ["read", "listen"],
  recording:     ["read", "download", "delete"],
  usage:         ["read", "readAll"],                     // readAll = cross-tenant billing

  // ── Identity / tenancy — mostly PLACEHOLDERS for the Phase-4 user-mgmt server ──
  profile:      ["read", "update", "verifyEmail", "verifyPhone"], // self-service
  apiKey:       ["create", "read", "revoke"],                     // self-service AuthKeys
  organisation: ["create", "read", "update", "delete", "verify", "setLimits"],
  user:         ["create", "read", "update", "delete", "ban", "setRole", "setLimits", "impersonate"],

  // ── Platform/staff ──
  system: ["readConfig", "manage"],
};

export const ac = createAccessControl(statements);
```

**Resource ↔ DB mapping note:** `voiceAgent` ↔ `agents.type = 'interactive-audio'`,
`textAgent` ↔ `agents.type = 'text'`. The product term "interactive-voice" maps
to the internal enum `interactive-audio`.

### 4.3 Roles

```js
export const roles = {
  // Default for self-signup: full control of *their own org's* product resources.
  // Tenancy scoping still confines them to their own rows.
  owner: ac.newRole({
    voiceAgent: ["create","read","update","delete","deploy","listen","originate"],
    textAgent:  ["create","read","update","delete","invoke"],
    agentSet:   ["create","read","update","delete"],
    phoneEndpoint: ["claim","read","update","release"],
    call: ["read","listen"], recording: ["read","download","delete"], usage: ["read"],
    profile: ["read","update","verifyEmail","verifyPhone"], apiKey: ["create","read","revoke"],
  }),

  // Invited team member: use, limited create.
  member: ac.newRole({
    voiceAgent: ["read","listen"], textAgent: ["read","invoke"], agentSet: ["read"],
    call: ["read","listen"], recording: ["read"], usage: ["read"],
    profile: ["read","update"], apiKey: ["create","read","revoke"],
  }),

  // Example showing the text/voice split in action — text only, no voice create/use.
  textOnly: ac.newRole({
    textAgent: ["create","read","update","delete","invoke"],
    voiceAgent: ["read"], agentSet: ["read"], usage: ["read"], profile: ["read","update"],
  }),

  // Aplisay support: cross-tenant READ for troubleshooting, no destructive/no secrets.
  support: ac.newRole({
    voiceAgent: ["read"], textAgent: ["read"], agentSet: ["read"],
    phoneEndpoint: ["read"], call: ["read"], usage: ["read","readAll"],
    user: ["read"], organisation: ["read"],
  }),

  // PLACEHOLDER — the Phase-4 staff user-management app. Superset of support.
  platformAdmin: ac.newRole({
    user: ["create","read","update","delete","ban","setRole","setLimits","impersonate"],
    organisation: ["create","read","update","delete","verify","setLimits"],
    trunk: ["read","assign"], usage: ["read","readAll"], system: ["readConfig","manage"],
    voiceAgent: ["read"], textAgent: ["read"], agentSet: ["read"], call: ["read"],
  }),
};
```

### 4.4 The text vs interactive-voice split (concrete enforcement)

A small `requirePermission(user, resource, action)` helper resolves the user's
role → statements (via `ac`), unions any per-user `permissions` overrides, and
throws a 403 if the action is not granted. It runs **after** the auth middleware,
**before** tenancy scoping. Gates at the real code sites:

```js
// api/paths/agents.js — agentCreate, right after `type` is resolved (line ~25)
type = type ?? (modelName?.startsWith('text:') ? 'text' : 'interactive-audio');
requirePermission(res.locals.user, type === 'text' ? 'textAgent' : 'voiceAgent', 'create');
//                                  └─ voice vs text create is now a separate permission ─┘

// api/paths/agents/{agentId}/invoke.js — text-agent "use" (already text-only at line 27)
requirePermission(res.locals.user, 'textAgent', 'invoke');

// api/paths/agents/{agentId}/listen.js + rooms/{listenerId}/join.js — voice "use"
requirePermission(res.locals.user, 'voiceAgent', 'listen');   // or 'deploy' when binding a number
```

This satisfies the requirement: **create** and **use** are independently grantable
for **text** vs **interactive-voice** (e.g. the `textOnly` role above can build and
invoke text agents but cannot create or operate voice agents).

### 4.5 Per-user fine-grained overrides

`role` is the base bundle; the optional `users.permissions` JSONB is unioned on
top for per-user scopes — e.g. `{ "voiceAgent": ["read"], "textAgent": ["create","invoke"] }`.
MVP = additive grants; a `deny` list can come later. This is the "RBAC scopes in
future" flexibility the unified schema unlocks.

### 4.6 API keys

`AuthKey.roleRestriction` folds into the same vocabulary: a key carries a role
name or a `permissions` subset that is **intersected** with its owner's effective
permissions (a key can never exceed its owner). `apiKey:create`/`revoke` are the
self-service actions gating key management.

### 4.7 User-management placeholders

The `user`, `organisation`, `profile`, `apiKey`, and `system` statements above are
**reserved now, enforced later** — they give the Phase-4 server a ready vocabulary:

- **Strong-ID self-signup** → `profile:verifyEmail`, `profile:verifyPhone`,
  `organisation:create`, `organisation:verify`.
- **Staff user-management** → `user:create|update|ban|setRole|setLimits|impersonate`,
  `organisation:*` (held by `platformAdmin`).
- **Self-service** → `profile:read|update`, `apiKey:create|read|revoke`.

---

## 5. Schema changes (unified `users` table, Sequelize-owned)

Additions to `User.init()` in [`lib/database.js`](../lib/database.js). Existing
`email`, `emailVerified`, `phone`, `phoneVerified`, `picture` already map to
Better-Auth / the strong-ID flow.

```js
// RBAC
role:        { type: DataTypes.STRING, allowNull: false, defaultValue: 'owner' }, // was JSONB {admin,join}
permissions: { type: DataTypes.JSONB,  allowNull: true },   // per-user scope overrides (§4.5)

// Lifecycle / staff actions (Better-Auth admin plugin manages banned/banReason/banExpires)
status:      { type: DataTypes.ENUM('pending','active','suspended','deactivated'), defaultValue: 'active' },
banned:      { type: DataTypes.BOOLEAN, defaultValue: false },
banReason:   { type: DataTypes.STRING,  allowNull: true },
banExpires:  { type: DataTypes.DATE,    allowNull: true },

// Strong-ID verification placeholders (Phase 4)
emailVerifiedAt: { type: DataTypes.DATE,   allowNull: true },
phoneVerifiedAt: { type: DataTypes.DATE,   allowNull: true },
signupMethod:    { type: DataTypes.STRING, allowNull: true }, // 'firebase' | 'better-auth' | 'staff'
```

Organisation gets verification placeholders too:

```js
status:     { type: DataTypes.ENUM('pending','active','suspended'), defaultValue: 'active' },
verifiedAt: { type: DataTypes.DATE, allowNull: true },
```

**Migration of `role`:** today JSONB `{admin,join}`; move to a string named-role +
JSONB `permissions`. Since `role` is unenforced today, backfill every existing row
to `role = 'owner'` — preserves current behaviour exactly. Bump `schemaVersion`
(currently 39) accordingly.

---

## 6. Backend Phase 0 task list

- [ ] Add `better-auth`, `jose`; build a `pg` Pool from `POSTGRES_*`.
- [ ] `lib/auth/index.js` — configured `auth` against `users` (§2.3).
- [ ] `lib/auth/permissions.js` — `ac`, `statements`, `roles` (§4).
- [ ] Mount `/api/auth/*` handler **before** `express.json()` in `index.mjs`.
- [ ] `middleware/auth.js` — `/api/auth` skip + fifth (Better-Auth JWT) branch.
- [x] Identity bridge — `account.accountLinking` (social) + `sendResetPassword`
  (password); no custom resolver needed (§2.4).
- [ ] Narrow `User.import` to not clobber BA-managed fields (temporary).
- [ ] `User.init()` schema additions (§5); bump `schemaVersion`.
- [ ] `requirePermission` helper; wire the text/voice gates (§4.4).
- [ ] Wire `@better-auth/cli migrate` for BA's own tables into deploy.
- [ ] Env: `BETTER_AUTH_ENABLED`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, Google OAuth.
- [ ] Tests: middleware branch (valid/expired/wrong-issuer JWT); bridge; token precedence; `requirePermission` allow/deny incl. text-vs-voice.

---

## 7. Risks & gotchas

- **`express.json()` ordering** — mount the BA handler first or auth POSTs break.
- **Dual schema ownership** — Sequelize owns DDL; never `better-auth migrate` the
  shared `users` table (use `generate` to diff only).
- **Dual-writer clobber (parallel phase)** — the temporary `User.import`
  restriction exists precisely to prevent Firebase upserts overwriting BA fields.
- **Identity continuity** — relies on Better-Auth refusing to duplicate a known
  email (links social / errors password; §2.4). The main gotcha: a migrating
  row must be `email_verified` or social auto-linking is refused.
- **Role defaults** — backfill to `owner` (within-tenant full perms); never
  `platformAdmin` (cross-tenant) by default.
- **Better-Auth moves fast** — pin a version; verify exact plugin/field/endpoint
  names against current docs before coding.
- **Out of scope, flagged** — WebSocket streams are currently unauthenticated
  (F-1 in `docs/security.md`); BA tokens could secure them later.

---

## 8. Open decisions

1. **Transport / session-verification** — **DECIDED (2026-06-24): JWT-as-Bearer
   stays the session-token transport, verified server-side via `getSession`
   wrapped in a short-TTL in-process cache** (so no Postgres read per call). NOT
   the `jwt()`/JWKS stateless path (rejected — needs a frontend token-exchange),
   and NOT `secondaryStorage`/Redis (rejected — adds infra). See
   `better-auth-hardening-plan.md` item F + risk 6.
2. **Sign-in methods** — mirror current Firebase (email/password + Google), or
   add/drop any (magic link, GitHub…)?
3. **Org model** — keep the simple `users.organisationId` (one org per user) for
   now, or adopt Better-Auth's `organization` plugin (multi-org membership, per-org
   roles, invitations)? The latter is a larger change; recommended only if Phase-4
   needs multi-org membership.
