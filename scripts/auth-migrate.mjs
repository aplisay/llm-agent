/**
 * Better-auth satellite-table migrator — a reusable maintenance step.
 *
 * Creates/upgrades better-auth's OWN tables (`account`, `session`,
 * `verification`) — the ones Sequelize does NOT manage. Without them a fresh
 * staging/prod DB makes every credential sign-up 500 with
 * `relation "account" does not exist` BEFORE the verification-email hook runs
 * ("sign-up works but no confirmation email"), leaving an orphan credential-less
 * `users` row. See docs/implementation/better-auth-hardening-plan.md §G / Risk #1.
 *
 * Run as a step of `agent-admin --command upgrade-db` (alongside the Sequelize
 * DB_FORCE_SYNC schema sync), so it happens as part of the deliberate manual DB
 * upgrade — NOT on every container boot.
 *
 * `runAuthMigrate(logger)` assumes env is ALREADY loaded (the caller ran
 * dotenv.config); it dynamically imports lib/auth so it works only after env
 * decryption. FENCED off the Sequelize-owned `users` table: if the computed
 * migration would create/alter `users`/`user` it THROWS rather than applying
 * (Sequelize is that table's DDL owner; better-auth's `user.modelName='users'`).
 * Idempotent — a no-op when better-auth is disabled or the schema is current.
 * Uses better-auth's own `getMigrations` (version-locked to the installed
 * better-auth), not the separately-versioned `@better-auth/cli`.
 */

export async function runAuthMigrate(logger) {
  const { auth } = await import('../lib/auth/index.js');
  if (!auth) {
    logger.info('better-auth disabled (BETTER_AUTH_ENABLED != true) — skipping auth migrate');
    return { skipped: true };
  }

  const { getMigrations } = await import('better-auth/db/migration');
  const { toBeCreated, toBeAdded, runMigrations, compileMigrations } = await getMigrations(auth.options);

  const targets = [...toBeCreated, ...toBeAdded].map((t) => t.table);
  if (targets.length === 0) {
    logger.info('better-auth: satellite schema already up to date');
    return { applied: false, created: [], added: [] };
  }

  // Fence: never let better-auth create or alter the Sequelize-owned users table.
  const forbidden = [...new Set(targets.filter((t) => t === 'users' || t === 'user'))];
  if (forbidden.length > 0) {
    const sql = await compileMigrations().catch(() => '(could not compile)');
    logger.error(
      { targets, forbidden, sql },
      'better-auth migrate would modify the Sequelize-owned users table — REFUSING. '
      + 'Reconcile by hand (yarn auth:generate) before proceeding.',
    );
    throw new Error(`better-auth migrate refused: would modify the users table (${forbidden.join(', ')})`);
  }

  await runMigrations();
  const created = toBeCreated.map((t) => t.table);
  const added = toBeAdded.map((t) => t.table);
  logger.info({ created, added }, 'better-auth migrate applied (satellite tables)');
  return { applied: true, created, added };
}

// Standalone CLI for ad-hoc/local use: `node scripts/auth-migrate.mjs [-p <.env>]`
// (also --path <.env> or DOTENV_CONFIG_PATH=<.env>). Env-load mirrors index.mjs:
// secretenv's sync dotenv.config() runs BEFORE runAuthMigrate dynamic-imports
// lib/auth. Not wired into container boot — the deploy path is
// `agent-admin --command upgrade-db`.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { default: dotenv } = await import('dotenv');
  const dir = await import('path');
  const pathIdx = process.argv.findIndex((a) => a === '--path' || a === '-p');
  const envPath = pathIdx > -1 ? process.argv[pathIdx + 1] : process.env.DOTENV_CONFIG_PATH;
  if (pathIdx > -1 && !envPath) {
    console.error('Missing value for -p/--path');
    process.exit(1);
  }
  dotenv.config(envPath ? { path: dir.resolve(process.cwd(), envPath) } : undefined);
  const { default: logger } = await import('../lib/logger.js');
  try {
    await runAuthMigrate(logger);
    process.exit(0);
  } catch (err) {
    logger.error({ err: err?.message, stack: err?.stack }, 'better-auth migrate FAILED');
    process.exit(1);
  }
}
