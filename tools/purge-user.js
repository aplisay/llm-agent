#!/usr/bin/env node
/**
 * purge-user — HARD-DELETE a user (and, by default, their organisation) so the
 * same email can run the signup flow again from scratch. TEST/STAGING tooling.
 *
 * Unlike DELETE /api/users/{id} and DELETE /api/organisations/{id} — which are
 * SOFT deletes (status='deactivated') — this actually destroys rows. It is the
 * only hard-delete path for a user in the codebase, so it is deliberately a CLI
 * (no HTTP surface, no accidental clicks) that runs everything in ONE Sequelize
 * transaction and DRY-RUNS unless you explicitly confirm.
 *
 * WHY IT'S NOT A SIMPLE `User.destroy()`:
 *  - The `users` table is Sequelize-owned but is ALSO better-auth's `user` model
 *    (lib/auth/index.js); better-auth owns the satellite tables session/account/
 *    verification in the SAME Postgres DB but Sequelize can't see them, so we
 *    clear them with raw SQL on the same connection/transaction.
 *  - A user-only delete leaves the PROVISIONAL organisation behind (the cascade
 *    is org->user, not user->org), and a re-signup needs the org gone — so the
 *    default is to drop the whole org (use --keep-org for the narrow case).
 *  - Two child tables FK users/organisations with NO onDelete (=> RESTRICT) and
 *    would BLOCK the delete: CallRecordingDownload and BalanceCredit. We clear
 *    them first.
 *  - ChatSession stores userId/organisationId as un-FK'd columns and would
 *    orphan (transcripts left behind); we clear it explicitly.
 *  - UsageRecord/InvocationLog associations say SET NULL, but the model files
 *    ALSO declare column-level references with no onDelete — the live constraint
 *    is ambiguous (sync({alter}) doesn't reconcile onDelete on existing FKs), so
 *    we delete them explicitly rather than gamble on the cascade.
 *  - polite-ai's `waitlist_signups` invite table is cleared by email too — a
 *    stale COMPLETED row blocks re-signup and keeps the emailed invite page
 *    claiming the account exists. NOTE: in deployed environments that table
 *    lives in polite-ai's OWN database, not this one, reached with client-cert
 *    mTLS: point --polite-env (or POLITE_ENV_FILE) at polite-ai's env file and
 *    the tool connects exactly as the app does (POLITE_DATABASE_URL stays as a
 *    plain-URL fallback). Otherwise it tells you the step was skipped — it
 *    never silently omits it any more.
 *
 * WHAT WE INTENTIONALLY DO NOT DELETE:
 *  - RateCard: a SHARED pricing table keyed by rateName (orgs point at it via
 *    Organisation.rateHistory). It has no org column — never touch it.
 *  - PhoneNumber / PhoneRegistration: SET NULL on org delete, but the CARRIER
 *    (Magrathea) allocation is released by polite-ai, not here. We REFUSE to
 *    purge an org that still owns numbers (use --force to override and strand
 *    them). A clean signup-test user owns none.
 *  - External services: Stripe customer, integration OAuth grants, and the
 *    website-crawler's knowledge base (separate DB/Spaces) are NOT cleaned up.
 *    Acceptable orphans for a signup-flow test; noted at the end.
 *
 * SAFETY:
 *  - DRY RUN by default. Nothing is deleted unless you pass --confirm <email>
 *    and it matches the resolved target's email (case-insensitive).
 *  - Refuses when NODE_ENV=production (override: --allow-production).
 *  - Refuses to purge a superAdmin, an org with OTHER members, or an org that
 *    owns phone numbers (override: --force).
 *  - Runs in a single transaction: any FK error rolls the whole thing back with
 *    the offending constraint named — nothing is left half-deleted.
 *
 * USAGE:
 *   node tools/purge-user.js --email a@b.com [-p .env]        # dry run (plan only)
 *   node tools/purge-user.js --email a@b.com --confirm a@b.com   # execute
 *   node tools/purge-user.js --email a@b.com --confirm a@b.com --keep-org
 *   node tools/purge-user.js --userId <id> --confirm a@b.com --force
 */
import dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import dir from 'path';
import commandLineArgs from 'command-line-args';
import logger from '../lib/logger.js';

const optionDefinitions = [
  { name: 'email', alias: 'e', type: String },
  { name: 'userId', alias: 'u', type: String },
  { name: 'confirm', type: String },
  { name: 'keep-org', type: Boolean },
  { name: 'force', type: Boolean },
  { name: 'allow-production', type: Boolean },
  { name: 'path', alias: 'p', type: String },
  { name: 'polite-env', type: String },
  { name: 'help', alias: 'h', type: Boolean },
];

const options = commandLineArgs(optionDefinitions);
const configArgs = options.path && { path: dir.resolve(process.cwd(), options.path) };
dotenv.config(configArgs);

const norm = (s) => String(s ?? '').trim().toLowerCase();

/**
 * Build a Sequelize config for polite-ai's own database FROM ITS OWN env file,
 * mirroring the app's lib/db-ssl.mjs semantics exactly (the connection is mTLS
 * with inline client-certificate PEMs, which a postgres:// URL cannot carry):
 *   - DATABASE_URL wins when set; else POSTGRES_HOST/PORT/USER/PASSWORD/DB.
 *   - POSTGRES_CA / POSTGRES_CERT / POSTGRES_KEY as inline PEMs ("\n" escapes
 *     unfolded) or their *_FILE path variants; POSTGRES_KEY_PASSWORD as the key
 *     passphrase; POSTGRES_RO_SERVER_NAME as the TLS servername (SNI + the name
 *     the server certificate is checked against, e.g. Cloud SQL).
 *   - POSTGRES_SSLMODE: default verify-full when a CA is given, else require
 *     (encrypt, don't verify); verify-ca validates the chain but skips hostname
 *     matching; disable turns TLS off.
 * The file is parsed standalone — never merged into process.env, so it cannot
 * collide with THIS repo's own POSTGRES_* configuration.
 */
function politeSequelizeOptions(envPath) {
  const vars = dotenv.parse(readFileSync(envPath, 'utf8'));
  const read = (name) => {
    const file = vars[`${name}_FILE`];
    if (file && file.trim()) return readFileSync(file.trim(), 'utf8');
    const inline = vars[name];
    return inline && inline.trim() ? inline.replace(/\\n/g, '\n') : null;
  };
  const ca = read('POSTGRES_CA');
  const cert = read('POSTGRES_CERT');
  const key = read('POSTGRES_KEY');
  const servername = vars.POSTGRES_RO_SERVER_NAME?.trim() || undefined;
  const mode = (vars.POSTGRES_SSLMODE || (ca ? 'verify-full' : '')).toLowerCase();
  let ssl;
  if ((ca || cert || key || servername || mode) && mode !== 'disable') {
    ssl = {};
    if (ca) ssl.ca = ca;
    if (cert) ssl.cert = cert;
    if (key) ssl.key = key;
    if (vars.POSTGRES_KEY_PASSWORD) ssl.passphrase = vars.POSTGRES_KEY_PASSWORD;
    if (servername) ssl.servername = servername;
    if (mode === 'require' || (!ca && mode !== 'verify-ca' && mode !== 'verify-full')) {
      ssl.rejectUnauthorized = false;
    } else {
      ssl.rejectUnauthorized = true;
      if (mode === 'verify-ca') ssl.checkServerIdentity = () => undefined;
    }
  }
  const dialectOptions = {};
  if (ssl) dialectOptions.ssl = ssl;
  const schema = vars.POSTGRES_SCHEMA;
  if (schema && schema !== 'public') dialectOptions.options = `-c search_path=${schema}`;
  if (vars.DATABASE_URL && vars.DATABASE_URL.trim()) {
    return { url: vars.DATABASE_URL.trim(), options: { logging: false, dialectOptions } };
  }
  if (!vars.POSTGRES_HOST || !vars.POSTGRES_DB || !vars.POSTGRES_USER) {
    throw new Error(
      `${envPath} has no DATABASE_URL and no complete POSTGRES_HOST/POSTGRES_DB/POSTGRES_USER set`,
    );
  }
  return {
    options: {
      database: vars.POSTGRES_DB,
      username: vars.POSTGRES_USER,
      password: vars.POSTGRES_PASSWORD || undefined,
      host: vars.POSTGRES_HOST,
      port: Number(vars.POSTGRES_PORT || '5432'),
      dialect: 'postgres',
      logging: false,
      dialectOptions,
    },
  };
}

