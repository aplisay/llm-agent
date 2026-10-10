// Sequelize pool sizing from the environment. Dependency-free on purpose:
// middleware/concurrency-gate.js reads the pool size to pick its default, and
// importing lib/database.js connects to Postgres as a side effect.
//
// The per-instance cap is small on purpose. Every API instance (plus the
// jambonz-agent service) opens up to `max` connections to the same Cloud SQL
// instance, and pg-listen holds one more per process, so the fleet-wide
// ceiling is roughly (instances x (max + 1)). Check that against the Cloud SQL
// max_connections before raising POSTGRES_POOL_MAX. See docs/db-pool-and-bulk-reads.md.

export const POOL_MAX_DEFAULT = 5;
export const POOL_MIN_DEFAULT = 0;
export const POOL_ACQUIRE_MS_DEFAULT = 60 * 1000;
export const POOL_IDLE_MS_DEFAULT = 10 * 1000;

function nonNegativeInt(value, fallback) {
  if (!/^\d+$/.test(String(value ?? '').trim())) return fallback;
  return Number(value);
}

function positiveInt(value, fallback) {
  const n = nonNegativeInt(value, fallback);
  return n > 0 ? n : fallback;
}

/**
 * Sequelize `pool` options from the environment.
 *
 * POSTGRES_POOL_MAX        connections per process (default 5)
 * POSTGRES_POOL_MIN        idle connections kept open (default 0, never above max)
 * POSTGRES_POOL_ACQUIRE_MS how long a query waits for a free connection before
 *                          it fails (default 60000)
 * POSTGRES_POOL_IDLE_MS    how long an idle connection is kept (default 10000)
 */
export function poolConfig(env = process.env) {
  const max = positiveInt(env.POSTGRES_POOL_MAX, POOL_MAX_DEFAULT);
  const min = Math.min(nonNegativeInt(env.POSTGRES_POOL_MIN, POOL_MIN_DEFAULT), max);
  return {
    max,
    min,
    acquire: positiveInt(env.POSTGRES_POOL_ACQUIRE_MS, POOL_ACQUIRE_MS_DEFAULT),
    idle: positiveInt(env.POSTGRES_POOL_IDLE_MS, POOL_IDLE_MS_DEFAULT),
  };
}
