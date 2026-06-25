> **Internal design doc — IMPLEMENTED as WIP on the `better-auth` branch (2026-06-25); awaiting review before commit.** Design for the `/api/users` provisional-signup + admin user-lifecycle resource. See also [better-auth-migration-plan.md](./better-auth-migration-plan.md) and [better-auth-hardening-plan.md](./better-auth-hardening-plan.md). The **Implementation status** section below records the deviations from the plan as built.

# Implementation Plan: `/api/users` resource + provisional gate (llm-agent, WIP on `better-auth` branch)

> Verified against the live tree on 2026-06-24. All paths absolute. Lowest-blast-radius option chosen at every fork: **direct Sequelize** for the data plane (signup-no-password, list, modify), **better-auth only** where a credential hash must be written, **status column** (never `role`) as the gate key, and a **4-line gate** added to the two human auth branches only.

---

## Implementation status (2026-06-25) — built, not yet committed

Three deviations from the plan as written:

1. **With-password sign-up uses core `auth.api.signUpEmail`, not the admin-plugin `auth.api.createUser`.** §1.1/§4 called `createUser`, but that API only exists when the `admin()` plugin is registered — which §0/§4 also said *not* to enable. To resolve the contradiction we use core `signUpEmail` (works with the bearer-only config), then a follow-up `User.update` sets `role:{}` + `signupMethod`. `status` still defaults to `provisional` via the Postgres column default, so the user is gated. Costs: `signUpEmail`'s `autoSignIn` writes an (unused) session row, and the verification `callbackURL` is passed *through* `signUpEmail` rather than via an explicit `sendVerificationEmail` call.
2. **`User.import` (Firebase) sets `status:'active'` on INSERT only** (`lib/database.js`). §3.2 gated the Firebase branch but didn't account for `User.import` creating new rows at the `provisional` Postgres default — which would have locked out new llm-frontend self-onboarding. Insert-only `active` keeps onboarding working while still letting an admin suspend/deactivate an *existing* Firebase user (enforced on their next request, within the session-cache TTL).
3. **polite-ai repoint target corrected.** §7.2's note pointed at the Next.js `polite-ai/app/api/register/route.ts`. The live repo is the RR7 **`polite-ai-handoff`** — already a BFF to llm-agent — so the repoint was a one-line URL swap in `app/routes/api.register.tsx` (`/api/waitlist` → `/api/users/signup`); same `{ ok, status, message }` contract, no Prisma involved.

**Files touched (llm-agent):** `lib/database.js` (status enum + ban cols + schemaVersion 41 + PG default + once-only backfill + `User.import`), `lib/admin-gate.js` (new), `api/paths/users/signup.js` (new), `api/paths/users.js` (new), `api/paths/users/{userId}.js` (new), `middleware/auth.js` (skip-list + `isActive`/`gateProvisional`), `index.mjs` (`/api/waitlist` mount removed), `environment-example` (`ADMIN_USER_IDS`); **deleted** `lib/waitlist.js`. **polite-ai-handoff:** `app/routes/api.register.tsx`.

**Still TODO before commit:** run the 40→41 schema upgrade against staging (`yarn develop` with `forceSync`, or `DB_FORCE_SYNC=true`) — confirm the `status` ENUM + ban columns are added and the backfill activated existing rows; then the §11 boot smoke tests (provisional better-auth session → 403; system/AuthKey/instance unaffected; admin `PATCH {status:'active'}` ungates).

---

## 0. Decisions at a glance

| Question | Decision |
|---|---|
| Signup primitive | One public route `POST /api/users/signup` — waitlist now, self-signup later. Difference is only that it sets `status='provisional'`. |
| No-password signup | **Direct Sequelize** `User.upsert` (port `lib/waitlist.js` verbatim, add `status:'provisional'`). |
| With-password signup | `auth.api.createUser({ body:{ email, name, password, data:{ status:'provisional', signupMethod:'self-signup' } } })` **with NO headers** (skips admin-permission check; `data` bypasses `input:false`). |
| Enable `admin()` plugin? | **No, not now.** Adds a login `databaseHook` that reads `user.banned` and needs `banned/banReason/banExpires` columns. We add those columns now (so enabling later is churn-free) but do **not** register the plugin. |
| Gate key | New `status` ENUM column. **Never** `role` (default-`{admin:true,join:true}` footgun). |
| Admin auth for `/api/users` | `requireAdmin(user)` = `user.isSystem === true` **OR** `user.id ∈ ADMIN_USER_IDS` env allowlist. No RBAC yet. |
| Email challenge | Reuse `auth.api.sendVerificationEmail` (already wired in `lib/auth/index.js`). Confirmation flips `email_verified` only — **orthogonal** to `status`. Admin still must promote `provisional → active`. |
| Swagger visibility | Leave `/api/users*` visible by default (it is not `/agent-db`). Optionally hide admin routes — see §1.4. |