function usage(code = 0) {
  console.log(`purge-user — hard-delete a user (+ their org) for signup re-testing.

Usage:
  node tools/purge-user.js --email <email> [options]     DRY RUN (shows the plan)
  node tools/purge-user.js --email <email> --confirm <email>   EXECUTE

Target (one required):
  --email, -e <email>     the user to purge
  --userId, -u <id>       the user id to purge

Options:
  --confirm <email>       execute; must exactly match the target's email
  --keep-org              delete only the user, keep the organisation
  --force                 override the superAdmin / co-member / owns-numbers refusals
  --allow-production      override the NODE_ENV=production refusal
  --path, -p <file>       path to the .env to load (which DB to act on)
  --polite-env <file>     path to polite-ai's env file (e.g. ../polite-ai/.env.staging),
                          used to reach its SEPARATE database for the waitlist_signups
                          step — the app's POSTGRES_* vars there carry the client-cert
                          mTLS material a plain URL cannot. Also accepted as the
                          POLITE_ENV_FILE env var for the invocation; treat it as a
                          per-run argument rather than persisting it in an env file —
                          .env files here may be bundled into server environments,
                          where a workstation path is meaningless. POLITE_DATABASE_URL
                          remains a last-resort plain-URL fallback.
  --help, -h              this help

Without --confirm nothing is deleted; you get a per-table plan of what WOULD go.`);
  process.exitCode = code;
}

if (options.help || (!options.email && !options.userId)) {
  usage(options.help ? 0 : 1);
  process.exit(process.exitCode || 0);
}

let stop; // stopDatabase, set once the DB is up
let closeAppDb; // set when a separate polite-ai app DB connection was opened

function done(code) {
  process.exitCode = code;
  if (closeAppDb) closeAppDb().catch(() => {});
  if (stop) stop().then(() => logger.debug('database stopped')).catch(() => {});
}

