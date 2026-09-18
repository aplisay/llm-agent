/**
 * One-shot better-auth 1.7 upgrade step: `account.issuer`.
 *
 * better-auth 1.7.0 scoped account identity by issuer — a new REQUIRED
 * `account.issuer` column plus a unique index on (issuer, accountId). Its own
 * `getMigrations()` REFUSES to apply that to a populated table
 * (UnsafeMigrationError: a required column with no default has nothing to
 * backfill), so `runAuthMigrate` / `agent-admin --command upgrade-db` cannot
 * carry this one. This script performs the sequence better-auth's refusal
 * message prescribes: add nullable -> backfill every row -> enforce NOT NULL ->
 * create the unique index.
 *
 * ISSUER VALUES ARE RESOLVED FROM THE LIVE AUTH CONFIG, NEVER GUESSED. Getting
 * one wrong does not fail loudly — it silently detaches an identity, because
 * sign-in and account linking match on the issuer string. In particular
 * `local:oauth:<providerId>` is only the fallback for a provider that declares
 * no issuer of its own; Google declares `https://accounts.google.com`, so
 * assuming the fallback would strand every Google account. The mapping comes
 * from `auth.$context.socialProviders[].accountIssuer` with
 * `createOAuthAccountIssuer` used only where the provider genuinely declares
 * nothing, and any provider this script cannot resolve statically aborts the
 * run rather than being guessed at.
 *
 * Self-correcting and idempotent: it rewrites any row whose issuer differs from
 * the resolved value (not just NULLs), so a previous bad backfill is repaired
 * rather than baked in, and a clean database is a no-op.
 *
 * Usage:
 *   node scripts/auth-issuer-backfill.mjs --path .env.beta            # dry run
 *   node scripts/auth-issuer-backfill.mjs --path .env.beta --apply    # apply
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

const argv = process.argv.slice(2);
const pathIdx = argv.findIndex((a) => a === '--path' || a === '-p');
const envPath = pathIdx > -1 ? argv[pathIdx + 1] : process.env.DOTENV_CONFIG_PATH;
const apply = argv.includes('--apply');
if (pathIdx > -1 && !envPath) {
  console.error('Missing value for -p/--path');
  process.exit(1);
}
dotenv.config(envPath ? { path: path.resolve(process.cwd(), envPath) } : undefined);

const die = (msg) => {
  console.error(`REFUSING: ${msg}`);
  process.exit(1);
};

// The `issuer` field and every provider's `accountIssuer` only exist from 1.7.
// Running this under 1.6.x would silently resolve Google to the generic
// fallback and strand the accounts it is supposed to be repairing.
const baVersion = JSON.parse(
  fs.readFileSync(new URL('../node_modules/better-auth/package.json', import.meta.url))
).version;
if (Number(baVersion.split('.')[0]) < 2 && Number(baVersion.split('.')[1]) < 7) {
  die(`better-auth ${baVersion} predates 1.7 — it cannot resolve provider issuers. Install >= 1.7 and re-run.`);
}

const { auth } = await import('../lib/auth/index.js');
if (!auth) die('better-auth is disabled for this env (BETTER_AUTH_ENABLED != true).');
const ctx = await auth.$context;
const { createLocalAccountIssuer, createOAuthAccountIssuer } = await import('@better-auth/core/db');

// providerId -> issuer, resolved from config. A provider whose accountIssuer is
// a function derives the issuer per-token (from the ID token / profile), so it
// cannot be resolved statically here: abort rather than write a wrong value.
const issuerFor = new Map([['credential', createLocalAccountIssuer('credential')]]);
for (const p of ctx.socialProviders ?? []) {
  const declared = p.accountIssuer;
  if (typeof declared === 'string') issuerFor.set(p.id, declared);
  else if (declared === undefined) issuerFor.set(p.id, createOAuthAccountIssuer(p.id));
  else die(`provider "${p.id}" derives its issuer dynamically — resolve it by hand, do not guess.`);
}

const { default: pg } = await import('pg');
const client = new pg.Client({
  host: process.env.POSTGRES_HOST,
  port: +(process.env.POSTGRES_PORT || 5432),
  database: process.env.POSTGRES_DB,
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  ssl: {
    rejectUnauthorized: false,
    ca: process.env.POSTGRES_CA,
    key: process.env.POSTGRES_KEY,
    cert: process.env.POSTGRES_CERT,
  },
});
await client.connect();
console.log(`db      = ${process.env.POSTGRES_DB} @ ${process.env.POSTGRES_HOST}`);
console.log(`version = better-auth ${baVersion}`);
console.log(`mode    = ${apply ? 'APPLY' : 'dry run'}`);
console.log('resolved issuers:');
for (const [pid, iss] of issuerFor) console.log(`  ${pid} -> ${iss}`);
console.log();

// Every providerId actually present must be resolvable, or rows would be left
// behind (and NOT NULL would then fail anyway).
const present = await client.query(`select distinct "providerId" from account`);
const unknown = present.rows.map((r) => r.providerId).filter((p) => !issuerFor.has(p));
if (unknown.length) die(`account rows use provider(s) not in the auth config: ${unknown.join(', ')}`);

const hasIssuer = await client.query(
  `select is_nullable from information_schema.columns
    where table_name = 'account' and column_name = 'issuer'`
);

// Build the mapping as SQL so the preflight and the UPDATE cannot disagree.
const entries = [...issuerFor];
const params = entries.flat();
const caseSql = entries
  .map((_, i) => `when $${i * 2 + 1} then $${i * 2 + 2}`)
  .join('\n                              ');
const EXPECTED = `(case "providerId" ${caseSql} end)`;

const collisions = await client.query(
  `select issuer, "accountId", count(*)::int as n
     from (select ${EXPECTED} as issuer, "accountId" from account) t
    group by 1, 2 having count(*) > 1`,
  params
);
if (collisions.rowCount > 0) {
  console.table(collisions.rows);
  await client.end();
  die('backfill would violate the unique (issuer, accountId) index.');
}

const drift = hasIssuer.rowCount
  ? await client.query(
      `select "providerId", issuer as current, ${EXPECTED} as expected, count(*)::int as n
         from account
        where issuer is null or issuer is distinct from ${EXPECTED}
        group by 1, 2, 3 order by 1`,
      params
    )
  : { rowCount: 0, rows: [] };

console.log(`account.issuer column: ${hasIssuer.rowCount ? `present (nullable=${hasIssuer.rows[0].is_nullable})` : 'MISSING'}`);
console.log(`rows needing write: ${hasIssuer.rowCount ? drift.rows.reduce((a, r) => a + r.n, 0) : 'all (column missing)'}`);
if (drift.rowCount) console.table(drift.rows);

if (!apply) {
  console.log('\nDry run only — re-run with --apply to execute.');
  await client.end();
  process.exit(0);
}

try {
  await client.query('begin');
  await client.query(`alter table account add column if not exists issuer text`);
  const w = await client.query(
    `update account set issuer = ${EXPECTED} where issuer is distinct from ${EXPECTED}`,
    params
  );
  await client.query(`alter table account alter column issuer set not null`);
  await client.query(
    `create unique index if not exists "account_issuer_accountId_uidx"
       on account (issuer, "accountId")`
  );
  await client.query('commit');
  console.log(`\nwrote ${w.rowCount} row(s) — committed`);
} catch (e) {
  await client.query('rollback').catch(() => {});
  console.error('ROLLED BACK:', e.message);
  await client.end();
  process.exit(1);
}

const after = await client.query(
  `select "providerId", issuer, count(*)::int as n from account group by 1, 2 order by 1, 2`
);
console.log('\n=== issuer after ===');
console.table(after.rows);
await client.end();
process.exit(0);