---

## 1. Routes — express-openapi modules under `api/paths/users*`

express-openapi maps `./api/paths/*` under the `/api` basePath (`index.mjs:114`, `paths:'./api/paths'`). Factory signature: `export default function(logger){ ... return { GET, POST } }` — deps injected **by parameter name** from `index.mjs:113` `dependencies:{ wsServer, logger, voices }`; users routes need only `logger`. Each handler carries `.apiDoc`. Principal is `res.locals.user` (Sequelize `User`, set in `middleware/auth.js:114`).

### 1.1 `POST /api/users/signup` — PUBLIC (skip-listed)

**File:** `/Users/rob/Aplisay/code/llm-agent/api/paths/users/signup.js` (two dirs deep ⇒ `../../../lib`).

Ports `lib/waitlist.js:28-79` into a path module. Same response contract `{ ok, status, message }` / `{ error }`. Adds `status:'provisional'` to the no-password upsert and the with-password branch.

```js
import { randomUUID } from 'node:crypto';
import { User } from '../../../lib/database.js';
import { auth } from '../../../lib/auth/index.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function (logger) {
  const signup = async (req, res) => {
    if (!auth) return res.status(503).json({ error: 'Sign-up is temporarily unavailable.' });

    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || email.length < 3 || email.length > 254 || !EMAIL_RE.test(email))
      return res.status(400).json({ error: 'Please enter a valid email address.' });

    const password = req.body?.password ? String(req.body.password) : null;
    const callbackURL = process.env.WAITLIST_CALLBACK_URL;
    if (!callbackURL) {
      logger.error('WAITLIST_CALLBACK_URL is unset; cannot build the confirmation link');
      return res.status(500).json({ error: "We couldn't process your sign-up. Please try again shortly." });
    }

    try {
      const existing = await User.findOne({ where: { email } });
      if (existing?.emailVerified)
        return res.json({ ok: true, status: 'already', message: "You're already on the list." });

      if (password && !existing) {
        // Credentialed but STILL provisional. data bag bypasses input:false
        // (admin createUser path skips parseUserInput). NO headers => admin
        // permission check is skipped (session=null short-circuit).
        await auth.api.createUser({
          body: {
            email,
            name: email.split('@')[0],
            password,
            data: { status: 'provisional', signupMethod: 'self-signup', role: {} },
          },
        });
      } else if (!existing) {
        // Credential-less waitlist row (no `account` => cannot log in). role={}
        // overrides the admin column-default (database.js:1721).
        await User.upsert({
          id: randomUUID(),
          email,
          name: email.split('@')[0],
          emailVerified: false,
          role: {},
          status: 'provisional',
          signupMethod: 'waitlist',
        });
      }

      // Double opt-in. Enumeration-safe (no-ops for missing/verified user) so the
      // row MUST exist by here. No request headers => not session-scoped.
      await auth.api.sendVerificationEmail({ body: { email, callbackURL } });
      return res.json({ ok: true, status: 'pending', message: 'Check your inbox to confirm.' });
    } catch (err) {
      logger.error({ err: err?.message }, 'signup failed');
      return res.status(500).json({ error: "We couldn't process your sign-up. Please try again shortly." });
    }
  };

  signup.apiDoc = {
    summary: 'Public sign-up (waitlist / self-signup). Creates a PROVISIONAL user and fires an email challenge.',
    operationId: 'signup',
    tags: ['Users'],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              email: { type: 'string', format: 'email' },
              password: { type: 'string', minLength: 8, description: 'Optional. User is provisional either way.' },
            },
            required: ['email'],
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Sign-up accepted (pending email confirmation) or already on the list.',
        content: { 'application/json': { schema: {
          type: 'object',
          properties: { ok: { type: 'boolean' }, status: { type: 'string', enum: ['pending', 'already'] }, message: { type: 'string' } },
        } } },
      },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { POST: signup };
}
```

### 1.2 `GET /api/users` + `POST` (admin create) — ADMIN-GATED collection

