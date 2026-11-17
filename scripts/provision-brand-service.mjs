/**
 * Provision the service identity for one brand's front end. Idempotently
 * creates a synthetic user with role `brandService` and an AuthKey that carries
 * the brand, then prints the bearer token. The key creates organisations of
 * that brand and sets their capabilities. It reaches no organisation of another
 * brand (lib/auth/admin-scope.js).
 *
 *   node scripts/provision-brand-service.mjs --brand acme                  # repo-root .env
 *   node scripts/provision-brand-service.mjs --brand acme -p /path/to/env  # per environment
 *
 * The brand must exist first: `PUT /api/brands/{brandId}` as a platform
 * operator. Self-contained like the other provision-*-service scripts: it talks
 * to Postgres directly and does not import the app's database module. Optional
 * env: BRAND_SERVICE_KEY (default a fresh random token).
 *
 * SECURITY: this mints a credential. Capture the printed token into the secret
 * store and do NOT commit it.
 */
import { randomBytes, randomUUID } from 'crypto';
import pg from 'pg';
import { loadEnv } from './env.mjs';
import { validateBrandId } from '../lib/brands.js';

loadEnv();

function argValue(name) {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

const BRAND = argValue('--brand');
const KEY = process.env.BRAND_SERVICE_KEY || `bsvc_${randomBytes(24).toString('hex')}`;

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
  const problem = validateBrandId(BRAND);
  if (problem) throw new Error(`--brand is required. ${problem}`);
  if (!process.env.POSTGRES_HOST) {
    throw new Error('POSTGRES_* not set — is .env present? (select one with -p /path/to/.env)');
  }
  console.log(`provisioning against postgres ${process.env.POSTGRES_HOST}/${process.env.POSTGRES_DB}`);
  await client.connect();

  const brand = await client.query('SELECT id FROM brands WHERE id = $1', [BRAND]).catch((e) => {
    if (e?.code === '42P01') throw new Error('No brands table. Run tools/agent-admin.js upgrade-db first.');
    throw e;
  });
  if (!brand.rows.length) throw new Error(`No brand "${BRAND}". Create it with PUT /api/brands/${BRAND} first.`);

  const email = `brand-service+${BRAND}@aplisay.internal`;
  const found = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  let userId;
  if (found.rows.length) {
    userId = found.rows[0].id;
    await client.query(`UPDATE users SET role = 'brandService', status = 'active', updated_at = now() WHERE id = $1`, [userId]);
    console.log(`reusing brandService user ${userId} (${email})`);
  } else {
    userId = randomUUID();
    await client.query(
      `INSERT INTO users (id, name, email, email_verified, phone, phone_verified, picture, role, status, created_at, updated_at)
       VALUES ($1, $2, $3, true, '', false, '', 'brandService', 'active', now(), now())`,
      [userId, `Brand service (${BRAND})`, email],
    );
    console.log(`created brandService user ${userId} (${email})`);
  }

  // role_restriction pins the key to the brandService statements even if the user's role changes.
  await client.query(
    `INSERT INTO auth_keys (key, user_id, role_restriction, brand, expires, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, now(), now())
     ON CONFLICT (key) DO UPDATE SET user_id = EXCLUDED.user_id, role_restriction = EXCLUDED.role_restriction,
       brand = EXCLUDED.brand, expires = EXCLUDED.expires, updated_at = now()`,
    [KEY, userId, JSON.stringify('brandService'), BRAND, new Date('2099-01-01T00:00:00Z')],
  );

  console.log('\n--- the brand service key (do NOT commit) ---');
  console.log(`BRAND_SERVICE_KEY=${KEY}`);
  await client.end();
}

main().catch(async (e) => {
  console.error('provisioning failed:', e?.message || e);
  try { await client.end(); } catch { /* ignore */ }
  process.exit(1);
});
