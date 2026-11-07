#!/usr/bin/env node
/**
 * Check this instance's configuration without starting the server: which
 * runtimes and providers are enabled, why the rest are not, and whether the
 * database answers. Changes nothing.
 *
 *   yarn doctor [-p <env file>]
 */
import pg from 'pg';
import { loadEnv } from './env.mjs';

loadEnv();

const { configStatus, formatStatus } = await import('../lib/config-status.js');

async function checkDatabase(env) {
  const missing = ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_DB', 'POSTGRES_USER'].filter((name) => !env[name]);
  if (missing.length) return { ok: false, detail: `missing ${missing.join(', ')}` };
  const client = new pg.Client({
    host: env.POSTGRES_HOST,
    port: Number(env.POSTGRES_PORT),
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    connectionTimeoutMillis: 5000,
    ...(env.POSTGRES_CA && {
      ssl: { ca: env.POSTGRES_CA, key: env.POSTGRES_KEY, cert: env.POSTGRES_CERT, servername: env.POSTGRES_RO_SERVER_NAME },
    }),
  });
  try {
    await client.connect();
    const { rows: [{ table }] } = await client.query("SELECT to_regclass('public.users') AS table");
    if (table === null) return { ok: true, detail: 'connected; no schema yet (the server creates it at first start)' };
    const { rows: [{ users }] } = await client.query('SELECT count(*) AS users FROM users');
    if (Number(users) === 0) return { ok: true, detail: 'connected; no users yet: run yarn bootstrap or set BOOTSTRAP_API_KEY' };
    return { ok: true, detail: `connected; ${users} user(s)` };
  } catch (err) {
    return { ok: false, detail: err.message };
  } finally {
    await client.end().catch(() => {});
  }
}

const [status, database] = await Promise.all([configStatus(), checkDatabase(process.env)]);
console.log(formatStatus(status));
console.log(`Database\n  ${database.ok ? 'ok' : 'FAILED'}  ${database.detail}`);
if (!status.runtimes.some((r) => r.enabled && r.name !== 'text')) {
  console.log('Note\n  no voice runtime is enabled: only text agents can run');
}
process.exit(database.ok ? 0 : 1);