**File:** `/Users/rob/Aplisay/code/llm-agent/api/paths/users.js` (one dir deep ⇒ `../../lib`).

`GET` lists users with `status`/`search` filter + pagination (mirror `agents.js` `{ items, next }`). Both verbs gated by `requireAdmin` (§5). `POST` here is an explicit admin-create alias (same primitive as signup but lets an admin mint a user directly). Returns `{ users, next }`.

```js
import { User, Op } from '../../lib/database.js';
import { requireAdmin } from '../../lib/admin-gate.js';   // §5

const LIST_ATTRS = ['id', 'name', 'email', 'emailVerified', 'status', 'role', 'signupMethod', 'createdAt', 'updatedAt'];
const sanitize = (raw) => String(raw ?? '').trim().replace(/[%_\\]/g, '');

export default function (logger) {
  const list = async (req, res) => {
    if (!requireAdmin(res.locals.user)) return res.status(403).json({ message: 'Admin only' });
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? 50), 10) || 50));
    const status = req.query.status ? String(req.query.status) : null;
    const search = sanitize(req.query.search);

    const where = {};
    if (status) where.status = status;
    if (search) {
      const p = `%${search}%`;
      where[Op.or] = [{ email: { [Op.iLike]: p } }, { name: { [Op.iLike]: p } }];
    }
    try {
      const { count, rows } = await User.findAndCountAll({
        where, attributes: LIST_ATTRS,
        order: [['createdAt', 'DESC'], ['id', 'ASC']], limit, offset,
      });
      const next = count > offset + rows.length ? offset + limit : false;
      return res.send({ users: rows, next });
    } catch (err) { req.log.error(err, 'listing users'); res.status(500).send(err); }
  };
  list.apiDoc = {
    summary: 'List users (admin).', operationId: 'listUsers', tags: ['Users'],
    parameters: [
      { in: 'query', name: 'limit',  required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      { in: 'query', name: 'offset', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
      { in: 'query', name: 'status', required: false, schema: { type: 'string', enum: ['provisional', 'active', 'suspended', 'deactivated'] } },
      { in: 'query', name: 'search', required: false, schema: { type: 'string' } },
    ],
    responses: {
      200: { description: '`{ users, next }`', content: { 'application/json': { schema: {
        type: 'object', properties: { users: { type: 'array', items: { type: 'object' } }, next: { oneOf: [{ type: 'integer' }, { type: 'boolean', enum: [false] }] } }, required: ['users', 'next'],
      } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  // Admin create — reuse the signup handler's body shape; same primitive.
  const create = async (req, res) => {
    if (!requireAdmin(res.locals.user)) return res.status(403).json({ message: 'Admin only' });
    // (delegate to the same create logic as signup, or set status from body)
    // ... mirror signup.js create branch, allowing admin to pass status ...
  };
  create.apiDoc = { summary: 'Create a user (admin).', operationId: 'adminCreateUser', tags: ['Users'], /* requestBody w/ email,password?,status?,role? */
    responses: { 200: { description: 'Created user' }, default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } };

  return { GET: list, POST: create };
}
```

### 1.3 `GET/PATCH/DELETE /api/users/{userId}` — ADMIN item route (the accept/activate primitive)

**File:** `/Users/rob/Aplisay/code/llm-agent/api/paths/users/{userId}.js` (two dirs deep ⇒ `../../../lib`; path-param name `userId` must equal the folder token — cf `agents/{agentId}.js:19,67`).

`PATCH` is the **accept/activate** action (`provisional → active`), plus `role`/`agentLimit`/`status` edits. **Direct Sequelize** (`user.status = ...; await user.save()`), because `active` is our own domain column not modelled by better-auth. Credential changes (set/reset password) are out of scope here — route those through `auth.api.setUserPassword` if/when needed.

Use `PATCH` not `PUT` (partial update, no collision risk with the POST-only signup sibling — see Risks).

