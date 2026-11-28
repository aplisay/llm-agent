/**
 * Provision the service identity for the service that sends emergency address
 * records to the carrier. Idempotently creates a synthetic user with role
 * `emergencyService` and an AuthKey, then prints the bearer token. The key
 * reads and writes the state of every organisation's records through the
 * /emergency-records routes (docs/emergency-records.md). Nothing else.
 *
 *   node scripts/provision-emergency-service.mjs                       # repo-root .env
 *   node scripts/provision-emergency-service.mjs -p /path/to/staging.env  # per environment
 *   node scripts/provision-emergency-service.mjs --rotate               # replace the key
 *
 * The service has one key. A second run stops unless it is given --rotate,
 * which makes a new key and deletes the old one: the old key stops working at once.
 *
 * Self-contained like the other provision-*-service scripts: it talks to
 * Postgres directly and does not import the app's database module. Optional
 * env: EMERGENCY_SERVICE_EMAIL, EMERGENCY_SERVICE_KEY (default a fresh random token).
 *
 * SECURITY: this mints a credential. Capture the printed token into the secret
 * store and do NOT commit it.
 */
import { randomBytes, randomUUID } from 'crypto';
import pg from 'pg';
import { loadEnv } from './env.mjs';

loadEnv();

const EMAIL = process.env.EMERGENCY_SERVICE_EMAIL || 'emergency-service@aplisay.internal';
const KEY = process.env.EMERGENCY_SERVICE_KEY || `esvc_${randomBytes(24).toString('hex')}`;
const ROTATE = process.argv.includes('--rotate');

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
    throw new Error('POSTGRES_* not set. Is .env present? Select one with -p /path/to/.env');
  }
  console.log(`provisioning against postgres ${process.env.POSTGRES_HOST}/${process.env.POSTGRES_DB}`);
  await client.connect();

  const found = await client.query('SELECT id FROM users WHERE email = $1', [EMAIL]);
  let userId;
  if (found.rows.length) {
    userId = found.rows[0].id;
    const others = await client.query('SELECT count(*)::int AS n FROM auth_keys WHERE user_id = $1 AND key <> $2', [userId, KEY]);
    if (others.rows[0].n && !ROTATE) {
      throw new Error('this service has a key already. Run again with --rotate to replace it: the old key stops working at once');
    }
    await client.query(`UPDATE users SET role = 'emergencyService', status = 'active', organisation_id = NULL, updated_at = now() WHERE id = $1`, [userId]);
    console.log(`reusing emergencyService user ${userId} (${EMAIL})`);
  } else {
    userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, name, email, email_verified, phone, phone_verified, picture, role, status, created_at, updated_at)
       VALUES ($1, 'Emergency Record Service', $2, true, '', false, '', 'emergencyService', 'active', now(), now())`,
      [userId, EMAIL],
    );
    console.log(`created emergencyService user ${userId} (${EMAIL})`);
  }

  // role_restriction pins the key to the emergencyService statements even if the user's role changes.
  await client.query(
    `INSERT INTO auth_keys (key, user_id, role_restriction, expires, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now(), now())
     ON CONFLICT (key) DO UPDATE SET user_id = EXCLUDED.user_id, role_restriction = EXCLUDED.role_restriction, expires = EXCLUDED.expires, updated_at = now()`,
    [KEY, userId, JSON.stringify('emergencyService'), new Date('2099-01-01T00:00:00Z')],
  );

  const old = await client.query('DELETE FROM auth_keys WHERE user_id = $1 AND key <> $2', [userId, KEY]);
  if (old.rowCount) console.log(`deleted ${old.rowCount} earlier key(s) of this service`);

  console.log('\n--- the emergency service key (do NOT commit) ---');
  console.log(`EMERGENCY_SERVICE_KEY=${KEY}`);
  await client.end();
}

main().catch(async (e) => {
  console.error('provisioning failed:', e?.message || e);
  try { await client.end(); } catch { /* ignore */ }
  process.exit(1);
});
