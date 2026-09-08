/**
 * A cross-process mutex around the schema work every server process runs when
 * it starts (lib/database.js: enum values, table and column adds, column
 * defaults, data heals). Each step is idempotent, but Postgres does not make
 * two processes running the same DDL at once safe: concurrent
 * `CREATE TABLE IF NOT EXISTS` or `ADD COLUMN IF NOT EXISTS` can fail on a
 * catalogue race, and the boot chain treats any failure as fatal. Two pods
 * starting together (a scale-up, a rolling deploy) could take one down once.
 *
 * The lock is a Postgres session-level advisory lock on a fixed key, held on
 * a dedicated connection for the duration of the boot chain. Postgres queues
 * other takers until it is released, and releases it itself if the holder
 * dies, so a crashed boot never wedges the rest. The connection is separate
 * from the Sequelize pool on purpose: a session lock belongs to one
 * connection, and pooled queries may run on any.
 */
import pg from 'pg';

// Any fixed 64-bit value: it only has to be the same in every process.
export const BOOT_LOCK_KEY = '4207189273618255201';

/**
 * Take the boot lock, waiting for another process to finish if it holds it.
 * @param {object} connection pg client config (connectionString, ssl)
 * @returns {Promise<{ release: () => Promise<void> }>}
 */
export async function acquireBootLock(connection, { log } = {}) {
  const client = new pg.Client(connection);
  await client.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1::bigint) AS held', [BOOT_LOCK_KEY]);
    if (!rows[0]?.held) {
      log?.info?.('another process is running the boot-time schema work; waiting for it to finish');
      await client.query('SELECT pg_advisory_lock($1::bigint)', [BOOT_LOCK_KEY]);
    }
  }
  catch (err) {
    await client.end().catch(() => {});
    throw err;
  }
  return {
    async release() {
      try {
        await client.query('SELECT pg_advisory_unlock($1::bigint)', [BOOT_LOCK_KEY]);
      }
      finally {
        await client.end().catch(() => {});
      }
    },
  };
}