```js
import { User } from '../../../lib/database.js';
import { requireAdmin } from '../../../lib/admin-gate.js';

const EDITABLE = ['status', 'role', 'agentLimit', 'name'];

export default function (logger) {
  const get = async (req, res) => {
    if (!requireAdmin(res.locals.user)) return res.status(403).json({ message: 'Admin only' });
    const u = await User.findByPk(req.params.userId);
    return u ? res.send(u) : res.status(404).send({ message: `User ${req.params.userId} not found` });
  };
  get.apiDoc = { summary: 'Get a user (admin).', operationId: 'getUser', tags: ['Users'],
    parameters: [{ in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
    responses: { 200: { description: 'User' }, 404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } } };

  const update = async (req, res) => {
    if (!requireAdmin(res.locals.user)) return res.status(403).json({ message: 'Admin only' });
    const u = await User.findByPk(req.params.userId);
    if (!u) return res.status(404).send({ message: `User ${req.params.userId} not found` });
    for (const k of EDITABLE) if (k in req.body) u[k] = req.body[k];   // e.g. { status: 'active' } = ACCEPT
    try { await u.save(); return res.send(u); }
    catch (err) { req.log.error(err, 'updating user'); res.status(400).send({ message: err.message }); }
  };
  update.apiDoc = {
    summary: 'Modify a user (admin): accept/activate, set role, agentLimit, etc.',
    operationId: 'updateUser', tags: ['Users'],
    parameters: [{ in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
    requestBody: { content: { 'application/json': { schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['provisional', 'active', 'suspended', 'deactivated'] },
        role: { type: 'object' }, agentLimit: { type: 'integer', nullable: true }, name: { type: 'string' },
      }, required: [],
    } } } },
    responses: { 200: { description: 'Updated user' }, 404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } },
  };

  const del = async (req, res) => {
    if (!requireAdmin(res.locals.user)) return res.status(403).json({ message: 'Admin only' });
    const u = await User.findByPk(req.params.userId);
    if (!u) return res.status(404).send({ message: `User ${req.params.userId} not found` });
    // Prefer soft-delete: set status='deactivated' rather than destroy (FK'd data).
    u.status = 'deactivated'; await u.save();
    return res.status(200).send();
  };
  del.apiDoc = { summary: 'Deactivate a user (admin, soft delete).', operationId: 'deactivateUser', tags: ['Users'],
    parameters: [{ in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
    responses: { 200: { description: 'Deactivated' }, 404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } } };

  return { GET: get, PATCH: update, DELETE: del };
}
```

### 1.4 Swagger visibility (optional)