async function main() {
  // Positive prod refusal — an unset flag is the kind of thing that leaks into
  // prod env templates, so we refuse by presence of NODE_ENV=production, not by
  // absence of an "allow" flag.
  if (process.env.NODE_ENV === 'production' && !options['allow-production']) {
    console.error('REFUSING: NODE_ENV=production. This is destructive test tooling. '
      + 'Re-run with --allow-production only if you are certain.');
    process.exit(2);
  }

  const {
    User, Organisation, PhoneNumber, PhoneRegistration,
    CallRecordingDownload, BalanceCredit, UsageRecord, InvocationLog, ChatSession,
    Op, Sequelize, databaseStarted, stopDatabase,
  } = await import('../lib/database.js');
  await databaseStarted;
  stop = stopDatabase;

  const sequelize = User.sequelize;
  const execute = options.confirm != null;

  // ---- Helpers -------------------------------------------------------------
  const tableExists = async (name) => {
    const [row] = await sequelize.query('SELECT to_regclass($1) AS t', {
      bind: [`public.${name}`], type: Sequelize.QueryTypes.SELECT,
    });
    return !!row?.t;
  };
  const rawCount = async (sql, binds) => {
    const [row] = await sequelize.query(sql, { bind: binds, type: Sequelize.QueryTypes.SELECT });
    return Number(row?.n ?? 0);
  };
  const rawDelete = async (sql, binds, t) => {
    const res = await sequelize.query(sql, { bind: binds, transaction: t });
    // pg dialect returns [rows, Result]; Result.rowCount is the affected count.
    const meta = Array.isArray(res) ? res[1] : res;
    return meta?.rowCount ?? null;
  };

  const haveSession = await tableExists('session');
  const haveAccount = await tableExists('account');
  const haveVerification = await tableExists('verification');
  const haveWaitlist = await tableExists('waitlist_signups');

  // waitlist_signups usually is NOT in this database: each polite-ai
  // deployment keeps it in its own Postgres, reached with client-certificate
  // mTLS. When the table is absent here, connect using polite-ai's OWN env
  // file — --polite-env <path>, or the POLITE_ENV_FILE env var for the
  // invocation (a per-run argument by design: this repo's .env files may be
  // bundled into server environments, where a workstation path is
  // meaningless) — parsed standalone and mirrored through
  // politeSequelizeOptions, never merged into process.env. POLITE_DATABASE_URL remains a last-resort plain-URL fallback
  // for setups without client certs. Cross-database, so the step runs OUTSIDE
  // the main transaction, after everything else committed.
  let appDb = null;
  let haveAppWaitlist = false;
  let appDbLabel = null;
  if (!haveWaitlist) {
    const politeEnvPath = options['polite-env'] || process.env.POLITE_ENV_FILE;
    try {
      if (politeEnvPath) {
        const resolved = dir.resolve(process.cwd(), politeEnvPath);
        appDbLabel = resolved;
        const built = politeSequelizeOptions(resolved);
        appDb = built.url ? new Sequelize(built.url, built.options) : new Sequelize(built.options);
      } else if (process.env.POLITE_DATABASE_URL) {
        const url = process.env.POLITE_DATABASE_URL;
        appDbLabel = 'POLITE_DATABASE_URL';
        appDb = new Sequelize(url, {
          logging: false,
          dialectOptions: /sslmode=require/.test(url)
            ? { ssl: { require: true, rejectUnauthorized: false } }
            : {},
        });
      }
    } catch (e) {
      console.error(`polite-ai app DB config unusable (${appDbLabel}): ${e.message}`);
      appDb = null;
    }
    if (appDb) {
      try {
        const [row] = await appDb.query('SELECT to_regclass($1) AS t', {
          bind: ['public.waitlist_signups'], type: Sequelize.QueryTypes.SELECT,
        });
        haveAppWaitlist = !!row?.t;
        closeAppDb = () => appDb.close();
        if (!haveAppWaitlist) {
          console.error(`NOTICE: connected to the polite-ai DB via ${appDbLabel}, but it has no waitlist_signups table.`);
        }
      } catch (e) {
        console.error(`polite-ai app DB unreachable (${appDbLabel}): ${e.message}`);
        await appDb.close().catch(() => {});
        appDb = null;
      }
    }
  }

  // ---- Resolve the target -------------------------------------------------
  // A COMPLETED signup has an llm-agent `users` row (+ org, satellite, waitlist).
  // A PROVISIONAL / invited-but-not-completed signup exists ONLY as a polite-ai
  // `waitlist_signups` row — the llm-agent user is created at setup completion
  // (app/lib/onboarding.server.ts) — so we must handle a user-less target too.
  const where = options.userId ? { id: options.userId } : { email: { [Op.iLike]: options.email } };
  const target = await User.findOne({ where });

  let targetEmail;
  let orgId = null;
  let dropOrg = false;
  let scopeUsers = [];
  let userIds = [];
  let emails = [];

  if (target) {
    targetEmail = norm(target.email);
    orgId = target.organisationId || null;
    dropOrg = !options['keep-org'] && !!orgId;
    if (!orgId && !options['keep-org']) {
      console.warn('Target has no organisationId — nothing to drop; proceeding in user-only mode.');
    }
    // Users/emails in scope: the whole org (drop-org) or just the target.
    scopeUsers = dropOrg ? await User.findAll({ where: { organisationId: orgId } }) : [target];
    userIds = scopeUsers.map((u) => u.id);
    emails = [...new Set(scopeUsers.map((u) => norm(u.email)).filter(Boolean))];
  } else {
    // No llm-agent user — fall back to a waitlist-only (provisional) target,
    // keyed purely by email. (Can't fall back when targeting by --userId.)
    if (!options.email) {
      console.error(`No user found for id ${options.userId}.`);
      return done(1);
    }
    targetEmail = norm(options.email);
    emails = [targetEmail];
    const waitlistN = haveWaitlist
      ? await rawCount('SELECT count(*)::int AS n FROM waitlist_signups WHERE lower(email) = ANY($1)', [emails]) : 0;
    const verifyN = haveVerification
      ? await rawCount('SELECT count(*)::int AS n FROM verification WHERE lower(identifier) = ANY($1)', [emails]) : 0;
    if (waitlistN + verifyN === 0) {
      console.error(`No llm-agent user, and no waitlist_signups / verification row, for ${targetEmail}. Nothing to purge.`);
      return done(1);
    }
    console.log(`No llm-agent user for ${targetEmail} — provisional / waitlist-only target `
      + `(${waitlistN} waitlist row(s), ${verifyN} verification row(s)).`);
  }

  // Fail fast on a typo'd confirmation, before printing an EXECUTE plan that
  // never ran (avoids reading as though it did).
  if (execute && norm(options.confirm) !== targetEmail) {
    console.error(`--confirm "${options.confirm}" does not match the target email "${targetEmail}". Aborting.`);
    return done(2);
  }

  const orgUserOr = () => {
    const or = [{ userId: { [Op.in]: userIds } }];
    if (dropOrg && orgId) or.push({ organisationId: orgId });
    return { [Op.or]: or };
  };

  // ---- Safety pre-checks (override with --force) — only when a user exists --
  if (target) {
    const refusals = [];
    if (norm(target.role) === 'superadmin') refusals.push('target is a superAdmin');
    if (dropOrg && scopeUsers.length > 1) {
      refusals.push(`organisation has ${scopeUsers.length} members — dropping it deletes them ALL `
        + `(${emails.join(', ')})`);
    }
    if (orgId) {
      const numbers = await PhoneNumber.count({ where: { organisationId: orgId } });
      const regs = await PhoneRegistration.count({ where: { organisationId: orgId } });
      if (numbers + regs > 0) {
        refusals.push(`organisation owns ${numbers} number(s) + ${regs} registration(s) — the carrier `
          + `allocation is released by polite-ai, not here; purging strands them`);
      }
    }
    if (refusals.length && !options.force) {
      console.error('REFUSING to purge:');
      refusals.forEach((r) => console.error(`  - ${r}`));
      console.error('Re-run with --force if you understand and accept this.');
      return done(2);
    }
    if (refusals.length) {
      console.warn('Proceeding despite (overridden with --force):');
      refusals.forEach((r) => console.warn(`  - ${r}`));
    }
  }

  // ---- Build the plan (Sequelize models + raw satellite/BFF tables) --------
  // Ordered so RESTRICT-blocking children are gone before the org/user destroy.
  const steps = [];
  if (target) {
    // User/org-scoped deletions — only relevant when an llm-agent user exists.
    steps.push({
      label: 'call_recording_downloads (RESTRICT blocker)',
      count: () => CallRecordingDownload.count({ where: orgUserOr() }),
      run: (t) => CallRecordingDownload.destroy({ where: orgUserOr(), transaction: t }),
    });
    if (dropOrg && orgId) {
      steps.push({
        label: 'balance_credits (RESTRICT blocker)',
        count: () => BalanceCredit.count({ where: { organisationId: orgId } }),
        run: (t) => BalanceCredit.destroy({ where: { organisationId: orgId }, transaction: t }),
      });
    }
    steps.push({
      label: 'usage_records (ambiguous FK — delete explicitly)',
      count: () => UsageRecord.count({ where: orgUserOr() }),
      run: (t) => UsageRecord.destroy({ where: orgUserOr(), transaction: t }),
    });
    steps.push({
      label: 'invocation_logs (ambiguous FK — delete explicitly)',
      count: () => InvocationLog.count({ where: orgUserOr() }),
      run: (t) => InvocationLog.destroy({ where: orgUserOr(), transaction: t }),
    });
    steps.push({
      label: 'chat_sessions (un-FK\'d orphan)',
      count: () => ChatSession.count({ where: orgUserOr() }),
      run: (t) => ChatSession.destroy({ where: orgUserOr(), transaction: t }),
    });
    if (haveSession) {
      steps.push({
        label: 'better-auth session',
        count: () => rawCount('SELECT count(*)::int AS n FROM session WHERE "userId" = ANY($1)', [userIds]),
        run: (t) => rawDelete('DELETE FROM session WHERE "userId" = ANY($1)', [userIds], t),
      });
    }
    if (haveAccount) {
      steps.push({
        label: 'better-auth account',
        count: () => rawCount('SELECT count(*)::int AS n FROM account WHERE "userId" = ANY($1)', [userIds]),
        run: (t) => rawDelete('DELETE FROM account WHERE "userId" = ANY($1)', [userIds], t),
      });
    }
  }
  // Email-keyed deletions — apply to a completed OR a provisional/waitlist target.
  if (haveVerification) {
    steps.push({
      label: 'better-auth verification (by email)',
      count: () => rawCount('SELECT count(*)::int AS n FROM verification WHERE lower(identifier) = ANY($1)', [emails]),
      run: (t) => rawDelete('DELETE FROM verification WHERE lower(identifier) = ANY($1)', [emails], t),
    });
  }
  if (haveWaitlist) {
    steps.push({
      label: 'waitlist_signups (polite-ai invite state, by email)',
      count: () => rawCount('SELECT count(*)::int AS n FROM waitlist_signups WHERE lower(email) = ANY($1)', [emails]),
      run: (t) => rawDelete('DELETE FROM waitlist_signups WHERE lower(email) = ANY($1)', [emails], t),
    });
  } else if (appDb && haveAppWaitlist) {
    steps.push({
      label: 'waitlist_signups (polite-ai invite state, by email — SEPARATE app DB, non-transactional)',
      appDb: true,
      count: async () => {
        const [row] = await appDb.query(
          'SELECT count(*)::int AS n FROM waitlist_signups WHERE lower(email) = ANY($1)',
          { bind: [emails], type: Sequelize.QueryTypes.SELECT },
        );
        return Number(row?.n ?? 0);
      },
      run: async () => {
        const res = await appDb.query('DELETE FROM waitlist_signups WHERE lower(email) = ANY($1)', { bind: [emails] });
        const meta = Array.isArray(res) ? res[1] : res;
        return meta?.rowCount ?? null;
      },
    });
  } else {
    console.error('');
    console.error('NOTICE: waitlist_signups is NOT in this database — polite-ai invite rows are NOT cleaned.');
    console.error('        A completed row left behind blocks re-signup under this email and keeps the emailed');
    console.error('        invite page claiming the account exists. Point --polite-env (or POLITE_ENV_FILE) at');
    console.error("        polite-ai's env file (e.g. ../polite-ai/.env.staging) and re-run — its POSTGRES_* vars");
    console.error('        carry the client-cert mTLS material — or delete the row there yourself.');
  }
  if (dropOrg && orgId) {
    steps.push({
      label: `organisation ${orgId} + CASCADE (users, agents, sets, instances, calls, txn logs, authkeys, concurrency, trunk links)`,
      count: async () => 1,
      run: (t) => Organisation.destroy({ where: { id: orgId }, transaction: t }),
    });
  } else if (target) {
    steps.push({
      label: `user ${target.id} + CASCADE (agents, sets, instances, calls, txn logs, authkeys)`,
      count: async () => 1,
      run: (t) => User.destroy({ where: { id: target.id }, transaction: t }),
    });
  }

  // ---- Report --------------------------------------------------------------
  console.log('');
  console.log('purge-user plan');
  console.log('  target      : ', target
    ? `${target.email} (id ${target.id}, role ${target.role || 'owner'})`
    : `${targetEmail} (provisional — no llm-agent user)`);
  console.log('  organisation: ', orgId ? `${orgId} (${dropOrg ? 'DROP' : 'keep'})` : '(none)');
  console.log('  in scope    : ', `${userIds.length} user(s), ${emails.length} email(s)`);
  console.log('  mode        : ', execute ? 'EXECUTE' : 'DRY RUN (no changes)');
  console.log('');

  if (target) await reportConstraints(sequelize, Sequelize);

  console.log('Deletions:');
  for (const s of steps) {
    let n;
    try { n = await s.count(); } catch (e) { n = `? (${e.message})`; }
    console.log(`  ${String(n).padStart(6)}  ${s.label}`);
  }
  console.log('');

  if (!execute) {
    console.log('DRY RUN — nothing deleted. Re-run with --confirm ' + targetEmail + ' to execute.');
    return done(0);
  }

  // ---- Execute (single transaction; separate-DB steps after commit) -------
  const txSteps = steps.filter((s) => !s.appDb);
  const appSteps = steps.filter((s) => s.appDb);
  const t = await sequelize.transaction();
  try {
    for (const s of txSteps) {
      const affected = await s.run(t);
      console.log(`  deleted ${String(affected ?? '?').padStart(6)}  ${s.label}`);
    }
    await t.commit();
    // Cross-DB steps can't join the transaction above; run them once it has
    // committed, and report a failure without pretending the main purge failed.
    for (const s of appSteps) {
      try {
        const affected = await s.run();
        console.log(`  deleted ${String(affected ?? '?').padStart(6)}  ${s.label}`);
      } catch (e) {
        console.error(`  FAILED  ${s.label}: ${e.message} — delete the row(s) in the app DB yourself.`);
      }
    }
  } catch (e) {
    await t.rollback();
    console.error('');
    console.error('FAILED — transaction rolled back, nothing was deleted.');
    console.error(`  ${e.name}: ${e.message}`);
    if (e.original?.constraint) {
      console.error(`  offending constraint: ${e.original.constraint} (table ${e.original.table || '?'})`);
      console.error('  A referencing table blocked the delete. Add it to the explicit-delete list above.');
    }
    logger.error(e, 'purge-user failed');
    return done(1);
  }

  console.log('');
  console.log(`Purged ${targetEmail}${dropOrg ? ` and organisation ${orgId}` : ''}. The email can sign up again.`);
  if (target) {
    console.log('Notes:');
    console.log('  - Running server instances may cache the deleted principal/AuthKey for up to ~60s.');
    console.log('  - NOT cleaned (acceptable orphans for a signup test): Stripe customer, integration');
    console.log('    OAuth grants, website-crawler knowledge base (separate stores). Clean those manually');
    console.log('    if this was a real account rather than a throwaway test user.');
  }
  return done(0);
}

