/**
 * Verify — and where possible repair — the billing-service credential an
 * environment holds, WITHOUT rotating it.
 *
 *   node scripts/verify-billing-service.mjs                          # repo-root .env
 *   node scripts/verify-billing-service.mjs -p /path/to/beta.env     # per environment
 *   node scripts/verify-billing-service.mjs -p ... --fix             # apply repairs
 *   node scripts/verify-billing-service.mjs -p ... --probe https://api.example.com
 *
 * Why this exists: the client billing seam's rate-card assignment is fail-soft,
 * so a credential that cannot assign rates does not raise an error anywhere —
 * it just leaves every organisation unrated, and their usage rows land
 * `cost_status='no_rate'`: metered, never charged. That is invisible until
 * someone reads the ledger. This script makes the credential's actual
 * capability legible before it matters.
 *
 * Three checks:
 *
 *  1. **user role** — the synthetic user must be role `billingService`, active.
 *  2. **key restriction shape** — an AuthKey whose `role_restriction` is the
 *     ROLE NAME resolves against the CURRENT vocabulary, so widening the role
 *     reaches it on the next deploy. One frozen as a literal statement MAP is
 *     pinned to whatever it was minted with and silently misses every later
 *     grant. `--fix` rewrites such a key's restriction to the role name — the
 *     key VALUE is untouched, so no secret rotation and no env change.
 *  3. **deployed build** (`--probe <baseUrl>`) — asks the RUNNING service what
 *     the key can actually do. The vocabulary in this repo is only the intent;
 *     the deployed image is the fact, and the two diverge until it ships.
 *
 * Read-only unless `--fix` is passed. Talks to Postgres directly (it does NOT
 * import the app's database module, so it avoids the LISTEN subscriber / model
 * sync boot), mirroring provision-billing-service.mjs.
 */
import pg from 'pg';
import { loadEnv } from './env.mjs';
import { statementsFor } from '../lib/auth/permissions.js';

loadEnv();

const ROLE = 'billingService';
const EMAIL = process.env.BILLING_EMAIL || 'stripe-billing-service@aplisay.internal';
const FIX = process.argv.includes('--fix');
const probeArg = process.argv.indexOf('--probe');
const PROBE_URL = probeArg > -1 ? process.argv[probeArg + 1] : process.env.LLM_AGENT_URL || null;

/**
 * The capabilities the client billing seam actually exercises, each named with
 * the call that needs it, so a failure report says what will break rather than
 * just which action is missing.
 */
const REQUIRED = [
  ['organisation', 'credit', 'credit a wallet top-up to the org balance'],
  ['organisation', 'billing', 'set the balance-callback config / block flag'],
  ['call', 'prune', 'apply the plan retention window to call artifacts'],
  ['rate', 'read', 'list the rate cards (GET /rates)'],
  ['organisation', 'read', "read the org's rate-name timeline"],
  ['organisation', 'readAll', 'reach an org at all — this principal has no org of its own'],
  ['organisation', 'setRate', "write the org's rate-name timeline"],
];

const client = new pg.Client({
  host: process.env.POSTGRES_HOST,
  port: Number(process.env.POSTGRES_PORT),
  user: process.env.POSTGRES_USER,
  password: process.env.POSTGRES_PASSWORD,
  database: process.env.POSTGRES_DB,
  ssl: process.env.POSTGRES_CA
    ? {
      ca: process.env.POSTGRES_CA,
      key: process.env.POSTGRES_KEY,
      cert: process.env.POSTGRES_CERT,
      servername: process.env.POSTGRES_RO_SERVER_NAME,
      rejectUnauthorized: false,
    }
    : false,
});

const problems = [];
const note = (ok, message) => {
  console.log(`${ok ? '  ok   ' : '  FAIL '} ${message}`);
  if (!ok) problems.push(message);
};

/** What THIS build's vocabulary grants the role — the intent, not the deployment. */
function checkVocabulary() {
  console.log(`\nrole vocabulary in this checkout (${ROLE}):`);
  const statements = statementsFor(ROLE) || {};
  for (const [resource, action, why] of REQUIRED) {
    note((statements[resource] || []).includes(action), `${resource}:${action} — ${why}`);
  }
}

