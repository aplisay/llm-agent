> **Internal design doc — DRAFT, awaiting review (not yet implemented).** Branch `better-auth`. Closes the gap from "the better-auth proto runs on localhost with the flag on" to "safe to enable in production next to Firebase." See also [better-auth-migration-plan.md](./better-auth-migration-plan.md) and [users-api-design.md](./users-api-design.md).

# Better-Auth → Production-Real Hardening Plan (parallel with Firebase)

llm-agent, branch `better-auth`, with this session's WIP. Canonical plan: [`better-auth-migration-plan.md`](./better-auth-migration-plan.md) (this directory). This plan assumes the server is **already mounted and working** (`index.mjs:61-66`, `middleware/auth.js:96-118`, `lib/auth/index.js`). It closes the gap from *runs-on-localhost-with-flag-on* to *safe to enable in prod next to Firebase*. The user-status/lifecycle column, provisional-user API gate, admin user-management API, and RBAC enforcement (`permissions.js`, `requirePermission`, the text-vs-voice gate) are **owned by the separate `/api/users` design** and are NOT re-planned here.

## 1. Status table

| # | Hardening item | Status | Owner |
|---|---|---|---|
| 1 | BA handler mounted before `express.json()`; CORS exposes `set-auth-token` | DONE | `index.mjs:47-66` |
| 2 | Middleware 5th branch, correct precedence, converges on `res.locals.user` + `scopeWhereForUser` | DONE | `middleware/auth.js:96-118` |
| 3 | Identity bridge — social `accountLinking` + password `sendResetPassword` to @aplisay/email | DONE | `lib/auth/index.js:104-116,147-152` |
| 4 | `signupMethod` column + defaults; schemaVersion 40 | DONE | `database.js:1344-1347,1722` |
| 5 | Frontend BA client (bearer capture/replay) + `AUTH_PROVIDER` build switch | DONE — no change needed (getSession + cache keeps the existing session-token flow) | llm-frontend |
| 6 | Env documented (`BETTER_AUTH_*`, Google, EMAIL_SEND_*, waitlist callback) | DONE | `environment-example:18-57` |
| 7 | `@better-auth/cli` pinned + `yarn auth:migrate`/`auth:generate` scripts (`jose` not needed — getSession + cache) | DONE | `package.json`, `scripts/better-auth-config.mjs` |
| 8 | `additionalFields` so BA knows domain columns (role/org/agentLimit/phone) | TODO | `lib/auth/index.js` |
| 9 | Session-verification cost — **DECIDED: keep `getSession` + short-TTL in-process cache** (not JWT, not Redis) | **IMPLEMENTED (WIP)** | `middleware/auth.js` |
| 10 | Temporary `User.import` field-restriction (anti-clobber) | TODO | `database.js:1264-1279` |
| 11 | `@better-auth/cli migrate` for satellite tables, wired into deploy, fenced off `users` | TODO | Dockerfile / cloudbuild.yaml |
| 12 | CORS + `BETTER_AUTH_TRUSTED_ORIGINS` for the real prod dashboard origin | TODO | `index.mjs:47-51`, env |
| 13 | Prod secrets provisioned + hard-fail on missing `BETTER_AUTH_SECRET` | TODO | `lib/auth/index.js:52-54`, secretenv |
| 14 | `requireEmailVerification` flipped consistently (server + SPA) for prod | OPEN DECISION | env both repos |
| 15 | `email_verified` backfill precondition for social auto-link | TODO | runbook + backfill |
| 16 | Fix `User.import` unreachable cache-set bug (`database.js:1277`) | TODO | `database.js:1277` |
| 17 | Tests: precedence, fallthrough, bridge link/refuse, token verify, waitlist inertness | TODO | `tests/` |
| 18 | role JSONB→STRING migration + `'owner'` backfill; drop legacy jsonb default | covered by /users design | `database.js:1332-1335,1721` |
| 19 | `permissions` JSONB, `status` ENUM, `banned/banReason/banExpires`, `emailVerifiedAt/phoneVerifiedAt`, Org `status/verifiedAt` | covered by /users design | §5 |
| 20 | `permissions.js` (ac/statements/roles), `requirePermission`, text-vs-voice gates, `admin()` plugin | covered by /users design | §4 |
| 21 | Phase-3 Firebase deprecation (drop branch, databaseHooks sole writer) | DEFERRED (post-parallel) | §3 Phase 3 |
| 22 | Unauthenticated WS streams (F-1) | DEFERRED (flag, don't block) | `docs/security.md` F-1 |

---

## 2. Remaining work as file-level steps

### Phase 0-finish — make the proto correct before any non-local enable

**A. `package.json` — pin/declare the migration deps.**
*What:* add `@better-auth/cli` to `devDependencies` and pin `better-auth` to an exact version (drop the `^` on `^1.6.20`). *Why:* §7 warns "Better-Auth moves fast — pin a version"; `@better-auth/cli` is invoked via `npx` from a comment only (`environment-example:35`), a supply-chain/repro risk for the migration step. (`jose` is **not** needed — the getSession+cache decision means no JWKS verification.)

**B. `lib/auth/index.js:130-138` — add `additionalFields` to the `user` block.**
*What:* declare `role`, `permissions`, `organisationId`, `agentLimit`, `phone`, `phoneVerified`, `status` as `additionalFields` (mapped to snake_case, all `input:false` so the public sign-up API can't set them). *Why:* today BA's `user` model only knows the 4 identity fields; it cannot read or surface the domain columns through its API, and `getSession().user` returns a thin object. The actual *values* are still defaulted at the DB layer (`database.js:1721-1722`) so direct BA inserts stay shaped like Firebase rows — but `additionalFields` is the prerequisite for the admin()/RBAC slice in the `/users` design to read role/status through BA. **Sequence this with the §5 column migration** (item 18, /users design) so the field names exist before they're declared.

**C. `lib/auth/index.js:52-54` — hard-fail on missing secret.**
*What:* change the `logger.error` to a thrown error / `process.exit(1)` when `BETTER_AUTH_ENABLED==='true'` and `BETTER_AUTH_SECRET` is unset. *Why:* today a prod deploy missing the secret runs with broken token signing instead of failing fast. Match the pattern from commit 9fc5570 ("Hard fail missing environment").

**D. `database.js:1264-1279` — temporary `User.import` field-restriction (HIGHEST-PRIORITY parallel-phase fix).**
*What:* narrow the upsert so a Firebase-authed request only writes Firebase-owned fields and never overwrites BA-managed ones. Concretely: on an existing row, do not overwrite `emailVerified`, `name`, `picture`, `signupMethod`, or `role`; only insert these on a genuinely new row. Use `User.findByPk` first, or `upsert` with an explicit `fields:` allowlist for the update path, or `INSERT … ON CONFLICT DO NOTHING` semantics for the BA-managed columns. *Why:* `User.import` is currently a full unconditional upsert (`database.js:1272`) — during parallel running any Firebase request to a shared row clobbers `emailVerified/name/picture` and resets `signupMethod` to `'firebase'` and `role` to `{admin,join}` on a BA-created row. This is §7's "Dual-writer clobber" and §2.2's temporary scaffolding, currently **unimplemented and live**. Must land before any shared-row parallel running.

**E. `database.js:1277` — fix the unreachable cache-set.**
*What:* `User.cachedUsers.set(...)` sits after the `return` inside the `try`, so it never runs; move it before the return (and reference the right variable). *Why:* pre-existing bug — the per-request user cache never populates on the Firebase path, adding a needless DB hit per request. Cheap to fix while editing this function for (D).

**F. `middleware/auth.js` — keep `getSession()` + a short-TTL in-process session cache (DECIDED 2026-06-24: getSession + cache, NOT JWT). — IMPLEMENTED (WIP).**
*Done:* the Better-Auth branch verifies via `betterAuth.api.getSession()`, wrapped in a per-process LRU keyed on the bearer token (`BA_SESSION_TTL_MS = 60s`, `BA_SESSION_MAX = 5000`): a cache **hit** returns the resolved Sequelize `User` with **no DB read**; a **miss** does one `getSession` (+ `User.findByPk`) and caches the result. Mirrors the existing `AuthKey` 60s cache. `res.locals.user` + `scopeWhereForUser` unchanged. *Why:* the only objection to `getSession` was a Postgres session read on **every** API call; the cache collapses that to ~one read per token per 60s per instance — **zero new infra, zero frontend change**.
*Options considered (verified against better-auth v1.6.20 source):* `session.cookieCache` cannot help a cross-origin **bearer/localStorage** SPA (the cache lives in a `session_data` cookie the bearer plugin never populates and the SPA can't read/replay); `secondaryStorage`/Redis works with no frontend change + immediate revocation but adds infra; `jwt()`/JWKS works with no infra but needs a frontend token-exchange (`GET /api/auth/token`) + refresh. The **in-process cache** was chosen as the simplest that removes the Postgres cost.
*Trade-off accepted:* a logout / user-row change (role/**status**) takes up to the TTL (~60s) to apply, **per instance**. So the `/users` provisional-`status` gate is eventually-consistent within the TTL — for an immediate hard kill, lower the TTL or add explicit cache invalidation. See risk 11.
*Not adopted / reverted:* `jwt()` plugin, JWKS, the `jose` dep, the `jwks` table, and any frontend token-exchange.

### Phase parallel-enable — safe to flip `BETTER_AUTH_ENABLED=true` on staging/prod

**G. Dockerfile / `deploy/gcp/cloudrun/cloudbuild.yaml` — wire satellite-table migration, fenced off `users`.**
*What:* add a migration step that creates BA's `session`/`account`/`verification` tables (no `jwks` table — the `jwt()` plugin isn't used; see item F). Two options:
- *Preferred — entrypoint script:* replace `CMD ["yarn","start"]` with an entrypoint that runs `npx @better-auth/cli migrate --yes` then `yarn start`. Idempotent, runs against the live `DATABASE`/`POSTGRES_*` the container already has, and re-runs automatically on every BA version bump.
- *Alternative — cloudbuild step:* insert a step between Push and Deploy that runs `migrate` against the Cloud SQL instance.

*Critical fence:* the CLI must **never** touch the shared `users` table (§7 "Dual schema ownership" — Sequelize is DDL owner). Because `user.modelName='users'` points BA at our table, run `@better-auth/cli generate` once and inspect the diff in review; configure/verify it only emits DDL for the satellite tables. The current Dockerfile (`yarn install → COPY → yarn start`) and cloudbuild (`build → push → deploy`) have **no migration step**, so on a fresh prod DB every BA sign-in / token issuance fails outright. This must land before any non-local enable.

**H. `index.mjs:47-51` + `BETTER_AUTH_TRUSTED_ORIGINS` env — real prod origins.**
*What:* (1) In env, set `BETTER_AUTH_TRUSTED_ORIGINS` to the real playground-dashboard origin **and** the polite.ai origin (the waitlist verification `callbackURL` origin must be present or the post-verify redirect is origin-rejected). (2) In CORS (`index.mjs:49-51`), confirm the prod dashboard matches `/https:\/\/.*\.aplisay\.com$/`, add the polite.ai origin if it's a different domain, and **prune the stale hardcoded `feature-registration-db--playground-next.netlify.app`** preview origin. *Why:* `trustedOrigins` falls back to localhosts when env is unset (`lib/auth/index.js:78-82`); a missing trusted origin breaks OAuth + waitlist-verify redirects at runtime, not build time. Both layers must list the same real origins.

**I. Prod secrets (secretenv bundle) — provision the live values.**
*What:* set `BETTER_AUTH_SECRET` (strong random), `BETTER_AUTH_URL` = the public prod API origin (used as `baseURL` + the Google OAuth callback base — defaults to `localhost:WS_PORT` otherwise), real prod-project `BETTER_AUTH_GOOGLE_CLIENT_ID/_SECRET` with the prod `/api/auth/callback/google` redirect URI registered in the Google console, and `EMAIL_SEND_*` (SMTP2GO). *Why:* all read from env (`lib/auth/index.js:84-125`), none provisioned; absent Google creds make `socialProviders` `undefined` and Google sign-in silently disappears; absent email creds make verification/reset emails log-only. **Set `BETTER_AUTH_ENABLED` deliberately per environment** — the WIP `environment-example` ships it `=true`, but the plan calls for default-off until the above is in place.

**J. `requireEmailVerification` — flip consistently for prod (Open Decision 4).**
*What:* if preserving Firebase's verified-email-to-login gate, set **both** `BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION=true` (server, `lib/auth/index.js:98`) **and** `REACT_APP_REQUIRE_EMAIL_VERIFICATION=true` (SPA). *Why:* both default OFF in `environment-example` while Firebase today gates `loggedIn` on `emailVerified`; enabling BA in prod with only one flag set silently weakens the login gate or produces a UX mismatch. `sendOnSignUp:true` (`lib/auth/index.js:159`) already mails a verification link on every email/password signup.

### Phase backfill/migrate — identity continuity

**K. `email_verified` backfill (runbook + one-off).**
*What:* either (a) backfill `email_verified=true` on `users` rows for Firebase users known-verified (export from Firebase, set the column for matching emails), or (b) accept that unverified/dormant rows migrate via the forgot-password path and document it. *Why:* social auto-link refuses unless the existing row's `email_verified=true` (BA default `requireLocalEmailVerified`; `lib/auth/index.js:143-145`). Today `email_verified` is only written when a Firebase user logs in post-deploy via `User.import` (`middleware/auth.js:125`), so dormant Google users would silently fall to forgot-password or be refused — a UX cliff needing a comms plan, not just code (§2.4 "main gotcha").

**L. No id-preserving user copy needed — confirm lazy strategy.**
*What:* document that the unified `users` table means existing rows already "look like" BA users; identity is bridged lazily per-user (social link / password reset), so there is **no bulk id-preserving backfill** (§2.4). *Why:* avoid someone building a redundant/dangerous user-copy migration. The only backfills that exist are (K) above and the role-string backfill (item 18, owned by /users design).

### Phase 3 — Firebase deprecation (post-parallel, do NOT start now)

**M.** Once all active users are bridged: remove the Firebase branch (`middleware/auth.js:120-132`), delete `User.import` + its temporary restriction and move row-creation to BA `databaseHooks` as sole writer (`database.js:1264-1279`), drop `firebase-admin` + the firebase init block (`middleware/auth.js:10-18`), retire the Firebase project. Reconcile transport to the chosen target (cookie sessions or `jwt()`).

### Tests (hard production-real gate — currently zero coverage)

**N. New `tests/` files.** *What:* cover (1) **middleware precedence** — shared-token → instance → AuthKey → BA → Firebase, first-success-wins, AuthKey-before-BA and BA-before-Firebase fallthrough (`middleware/auth.js:84-132`); (2) **session verification** — `getSession` valid/null + the in-process cache (hit returns the cached user with no DB read; entry expires after the TTL; a non-BA token returns null and falls through); (3) **identity bridge** — social link onto verified row, refuse on unverified, password-reset creates credential on existing row; (4) **waitlist** enumeration-safety + credential-less inertness; (5) **dual-writer guard** — a Firebase request does not clobber BA-managed fields after (D). *Why:* §6's last task; regressions in the multi-branch middleware would otherwise be silent.

---

## 3. Risk register (severity-ordered)

1. **Satellite tables don't exist in prod (BLOCKS enable).** On a fresh staging/prod DB the `session`/`account`/`verification` tables are never created — the migration is a manual `npx` note only (`environment-example:35`); Dockerfile and cloudbuild have no step. Every BA sign-in / token issuance fails. *Mitigate:* item G (entrypoint or cloudbuild migrate), fenced off `users` via inspected `generate` diff. **Must precede any non-local enable.**

2. **Dual-writer clobber (LIVE, unmitigated).** `User.import` is a full unconditional upsert (`database.js:1272`); a Firebase request to a shared row overwrites `emailVerified/name/picture`, resets `signupMethod`/`role`. *Mitigate:* item D field-restriction. **Must land before any shared-row parallel running.**

3. **Dual schema ownership / CLI touching `users`.** If `@better-auth/cli migrate` alters the shared `users` table it fights Sequelize's DDL ownership (§7). *Mitigate:* run `generate` and inspect the diff; ensure migration only emits satellite-table DDL; never `--yes` migrate without that confirmation. Tie to item G.

4. **Identity continuity / `email_verified` precondition.** Dormant or `email_verified=false` Firebase rows silently refuse Google auto-link (`lib/auth/index.js:143-145`, `middleware/auth.js:125`). *Mitigate:* item K backfill or a documented forgot-password fallback + user comms.

5. **role-default footgun.** `setColumnDefault` still writes the legacy `{admin,join}` jsonb default (`database.js:1721`) while §5/RBAC want string `'owner'`. RBAC can't read a string role until migrated, and `sync({alter:true})` won't safely do JSONB→STRING. *Mitigate:* the dedicated role migration + `'owner'` backfill (owned by /users design) must precede flipping any route gate; coordinate so the legacy default is dropped in the same change.

6. **Cache staleness (DECIDED: cached `getSession`).** Verification uses `getSession()` wrapped in a 60s in-process cache (item F), so a logout or user-row change (role/**status**) can lag up to the TTL, **per instance** (the cache is per-process, not shared across Cloud Run instances). *Mitigate:* keep the TTL short; for an immediate hard kill, lower it or invalidate the cache entry on the mutating action (e.g. when an admin flips `status`). This is the accepted trade for removing the per-call Postgres read.

7. **`BETTER_AUTH_SECRET` soft-fail.** Only logs an error if unset (`lib/auth/index.js:52-54`); a prod deploy missing it runs with broken signing. *Mitigate:* item C hard-fail.

8. **Prod origin allowlist unproven.** `trustedOrigins` falls back to localhosts (`lib/auth/index.js:78-82`); CORS has a stale netlify preview (`index.mjs:50`). A missing trusted origin breaks OAuth + waitlist-verify redirects at runtime. *Mitigate:* item H.

9. **`requireEmailVerification` defaults OFF both ends.** Enabling BA without setting both flags weakens the login gate vs Firebase today. *Mitigate:* item J (Open Decision 4).

10. **better-auth version pinning / supply-chain.** `^1.6.20` caret (§7 "moves fast"); `@better-auth/cli` invoked via `npx` from a comment. *Mitigate:* item A — exact pin + wire the CLI into deploy.

11. **Secret rotation = fleet logout.** Rotating `BETTER_AUTH_SECRET` invalidates all session tokens (and the bearer-plugin HMAC), forcing a fleet-wide re-login. *Mitigate:* treat rotation as a deliberate logout-all event and schedule it. (Sessions are stateful in Postgres + the in-process cache; no JWT/JWKS in play, so there is no key-overlap rotation to manage.)

12. **Unauthenticated WS streams (F-1).** WS transcript/audio/progress streams bypass Express auth entirely (`docs/security.md` F-1). BA doesn't change this. *Mitigate:* later, validate a BA token/instance.key in the upgrade handshake. **Flag, do not block the BA cutover.**

---

## 4. Open decisions for Rob

1. ~~Transport / session-verification cost~~ — **DECIDED (2026-06-24): keep `getSession` + a 60s in-process cache (item F). NOT JWT, NOT Redis.** The only objection to `getSession` was the per-call Postgres read; the cache removes it with zero infra and zero frontend change. Verified that `cookieCache` can't help the bearer SPA; `secondaryStorage`/Redis was the no-frontend-change alternative but adds infra; JWT was rejected for the frontend token-exchange complexity. Trade-off: ≤TTL revocation/`status` lag, per instance (risk 6). The genuinely open ones:

2. **Sign-in methods (§8.2).** Mirror Firebase exactly (email/password + Google) or add/drop any (magic link, GitHub)? Note the frontend already maps a `githubProvider` with no server provider configured — a harmless dead path to either wire or remove.

3. **Org model (§8.3).** Keep the simple `users.organisationId` (one org per user, current) or adopt BA's `organization` plugin (multi-org membership, per-org roles, invitations)? The latter is a larger change and changes how RBAC scopes — recommended only if Phase-4 needs multi-org. Affects the `/users` design's RBAC shape, so decide before that lands.

4. **When to flip `requireEmailVerification`.** At enable (preserve Firebase parity) or after a soft-launch window? Must be set consistently on server + SPA (item J).

5. **Cutover timing / dual-run window.** How long do Firebase and BA run in parallel before Phase-3? This gates the `email_verified` backfill urgency (risk 4) and when item M (drop Firebase branch, databaseHooks sole writer) begins. The plan assumes "1-2 release cycles" (§2.2) — confirm.

Key live refs: `lib/auth/index.js:52-54,78-82,98,118-125,130-138,180`; `middleware/auth.js:96-118,120-132`; `index.mjs:47-66`; `lib/database.js:1264-1279,1332-1335,1721-1722`; `Dockerfile` + `deploy/gcp/cloudrun/cloudbuild.yaml` (no migrate step); `package.json` (no `jose`/`@better-auth/cli`, caret `better-auth`); plan §2.2/§2.3/§2.4, §5, §6, §7, §8.