/**
 * Print the LIVE onDelete rule for every FK that points at users/organisations,
 * so the operator can see reality before the first-ever real Organisation
 * destroy (the model file's onDelete is design-intent; sync({alter}) does not
 * reconcile it on pre-existing constraints). Informative, not a gate — a wrong
 * rule surfaces as a rolled-back FK error on execute.
 */
async function reportConstraints(sequelize, Sequelize) {
  try {
    const rows = await sequelize.query(
      `SELECT c.conname, c.confdeltype,
              tf.relname AS referencing_table,
              tt.relname AS referenced_table
         FROM pg_constraint c
         JOIN pg_class tf ON tf.oid = c.conrelid
         JOIN pg_class tt ON tt.oid = c.confrelid
        WHERE c.contype = 'f' AND tt.relname IN ('users','organisations')
        ORDER BY tt.relname, tf.relname`,
      { type: Sequelize.QueryTypes.SELECT },
    );
    const rule = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
    const risky = rows.filter((r) => r.confdeltype === 'a' || r.confdeltype === 'r');
    console.log(`Live FK onDelete rules -> users/organisations (${rows.length} constraints):`);
    if (risky.length) {
      console.log('  RESTRICT / NO ACTION (would block a parent delete unless the child is cleared first):');
      risky.forEach((r) => console.log(`    ${r.referencing_table} -> ${r.referenced_table}  [${rule[r.confdeltype]}]  ${r.conname}`));
    } else {
      console.log('  (all CASCADE / SET NULL)');
    }
    console.log('');
  } catch (e) {
    logger.warn({ err: e.message }, 'could not read pg_constraint (informational step skipped)');
  }
}

main().catch((e) => {
  logger.error(e, 'purge-user error');
  done(1);
});
