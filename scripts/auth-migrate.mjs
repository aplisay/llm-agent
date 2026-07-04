/**
 * Runtime better-auth satellite-table migrator (deploy step).
 *
 * Creates/upgrades better-auth's OWN tables (`account`, `session`,
 * `verification`) at container startup, so a fresh staging/prod DB is never left
 * without them. The failure mode this prevents: sign-up returns HTTP 500
 * `relation "account" does not exist` BEFORE the verification-email hook ever
 * runs — i.e. "sign-up appears to work but no confirmation email arrives", and an
 * orphan credential-less `users` row is left behind. See
 * docs/implementation/better-auth-hardening-plan.md §G / Risk #1.
 *
 * FENCED off the shared `users` table: Sequelize is its DDL owner (better-auth's
 * `user.modelName='users'`). If the computed migration would create OR alter
 * `users`/`user`, this REFUSES and exits non-zero rather than auto-applying —
 * reconcile by hand (`yarn auth:generate`). Uses better-auth's own
 * `getMigrations` (version-locked to the installed better-auth), not the
 * separately-versioned `@better-auth/cli`.
 *
 * Idempotent. Exits 0 (no-op) when BETTER_AUTH_ENABLED != true or the schema is
 * already current. Exits 1 on any migration error or the users-table fence —
 * fail-closed, so a bad deploy aborts boot and Cloud Run keeps the previous
 * healthy revision serving.
 */

// Mirror index.mjs: secretenv's PROGRAMMATIC config() is synchronous — it decrypts
// SECRETENV_BUNDLE (container) or loads a .env file (local; honours
// DOTENV_CONFIG_PATH) into process.env BEFORE we import lib/auth, which reads env
// at module-eval time. NB: the `dotenv/config` side-effect import is async here
// (fire-and-forget) and must NOT be used — it would race the auth import.
import dotenv from 'dotenv';
{
  const path = process.env.DOTENV_CONFIG_PATH;
  dotenv.config(path ? { path } : undefined);
}

const { default: logger } = await import('../lib/logger.js');
const { auth } = await import('../lib/auth/index.js');

if (!auth) {
  logger.info('better-auth disabled (BETTER_AUTH_ENABLED != true) — skipping auth migrate');
  process.exit(0);
}

try {
  const { getMigrations } = await import('better-auth/db/migration');
  const { toBeCreated, toBeAdded, runMigrations, compileMigrations } = await getMigrations(auth.options);

  const targets = [...toBeCreated, ...toBeAdded].map((t) => t.table);
  if (targets.length === 0) {
    logger.info('better-auth: satellite schema already up to date');
    process.exit(0);
  }

  // Fence: never let better-auth create or alter the Sequelize-owned users table.
  const forbidden = [...new Set(targets.filter((t) => t === 'users' || t === 'user'))];
  if (forbidden.length > 0) {
    const sql = await compileMigrations().catch(() => '(could not compile)');
    logger.error(
      { targets, forbidden, sql },
      'better-auth migrate would modify the Sequelize-owned users table — REFUSING. '
      + 'Reconcile by hand (yarn auth:generate) before deploying.',
    );
    process.exit(1);
  }

  await runMigrations();
  logger.info(
    { created: toBeCreated.map((t) => t.table), added: toBeAdded.map((t) => t.table) },
    'better-auth migrate applied (satellite tables)',
  );
  process.exit(0);
} catch (err) {
  logger.error({ err: err?.message, stack: err?.stack }, 'better-auth migrate FAILED');
  process.exit(1);
}
