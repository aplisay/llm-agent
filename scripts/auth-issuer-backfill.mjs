/**
 * One-shot better-auth 1.7 upgrade step: `account.issuer`.
 *
 * better-auth 1.7.0 scoped account identity by issuer — a new REQUIRED
 * `account.issuer` column plus a unique index on (issuer, accountId). Its own
 * `getMigrations()` REFUSES to apply that to a populated table
 * (UnsafeMigrationError: a required column with no default has nothing to
 * backfill), so `runAuthMigrate` / `agent-admin --command upgrade-db` cannot
 * carry this one. This script performs the exact sequence better-auth's refusal
 * message prescribes: add nullable -> backfill every row -> enforce NOT NULL ->
 * create the unique index.
 *
 * Issuer values mirror @better-auth/core/db exactly (sign-in matches on them,
 * so a wrong value silently breaks password login):
 *   createLocalAccountIssuer(id) -> `local:${id}`        -- providerId 'credential'
 *   createOAuthAccountIssuer(id) -> `local:oauth:${id}`  -- OAuth providers with
 *                                                          no accountIssuer override
 *
 * Idempotent: re-running after success reports nothing to do.
 *
 * Usage:
 *   node scripts/auth-issuer-backfill.mjs --path .env.beta            # dry run
 *   node scripts/auth-issuer-backfill.mjs --path .env.beta --apply    # apply
 */
import dotenv from 'dotenv';
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

// The backfill expression, shared by the preflight and the UPDATE so the
// collision check can never disagree with what actually gets written.
const ISSUER_EXPR = `case when "providerId" = 'credential'
                          then 'local:credential'
                          else 'local:oauth:' || "providerId"
                     end`;

await client.connect();
console.log(`db = ${process.env.POSTGRES_DB} @ ${process.env.POSTGRES_HOST}`);
console.log(`mode = ${apply ? 'APPLY' : 'dry run'}\n`);

const present = await client.query(
  `select is_nullable from information_schema.columns
    where table_name = 'account' and column_name = 'issuer'`
);
const hasIssuer = present.rowCount > 0;

// Preflight: the new index is UNIQUE, so a duplicate (issuer, accountId) after
// backfill would abort the transaction. Surface it before touching anything.
const collisions = await client.query(
  `select issuer, "accountId", count(*)::int as n
     from (select ${ISSUER_EXPR} as issuer, "accountId" from account) t
    group by 1, 2 having count(*) > 1`
);

// sign-in.mjs requires a credential account's accountId to equal the user id;
// rows that violate it are already broken, and worth knowing about now.
const badAccountId = await client.query(
  `select count(*)::int as n from account
    where "providerId" = 'credential' and "accountId" <> "userId"`
);

const plan = await client.query(
  `select ${ISSUER_EXPR} as issuer, "providerId", count(*)::int as n
     from account group by 1, 2 order by 1, 2`
);
console.log('planned issuer values:');
console.table(plan.rows);
console.log(`account.issuer column present: ${hasIssuer}${hasIssuer ? ` (nullable=${present.rows[0].is_nullable})` : ''}`);
console.log(`unique-index collisions: ${collisions.rowCount}`);
console.log(`credential rows with accountId <> userId: ${badAccountId.rows[0].n}\n`);

if (collisions.rowCount > 0) {
  console.table(collisions.rows);
  console.error('REFUSING: backfill would violate the unique (issuer, accountId) index.');
  await client.end();
  process.exit(1);
}

if (!apply) {
  console.log('Dry run only — re-run with --apply to execute.');
  await client.end();
  process.exit(0);
}

try {
  await client.query('begin');
  await client.query(`alter table account add column if not exists issuer text`);
  const filled = await client.query(
    `update account set issuer = ${ISSUER_EXPR} where issuer is null`
  );
  await client.query(`alter table account alter column issuer set not null`);
  await client.query(
    `create unique index if not exists "account_issuer_accountId_uidx"
       on account (issuer, "accountId")`
  );
  await client.query('commit');
  console.log(`backfilled ${filled.rowCount} row(s) — committed`);
} catch (e) {
  await client.query('rollback').catch(() => {});
  console.error('ROLLED BACK:', e.message);
  await client.end();
  process.exit(1);
}

const after = await client.query(
  `select a."providerId", a.issuer, count(*)::int as n
     from account a group by 1, 2 order by 1, 2`
);
console.log('\n=== issuer after migration ===');
console.table(after.rows);
const idx = await client.query(
  `select indexname from pg_indexes where tablename = 'account' order by 1`
);
console.log('account indexes:', idx.rows.map((r) => r.indexname).join(', '));

await client.end();
