// Holds the boot lock from a SEPARATE process, for tests/boot-lock.test.mjs.
//
// Connects with the POSTGRES_* variables it is given, takes the boot lock the
// way a booting server does, prints "locked", and keeps holding it until
// anything arrives on stdin (or stdin closes). Then it unlocks and exits 0.
import pg from 'pg';
import { BOOT_LOCK_KEY } from '../../lib/boot-lock.js';

const { POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_HOST, POSTGRES_PORT, POSTGRES_DB } = process.env;
const client = new pg.Client({
  connectionString: `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}`,
});

try {
  await client.connect();
  await client.query('SELECT pg_advisory_lock($1::bigint)', [BOOT_LOCK_KEY]);
  process.stdout.write('locked\n');
  await new Promise((resolve) => {
    process.stdin.once('data', resolve);
    process.stdin.once('end', resolve);
    process.stdin.resume();
  });
  await client.query('SELECT pg_advisory_unlock($1::bigint)', [BOOT_LOCK_KEY]);
  await client.end();
  process.exit(0);
}
catch (err) {
  console.error(err?.stack || String(err));
  process.exit(1);
}
