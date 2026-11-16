/**
 * Provision the service identity for the knowledge service (the crawler).
 * Idempotently creates a synthetic user with role `knowledgeService` and an
 * AuthKey, then prints the bearer token. The key reads any organisation's
 * directory, answers the agent tools `directory_lookup` and
 * `directory_resolve` from it, and writes what a crawl finds through
 * POST /directory/batch as the actor `crawl`. Nothing else.
 *
 *   node scripts/provision-knowledge-service.mjs                       # repo-root .env
 *   node scripts/provision-knowledge-service.mjs -p /path/to/staging.env  # per environment
 *
 * Self-contained like the other provision-*-service scripts: it talks to
 * Postgres directly and does not import the app's database module. Optional
 * env: KNOWLEDGE_SERVICE_EMAIL, KNOWLEDGE_SERVICE_KEY (default a fresh random token).
 *
 * SECURITY: this mints a credential. Capture the printed token into the secret
 * store and do NOT commit it.
 */
import { randomBytes, randomUUID } from 'crypto';
import pg from 'pg';
import { loadEnv } from './env.mjs';

loadEnv();

const EMAIL = process.env.KNOWLEDGE_SERVICE_EMAIL || 'knowledge-service@aplisay.internal';
const KEY = process.env.KNOWLEDGE_SERVICE_KEY || `ksvc_${randomBytes(24).toString('hex')}`;

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

  const found = await client.query('SELECT id FROM users WHERE email = $1', [EMAIL]);
  let userId;
  if (found.rows.length) {
    userId = found.rows[0].id;
    await client.query(`UPDATE users SET role = 'knowledgeService', status = 'active', organisation_id = NULL, updated_at = now() WHERE id = $1`, [userId]);
    console.log(`reusing knowledgeService user ${userId} (${EMAIL})`);
  } else {
    userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, name, email, email_verified, phone, phone_verified, picture, role, status, created_at, updated_at)
       VALUES ($1, 'Knowledge Service', $2, true, '', false, '', 'knowledgeService', 'active', now(), now())`,
      [userId, EMAIL],
    );
    console.log(`created knowledgeService user ${userId} (${EMAIL})`);
  }

  // role_restriction pins the key to the knowledgeService statements even if the user's role changes.
  await client.query(
    `INSERT INTO auth_keys (key, user_id, role_restriction, expires, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now(), now())
     ON CONFLICT (key) DO UPDATE SET user_id = EXCLUDED.user_id, role_restriction = EXCLUDED.role_restriction, expires = EXCLUDED.expires, updated_at = now()`,
    [KEY, userId, JSON.stringify('knowledgeService'), new Date('2099-01-01T00:00:00Z')],
  );

  console.log('\n--- the knowledge service key (do NOT commit) ---');
  console.log(`KNOWLEDGE_SERVICE_KEY=${KEY}`);
  await client.end();
}

main().catch(async (e) => {
  console.error('provisioning failed:', e?.message || e);
  try { await client.end(); } catch { /* ignore */ }
  process.exit(1);
});
