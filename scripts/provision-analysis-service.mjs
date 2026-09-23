/**
 * Provision the analysis-service identity for the polite-ai post-call analysis
 * seam: a synthetic user with role `analysisService` (agent:invoke plus the
 * cross-tenant agent:readAll that lets POST /agents/{id}/invoke take an
 * organisationId in the body; its model list allows decision models only, see
 * lib/auth/permissions.js) and an AuthKey, then prints the bearer token for
 * polite-ai's LLM_AGENT_ANALYSIS_TOKEN.
 *
 *   node scripts/provision-analysis-service.mjs                       # repo-root .env
 *   node scripts/provision-analysis-service.mjs -p /path/to/staging.env  # per environment
 *
 * Re-running ROTATES the credential: it mints a new key and revokes every
 * other key of the service user, so a leaked token dies with the run. The
 * user row is reused only when it already carries the analysisService role;
 * any other account holding the email stops the run, because the row would
 * otherwise become a cross-tenant principal with no organisation.
 *
 * Self-contained: loads the selected env file and talks to Postgres directly (it
 * does NOT import the app's database module, so it avoids the LISTEN subscriber /
 * model sync boot). Optional env: ANALYSIS_EMAIL, ANALYSIS_KEY (default a fresh
 * random token).
 *
 * SECURITY: this mints a credential. Run it against the target environment's DB,
 * capture the printed token into the secret store, and do NOT commit the token.
 */
import { randomBytes, randomUUID } from 'crypto';
import pg from 'pg';
import { loadEnv } from './env.mjs';

loadEnv();

const ROLE = 'analysisService';
const EMAIL = process.env.ANALYSIS_EMAIL || 'call-analysis-service@aplisay.internal';
const KEY = process.env.ANALYSIS_KEY || `asvc_${randomBytes(24).toString('hex')}`;

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
    throw new Error('POSTGRES_* not set, is .env present? (select one with -p /path/to/.env)');
  }
  console.log(`provisioning against postgres ${process.env.POSTGRES_HOST}/${process.env.POSTGRES_DB}`);
  await client.connect();

  const found = await client.query('SELECT id, role FROM users WHERE email = $1', [EMAIL]);
  if (found.rows.length > 1) {
    throw new Error(`${found.rows.length} users carry ${EMAIL}; remove the duplicates before provisioning`);
  }
  if (found.rows.length && found.rows[0].role !== ROLE) {
    throw new Error(
      `a user with the email ${EMAIL} exists with role "${found.rows[0].role}", not ${ROLE}; `
      + 'set ANALYSIS_EMAIL to an unused address or remove that account first');
  }
  let userId;
  if (found.rows.length) {
    userId = found.rows[0].id;
    await client.query(`UPDATE users SET status = 'active', organisation_id = NULL, updated_at = now() WHERE id = $1`, [userId]);
    console.log(`reusing ${ROLE} user ${userId} (${EMAIL})`);
  } else {
    userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, name, email, email_verified, phone, phone_verified, picture, role, status, created_at, updated_at)
       VALUES ($1, 'Call Analysis Service', $2, true, '', false, '', $3, 'active', now(), now())`,
      [userId, EMAIL, ROLE],
    );
    console.log(`created ${ROLE} user ${userId} (${EMAIL})`);
  }

  // role_restriction holds the role NAME, so a later change to the role reaches this key with no re-mint.
  await client.query(
    `INSERT INTO auth_keys (key, user_id, role_restriction, expires, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now(), now())
     ON CONFLICT (key) DO UPDATE SET user_id = EXCLUDED.user_id, role_restriction = EXCLUDED.role_restriction, expires = EXCLUDED.expires, updated_at = now()`,
    [KEY, userId, JSON.stringify(ROLE), new Date('2099-01-01T00:00:00Z')],
  );
  const revoked = await client.query('DELETE FROM auth_keys WHERE user_id = $1 AND key <> $2', [userId, KEY]);
  if (revoked.rowCount) {
    console.log(`revoked ${revoked.rowCount} earlier key${revoked.rowCount > 1 ? 's' : ''} of the service user`);
  }

  console.log('\n--- set this in polite-ai env (do NOT commit) ---');
  console.log(`LLM_AGENT_ANALYSIS_TOKEN=${KEY}`);
  await client.end();
}

main().catch(async (e) => {
  console.error('provisioning failed:', e?.message || e);
  try { await client.end(); } catch { /* ignore */ }
  process.exit(1);
});