`/api/users*` will appear in Swagger automatically (it's not `/agent-db`). To hide the admin routes but keep signup visible, extend the `securityFilter` at `index.mjs:99-103`:

```js
if (!shouldExposePrivateApis && req?.apiDoc?.paths) {
  for (const path of Object.keys(req.apiDoc.paths)) {
    if (path.startsWith('/agent-db')) delete req.apiDoc.paths[path];
    if (path.startsWith('/users') && path !== '/users/signup') delete req.apiDoc.paths[path]; // hide admin user routes
  }
}
```
Doc visibility is independent of enforcement. Default recommendation: **leave visible** (it's a private deployment) unless Rob wants the admin surface hidden.

---

## 2. Status model

**File:** `/Users/rob/Aplisay/code/llm-agent/lib/database.js`.

### 2.1 Add the column to `User.init` (after `signupMethod`, ~line 1347)

```js
status: {
  type: DataTypes.ENUM('provisional', 'active', 'suspended', 'deactivated'),
  allowNull: false,
  defaultValue: 'provisional',
},
```

### 2.2 Bump `schemaVersion` 40 → 41 (`database.js:17`)

```js
// 41: users.status lifecycle enum (provisional default) for the provisional gate
const schemaVersion = 41;
```

### 2.3 Postgres column default — the FOOTGUN guard (`database.js:1719-1723`)

better-auth's Kysely inserts bypass Sequelize defaults (this is exactly why `role`/`signup_method` have explicit Postgres defaults). Add `status` alongside them so **any** better-auth-created row lands provisional, never active:

```js
await setColumnDefault('users', 'role', `'{"admin":true,"join":true}'::jsonb`);
await setColumnDefault('users', 'signup_method', `'better-auth'`);
await setColumnDefault('users', 'status', `'provisional'`);   // <-- add
```

### 2.4 Backfill existing rows

After `User.sync({ alter: true })` creates the column (with default `provisional`), existing rows would otherwise become provisional and get gated out. **Backfill all current rows to `active`** so existing users aren't jailed. Add a one-shot after the sync chain (e.g. in the `.then()` at `database.js:1719`, guarded to run once):

```js
// Existing pre-status rows are real users; only NEW signups should be provisional.
await sequelize.query(`UPDATE "users" SET "status"='active' WHERE "status"='provisional' AND "created_at" < NOW() - INTERVAL '1 minute'`);
```
(Or gate on a metadata flag so it runs only on the 40→41 upgrade. The time-window form is the simplest fail-safe.)

### 2.5 Interaction with `email_verified` — orthogonal axes

| `status` | `email_verified` | Meaning |
|---|---|---|
| `provisional` | `false` | Signed up, dormant until they click the email link |
| `provisional` | `true` | Confirmed email but **still in waitlist jail** — awaiting admin accept |
| `active` | `true` | Live user, full API access |

`email_verified` is flipped by better-auth's `/api/auth/verify-email` (it does **not** touch `status`). The **gate keys on `status` only**. `requireEmailVerification` (better-auth, `lib/auth/index.js:98`) independently governs login. Do **not** gate on `role` — it defaults `{admin:true,join:true}` for everyone and is enforced nowhere.

---

## 3. The provisional gate

**Files:** `/Users/rob/Aplisay/code/llm-agent/middleware/auth.js` + `middleware/no-auth.js`.

### 3.1 Skip-list change (`auth.js:23-32`)

Replace the `/api/waitlist` entry with the signup sub-path **only** (not all of `/api/users`, or the admin routes would be public):

```js
|| req.originalUrl.startsWith('/api/api-docs')
|| req.originalUrl.startsWith('/api/hooks')
|| req.originalUrl.startsWith('/api/auth')        // better-auth: email verify + reset live here
|| req.originalUrl.startsWith('/api/users/signup') // <-- replaces /api/waitlist
```

### 3.2 The gate — inline in the two HUMAN branches only

Add a tiny helper at top of `auth.js` and call it in the better-auth branch (after `auth.js:116`) and the firebase branch (after `auth.js:126`), each immediately **before** their `next()`:

```js
// Module scope:
function isActive(user) {
  const status = (user && typeof user.get === 'function') ? user.get('status') : user?.status;
  // Fail-CLOSED: a loaded human principal with a non-active (or missing) status is blocked.
  return status === 'active';
}
function gateProvisional(res) {
  if (!isActive(res.locals.user)) {
    res.status(403).json({ message: 'account_pending', detail: 'Your account is awaiting activation.' });
    return false;
  }
  return true;
}
```

**Better-auth branch** (`auth.js:114-118`):
```js
res.locals.user = await User.findByPk(baUser.id) || baUser;
res.locals.userAuth = true;
res.locals.user.sql = { where: scopeWhereForUser(res.locals.user) };
if (!gateProvisional(res)) return;   // <-- gate
next();
```

**Firebase branch** (`auth.js:125-127`):
```js
res.locals.user = await User.import({ ...user, id: user.user_id });
res.locals.user.sql = { where: scopeWhereForUser(res.locals.user) };
if (!gateProvisional(res)) return;   // <-- gate
next();
```

### 3.3 Exempt principals (structurally untouched — no code needed)

| Principal | Why exempt | Mechanism |
|---|---|---|
| **System** (`x-shared-token`) | `isSystem` plain object, no `status` | Early-returns at `auth.js:42-51` **before** the human branches — gate never runs |
| **Instance** (join token) | Sets `res.locals.instance`, not `res.locals.user` | Returns at `auth.js:68-82` — gate never runs |
| **AuthKey** | Real `User` row carries `status`; keys are admin-minted | AuthKey branch (`auth.js:86-94`) calls `next()` **before** reaching the better-auth/firebase branches — the gate is only in those two branches, so AuthKey is never gated. *(Belt-and-braces: it could be tagged `res.locals.isAuthKey=true`, but placement already exempts it.)* |
| **`/api/auth/*`, `/api/users/signup`** | Where a provisional user makes progress (verify email, future self-serve) | Skip-list (§3.1) — middleware returns at the top |

The firebase fallback at `auth.js:114` (`|| baUser`) means a missed `findByPk` yields a bare object without `status` — `isActive` returns `false` ⇒ **fail-closed**, which is correct for the gate (a session whose user row we can't load should not get through).

### 3.4 `no-auth.js` — leave unchanged

`AUTHENTICATE_USERS="NO"` mode sets a `defaultUser` with no `status`. Adding the gate there would lock out single-tenant/no-auth deployments. **Do not gate in `no-auth.js`.** (Optionally set `status:'active'` on `defaultUser` for tidiness, but it is never consulted because the gate is auth.js-only.)

---

## 4. User creation with optional password — concrete mechanism

| Case | Mechanism | Why |
|---|---|---|
| **No password** (waitlist) | `User.upsert({ ..., role:{}, status:'provisional', signupMethod:'waitlist' })` then `auth.api.sendVerificationEmail` | Simplest; no `account` row ⇒ cannot log in; exactly today's `lib/waitlist.js`. |
| **With password** (self-signup) | `auth.api.createUser({ body:{ email, name, password, data:{ status:'provisional', signupMethod:'self-signup', role:{} } } })` — **no headers** | better-auth writes the credential hash + `account` row correctly. `data` bag bypasses `input:false` (admin `createUser` path skips `parseUserInput`). No headers ⇒ session is `null` ⇒ admin-permission check short-circuits. The user is **still provisional** ⇒ cannot perform API ops until an admin activates. |

**Do NOT enable the `admin()` plugin now.** It registers a login `databaseHook` that reads `user.banned` and ban routes that write `banned/banReason/banExpires`; without those columns ban/unban error at runtime. We add the columns now (zero-cost forward-compat) but keep `plugins:[bearer()]` unchanged in `lib/auth/index.js:180`.

**Columns to add for future `admin()` (alongside `status` in `User.init`):**
```js
banned:     { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
banReason:  { type: DataTypes.STRING,  allowNull: true },
banExpires: { type: DataTypes.DATE,    allowNull: true },
```
These are `required:false` in better-auth's admin schema, so present-but-unused is harmless. (Defer the `session.impersonated_by` column — only needed if impersonation is enabled.)

---

## 5. Admin permission check — minimal safe gate for today

**File (new):** `/Users/rob/Aplisay/code/llm-agent/lib/admin-gate.js`.

There is **no enforced RBAC** today: `role` is written (default `{admin:true,join:true}` for everyone) but read by no route gate. So `role.admin` is worthless as a discriminator. The honest minimal gate is an explicit env allowlist:

```js
/** Minimal admin gate (phase 1). Swap body for requirePermission() when RBAC lands. */
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean);

export function requireAdmin(user) {
  if (!user) return false;
  if (user.isSystem === true) return true;             // x-shared-token internal principal
  return ADMIN_USER_IDS.includes(user.id);             // explicit human-admin allowlist
}
```

Used by every `/api/users` and `/api/users/{userId}` handler (returns `403 { message:'Admin only' }`). `signup.js` does **not** use it (public). When the migration plan's `role`-string + `requirePermission` lands (Phase 2/4), swap the helper body — call sites don't change.

**New env var:** `ADMIN_USER_IDS` (comma-separated user ids). Document in `.env`/`env-example`.

---

## 6. Email challenge

- **Reuse** `auth.api.sendVerificationEmail({ body:{ email, callbackURL } })` — already wired (`lib/auth/index.js:158-177`, plain-text, 7-day token). Called with **no headers** so it's not session-scoped; enumeration-safe (no-ops for missing/verified user) so the row must exist first (it does, after the upsert/createUser).
- **`callbackURL`** = `process.env.WAITLIST_CALLBACK_URL` (same env as today, `waitlist.js:38`). Points at polite-ai's `/confirmed` page. The better-auth trusted-origins already include `http://localhost:5173` for the polite-ai dev server (`lib/auth/index.js:80-82`).
- **Confirmation flow:** the link hits better-auth `/api/auth/verify-email` → flips `email_verified=true` → redirects to `callbackURL`. This **does not change `status`**. The user remains `provisional` (still gated) until an admin `PATCH /api/users/{userId} { status:'active' }`. Lifecycle: `signup → provisional+unverified → (email click) provisional+verified → (admin accept) active`.

---

## 7. Retire `/api/waitlist` + polite-ai repoint

### 7.1 llm-agent — remove the plain route

- **`index.mjs:70-77`** — delete the `if (betterAuth) { ... server.post('/api/waitlist', waitlistHandler) ... }` block.
- **`middleware/auth.js:28`** — remove `|| req.originalUrl.startsWith('/api/waitlist')` (replaced by the `/api/users/signup` entry in §3.1).
- **`lib/waitlist.js`** — delete the file (logic now lives in `api/paths/users/signup.js`). Grep for stray imports first: `grep -rn "waitlist" /Users/rob/Aplisay/code/llm-agent --include='*.js' --include='*.mjs' | grep -v node_modules`.
- Keep `WAITLIST_CALLBACK_URL` env (still used by `signup.js`). Optionally rename to `SIGNUP_CALLBACK_URL` later — out of scope.

### 7.2 polite-ai — repoint the register route

> **Path correction:** Rob's spec names `app/routes/api.register.tsx` (RR7 convention). The actual file in the polite-ai repo (`/Users/rob/Aplisay/sites/polite-ai`, on branch `better-auth`) is the **Next.js App Router** handler **`/Users/rob/Aplisay/sites/polite-ai/app/api/register/route.ts`**. The frontend (`components/Capture.tsx:38`) posts to `/api/register`.

**Important nuance:** today's `route.ts` is **self-contained on Prisma** — it writes a local `Signup` row + sends its own confirmation email via `/api/confirm`. It does **not** currently call llm-agent's `/api/waitlist` at all. The repoint replaces the Prisma+local-email body with a single fetch to llm-agent's `POST /api/users/signup`, passing through the `{ ok, status, message, error }` contract.

Rewrite `app/api/register/route.ts` POST body to:
```ts
const res = await fetch(`${process.env.LLM_AGENT_URL}/api/users/signup`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email }),   // no password for waitlist
});
const data = await res.json().catch(() => ({}));
return NextResponse.json(data, { status: res.status });
```
- Map llm-agent's `status:'already'` → the frontend's expected `'already_confirmed'` if you want `Capture.tsx:46` to keep working unchanged, **or** update `Capture.tsx:46` to accept `'already'`. The contract Rob fixed is `{ ok, status, message, error }`; `Capture.tsx` reads `data.status` (ok path) and `data.error` (error path) — both satisfied.
- Add `LLM_AGENT_URL` to polite-ai `.env`/`env-example`.
- The Prisma `Signup` model, `/api/confirm/route.ts`, `lib/email`, and the local token machinery become **dead** once llm-agent owns signup + verification. **Decision:** leave them in place for this WIP (lowest blast radius); flag a follow-up to delete Prisma signup + `/api/confirm` + `/confirmed` repoint to the better-auth callback. (The `/confirmed` page stays — it's the `WAITLIST_CALLBACK_URL` target.)

---

## 8. Risks / edge cases

1. **Route collision:** `users/signup.js` (POST-only) is a literal sibling of `users/{userId}.js`. They coexist only because signup is POST and the item route is GET/PATCH/DELETE. **Never add POST to `users/{userId}.js`** or `/api/users/signup` could be shadowed. Verify route registration at boot.
2. **Backfill ordering (§2.4):** the new `status` column defaults `provisional`; without the backfill, **every existing user is instantly gated out**. Ship the column + Postgres default + backfill **in one commit**. Use `forceSync`/`DB_FORCE_SYNC` semantics (`database.js:1678`) — the column is only added when `doUpgrade` is true.
3. **Footgun parity:** `status` needs **both** a Sequelize default (Sequelize/`User.upsert` path) **and** a Postgres `setColumnDefault` (better-auth Kysely path). Missing the Postgres default ⇒ better-auth signups land `NULL` ⇒ `isActive` fail-closed blocks them — which is *safe* but would block a legit self-signup before admin accept (actually correct), yet a `NULL`-status better-auth *login-migration* row would also be blocked. Setting the PG default to `provisional` makes the behaviour explicit.
4. **Fail-closed firebase fallback:** `auth.js:114 || baUser` can yield a status-less object; `isActive` returns `false`. Acceptable (don't admit a principal we can't load), but note it could surprise during a DB blip — log it.
5. **`createUser` headerless invocation** is load-bearing: with headers it 403s (admin-permission check against the JSONB `role`). Document the no-headers call in `signup.js`.
6. **ENUM evolution:** Sequelize `sync({alter:true})` creates the ENUM type but won't add values later — future `status` values need `addEnumValueIfMissing` (`database.js:1642`). The four values are chosen up front.
7. **Gate placement invariant:** the gate must register **before** `openapi.initialize`. This holds given `index.mjs` order (auth `:91`, openapi `:108`). If reordered, the gate (and all auth) is bypassed — document the invariant.
8. **`startsWith` skip-list breadth:** `/api/users/signup` also exempts a hypothetical `/api/users/signupX`. No such route today; if added, switch to exact `path`+`method` check.
9. **polite-ai dual-write risk:** until the Prisma `Signup` path is fully removed, ensure the rewritten `route.ts` does **not** also write Prisma — pick one source of truth (llm-agent).

---

## Ordered task list

1. **`lib/database.js`** — add `status` ENUM (default `provisional`) + `banned/banReason/banExpires` to `User.init`; bump `schemaVersion` 40→41 (+ comment); add `setColumnDefault('users','status',"'provisional'")`; add the one-shot backfill `UPDATE users SET status='active'` for pre-existing rows. *(One commit — schema + default + backfill together.)*
2. **`lib/admin-gate.js`** (new) — `requireAdmin(user)` (isSystem OR `ADMIN_USER_IDS`).
3. **`api/paths/users/signup.js`** (new) — port `waitlist.js`; add `status:'provisional'`; optional-password via headerless `auth.api.createUser`; `{ ok, status, message }` / `{ error }`.
4. **`api/paths/users.js`** (new) — admin `GET` (status/search filter, `{users,next}`) + admin `POST` (create), both `requireAdmin`-gated.
5. **`api/paths/users/{userId}.js`** (new) — admin `GET`/`PATCH` (accept/activate, set role/limit)/`DELETE` (soft-deactivate), `requireAdmin`-gated.
6. **`middleware/auth.js`** — skip-list: drop `/api/waitlist`, add `/api/users/signup`; add `isActive`/`gateProvisional` helpers; call `gateProvisional` in the better-auth branch (after `:116`) and firebase branch (after `:126`) before each `next()`.
7. **`index.mjs`** — delete the `/api/waitlist` mount (`:70-77`); (optional) extend `securityFilter` to hide `/users` admin paths.
8. **Delete `lib/waitlist.js`**; grep for residual references.
9. **Env** — add `ADMIN_USER_IDS` (llm-agent), `LLM_AGENT_URL` (polite-ai); keep `WAITLIST_CALLBACK_URL`.
10. **polite-ai `app/api/register/route.ts`** — replace Prisma+local-email body with a passthrough `fetch` to llm-agent `POST /api/users/signup`; preserve `{ ok, status, message, error }`; map `'already'`↔`'already_confirmed'` (or update `Capture.tsx:46`).
11. **Boot smoke test** — confirm `/api/users/signup` is registered (POST) and NOT shadowed; confirm a provisional better-auth session gets `403 account_pending`; confirm `x-shared-token`, AuthKey, and instance principals are unaffected; confirm admin `PATCH {status:'active'}` ungates.

---

### Key file references (verified)
- Routes pattern: `/Users/rob/Aplisay/code/llm-agent/api/paths/agents.js` (factory, `{POST,GET}`, apiDoc, `{items,next}`), `/Users/rob/Aplisay/code/llm-agent/api/paths/agents/{agentId}.js:1-15,17-21,59-72` (item route, `../../../lib`, path-param `agentId`, 404 shape).
- Gate + skip-list: `/Users/rob/Aplisay/code/llm-agent/middleware/auth.js:23-32` (skip-list), `:42-51` (system early-return), `:68-82` (instance), `:86-94` (AuthKey), `:114-118` (better-auth gate site), `:125-127` (firebase gate site); `/Users/rob/Aplisay/code/llm-agent/middleware/no-auth.js:3-14` (leave unchanged).
- Schema: `/Users/rob/Aplisay/code/llm-agent/lib/database.js:17` (schemaVersion), `:1302-1348` (User.init, signupMethod last), `:1658-1664` (`setColumnDefault`), `:1699,1719-1723` (User.sync + existing role/signup_method defaults), `:1642` (`addEnumValueIfMissing`).
- Mounts to retire: `/Users/rob/Aplisay/code/llm-agent/index.mjs:70-77` (waitlist mount), `:99-103` (securityFilter), `:108-118` (openapi.initialize); `/Users/rob/Aplisay/code/llm-agent/lib/waitlist.js` (delete).
- better-auth config: `/Users/rob/Aplisay/code/llm-agent/lib/auth/index.js:130-138` (modelName users), `:158-177` (sendVerificationEmail), `:180` (`plugins:[bearer()]` — admin() NOT added).
- Error schemas: `/Users/rob/Aplisay/code/llm-agent/api/api-doc.yaml:1304` (Error `{code,message}`), `:1315` (NotFound `{message}`).
- polite-ai repoint: `/Users/rob/Aplisay/sites/polite-ai/app/api/register/route.ts` (the real file — Next.js App Router, currently Prisma-self-contained, NOT a proxy), `/Users/rob/Aplisay/sites/polite-ai/components/Capture.tsx:38,44-53` (posts `/api/register`, reads `data.status`/`data.error`). Repo is on branch `better-auth`. **Note:** the spec's `app/routes/api.register.tsx` does not exist; the correct target is `app/api/register/route.ts`.
