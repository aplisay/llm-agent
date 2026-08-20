/**
 * Provision the least-privilege billing-service identity for the polite-ai
 * billing seam (Phase 4). Idempotently creates a synthetic user with role
 * `billingService` — balance credits, billing controls, call-artifact pruning
 * and rate-card assignment, and nothing else; lib/auth/permissions.js holds the
 * exact vocabulary — plus an AuthKey, then prints the bearer token for
 * polite-ai's LLM_AGENT_BILLING_TOKEN.
 *
 * To CHECK (or repair) an environment's existing credential, use
 * scripts/verify-billing-service.mjs instead: re-running THIS script mints a new
 * token, which means a secret-store update on the client side.
 *
 *   node scripts/provision-billing-service.mjs                       # repo-root .env
 *   node scripts/provision-billing-service.mjs -p /path/to/staging.env  # per environment
 *
 * Self-contained: loads the selected env file and talks to Postgres directly (it
 * does NOT import the app's database module, so it avoids the LISTEN subscriber /
 * model sync boot). Optional env: BILLING_EMAIL, BILLING_KEY (default a fresh
 * random token).
 *
 * SECURITY: this mints a credential. Run it against the target environment's DB,
 * capture the printed token into the secret store, and do NOT commit the token.
 */
import { randomBytes, randomUUID } from 'crypto';
import pg from 'pg';
import { loadEnv } from './env.mjs';

loadEnv();

const EMAIL = process.env.BILLING_EMAIL || 'stripe-billing-service@aplisay.internal';
const KEY = process.env.BILLING_KEY || `bsvc_${randomBytes(24).toString('hex')}`;

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

async function main() {
  if (!process.env.POSTGRES_HOST) {
    throw new Error('POSTGRES_* not set — is .env present? (select one with -p /path/to/.env)');
  }
  console.log(`provisioning against postgres ${process.env.POSTGRES_HOST}/${process.env.POSTGRES_DB}`);
  await client.connect();

  // Upsert the synthetic user by email; role=billingService, status=active.
  const found = await client.query('SELECT id FROM users WHERE email = $1', [EMAIL]);
  let userId;
  if (found.rows.length) {
    userId = found.rows[0].id;
    await client.query(`UPDATE users SET role = 'billingService', status = 'active', updated_at = now() WHERE id = $1`, [userId]);
    console.log(`reusing billingService user ${userId} (${EMAIL})`);
  } else {
    userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, name, email, email_verified, phone, phone_verified, picture, role, status, created_at, updated_at)
       VALUES ($1, 'Stripe Billing Service', $2, true, '', false, '', 'billingService', 'active', now(), now())`,
      [userId, EMAIL],
    );
    console.log(`created billingService user ${userId} (${EMAIL})`);
  }

  // Upsert the AuthKey. role_restriction='billingService' pins the key to the
  // billingService vocabulary even if the user's role ever changes (defence in
  // depth). Stored as the role NAME, never as a literal statement map: a name
  // resolves against the CURRENT vocabulary, so a later widening of the role
  // reaches this key on the next deploy with no re-mint; a frozen map would
  // silently miss it (verify-billing-service.mjs reports and repairs that).
  await client.query(
    `INSERT INTO auth_keys (key, user_id, role_restriction, expires, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now(), now())
     ON CONFLICT (key) DO UPDATE SET user_id = EXCLUDED.user_id, role_restriction = EXCLUDED.role_restriction, expires = EXCLUDED.expires, updated_at = now()`,
    [KEY, userId, JSON.stringify('billingService'), new Date('2099-01-01T00:00:00Z')],
  );

  console.log('\n--- set this in polite-ai env (do NOT commit) ---');
  console.log(`LLM_AGENT_BILLING_TOKEN=${KEY}`);
  await client.end();
}

main().catch(async (e) => {
  console.error('provisioning failed:', e?.message || e);
  try { await client.end(); } catch { /* ignore */ }
  process.exit(1);
});