async function checkUser() {
  console.log(`\nservice user (${EMAIL}):`);
  const { rows } = await client.query('SELECT id, role, status FROM users WHERE email = $1', [EMAIL]);
  if (!rows.length) {
    note(false, 'no service user — run scripts/provision-billing-service.mjs first');
    return null;
  }
  const user = rows[0];
  note(user.role === ROLE, `role is '${user.role}' (want '${ROLE}')`);
  note(user.status === 'active', `status is '${user.status}' (want 'active')`);
  if (FIX && (user.role !== ROLE || user.status !== 'active')) {
    await client.query(
      `UPDATE users SET role = $2, status = 'active', updated_at = now() WHERE id = $1`,
      [user.id, ROLE],
    );
    console.log(`  fixed  user ${user.id} → role=${ROLE}, status=active`);
  }
  return user;
}

async function checkKeys(user) {
  if (!user) return [];
  console.log('\nauth keys:');
  const { rows } = await client.query(
    'SELECT key, role_restriction, expires FROM auth_keys WHERE user_id = $1 ORDER BY created_at',
    [user.id],
  );
  if (!rows.length) {
    note(false, 'no AuthKey for the service user — run scripts/provision-billing-service.mjs');
    return [];
  }
  if (rows.length > 1) {
    // Not a fault — an environment may hold a rotated pair — but every one of
    // them can authenticate, so every one of them has to be sound.
    console.log(`  note   ${rows.length} keys exist; all are live credentials`);
  }
  for (const row of rows) {
    const label = `${String(row.key).slice(0, 8)}…`;
    const restriction = row.role_restriction;
    const frozen = restriction && typeof restriction === 'object' && !Array.isArray(restriction);
    if (frozen) {
      note(false, `${label} role_restriction is a literal statement map — FROZEN at its minted actions, it will never pick up a widened role`);
      if (FIX) {
        await client.query(
          `UPDATE auth_keys SET role_restriction = $2::jsonb, updated_at = now() WHERE key = $1`,
          [row.key, JSON.stringify(ROLE)],
        );
        console.log(`  fixed  ${label} role_restriction → "${ROLE}" (key value unchanged — no rotation needed)`);
      }
    } else {
      note(restriction === ROLE, `${label} role_restriction is ${JSON.stringify(restriction)} (want "${ROLE}")`);
    }
    const expires = row.expires ? new Date(row.expires) : null;
    note(!expires || expires.getTime() > Date.now(), `${label} expires ${expires ? expires.toISOString() : 'never'}`);
  }
  return rows.map((r) => r.key);
}

/**
 * Ask the RUNNING service, using the credential this environment actually holds
 * (read from the DB above — no need to have the secret to hand). `GET /api/rates`
 * is the exact call the client seam makes first, so a 403 here IS the production
 * failure, reproduced; 200 proves the deployed build carries the widened role.
 */
async function probe(url, keys) {
  if (!url) {
    console.log('\ndeployed build: skipped (pass --probe <baseUrl> to check the running service)');
    return;
  }
  if (!keys.length) {
    console.log(`\ndeployed build at ${url}: skipped (no key to probe with)`);
    return;
  }
  console.log(`\ndeployed build at ${url}:`);
  for (const key of keys) {
    const label = `${String(key).slice(0, 8)}…`;
    try {
      const res = await fetch(`${url.replace(/\/+$/, '')}/api/rates`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok) {
        const names = (body.rates || []).map((r) => r.name);
        note(true, `${label} GET /api/rates → 200, cards: ${names.length ? names.join(', ') : '(none)'}`);
        if (!names.length) note(false, 'no rate cards exist in this environment — there is nothing to assign');
      } else {
        note(false, `${label} GET /api/rates → ${res.status} ${body.detail || body.message || ''} — the RUNNING build predates the widened role; deploy it`);
      }
    } catch (e) {
      note(false, `${label} GET /api/rates failed: ${e.message}`);
    }
  }
}

async function main() {
  if (!process.env.POSTGRES_HOST) {
    throw new Error('POSTGRES_* not set — is .env present? (select one with -p /path/to/.env)');
  }
  console.log(`checking billing service against postgres ${process.env.POSTGRES_HOST}/${process.env.POSTGRES_DB}`);
  console.log(FIX ? 'mode: FIX (repairs will be written)' : 'mode: read-only (pass --fix to repair)');
  await client.connect();

  checkVocabulary();
  const user = await checkUser();
  const keys = await checkKeys(user);
  await client.end();
  await probe(PROBE_URL, keys);

  if (problems.length) {
    console.error(`\n${problems.length} problem(s) found.`);
    process.exit(1);
  }
  console.log('\nall checks passed.');
}

main().catch(async (e) => {
  console.error('verification failed:', e?.message || e);
  try { await client.end(); } catch { /* already closed */ }
  process.exit(1);
});
