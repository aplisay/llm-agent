/**
 * Serialise boot DDL across processes even when statements use IF NOT EXISTS. See PR #298.
 * Keep the session advisory lock on a dedicated connection; pooled queries may use a different session.
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
