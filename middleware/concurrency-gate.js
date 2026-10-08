// A bounded in-process concurrency gate for the bulk call-log reads.
//
// The API has one Sequelize pool per process and every route draws from it.
// GET /api/calls/{id}/logs and /invocation-log each hold a connection for as
// long as their unindexed scan (and, for invocation-log, the gunzip of every
// row) takes, so a handful of them in flight can hold the whole pool. The
// workers' /api/agent-db/* lookups during call setup then queue behind them
// and time out, and the call fails.
//
// The gate caps how many of these reads run at once per process, at a number
// below the pool size, so the pool always keeps free connections for
// everything else. A request over the cap waits briefly for a slot; if none
// frees up, or the wait list is already full, it gets 503 with Retry-After.
// A per-principal rate limit bounds how often one client may ask; this
// bounds how much of the pool all of them together may hold.
//
// Per process, like the pool it protects. See docs/db-pool-and-bulk-reads.md.
import { poolConfig } from '../lib/db-pool-config.js';

export const CALL_LOG_QUEUE_WAIT_MS_DEFAULT = 2000;

function positiveInt(value, fallback) {
  if (!/^\d+$/.test(String(value ?? '').trim())) return fallback;
  const n = Number(value);
  return n > 0 ? n : fallback;
}

/**
 * Gate settings for the call-log reads, from the environment.
 *
 * CALL_LOG_MAX_CONCURRENT  reads in flight per process. Default: half the
 *                          pool, at least 1. Always clamped below the pool
 *                          size (POSTGRES_POOL_MAX) so the gate can never hold
 *                          the whole pool; `clamped` reports when that happened.
 * CALL_LOG_QUEUE_WAIT_MS   how long an over-cap request waits for a slot
 *                          before it is answered 503 (default 2000).
 * CALL_LOG_QUEUE_MAX       how many requests may wait at once (default
 *                          4 x CALL_LOG_MAX_CONCURRENT); beyond that, 503 at once.
 */
export function callLogGateConfig(env = process.env) {
  const poolMax = poolConfig(env).max;
  const ceiling = Math.max(1, poolMax - 1);
  const requested = positiveInt(env.CALL_LOG_MAX_CONCURRENT, Math.max(1, Math.floor(poolMax / 2)));
  const max = Math.min(requested, ceiling);
  const waitMs = positiveInt(env.CALL_LOG_QUEUE_WAIT_MS, CALL_LOG_QUEUE_WAIT_MS_DEFAULT);
  return {
    max,
    waitMs,
    maxQueue: positiveInt(env.CALL_LOG_QUEUE_MAX, max * 4),
    retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
    poolMax,
    clamped: requested > max,
  };
}

/**
 * Build the gate middleware. `max` slots; an over-cap request waits up to
 * `waitMs` for one unless `maxQueue` requests are already waiting. The slot is
 * released when the response finishes or the socket closes, whichever is first.
 * `gate.stats()` reports the live counters (for tests and logging).
 */
export function createConcurrencyGate({ max, waitMs, maxQueue, retryAfterSeconds, name = 'gate', logger } = {}) {
  if (!(max > 0)) throw new Error('createConcurrencyGate: max must be a positive integer');
  waitMs = waitMs ?? CALL_LOG_QUEUE_WAIT_MS_DEFAULT;
  maxQueue = maxQueue ?? max * 4;
  retryAfterSeconds = retryAfterSeconds ?? Math.max(1, Math.ceil(waitMs / 1000));

  let active = 0;
  const waiting = [];
  const counters = { served: 0, queued: 0, rejected: 0 };

  function release() {
    const next = waiting.shift();
    if (next) {
      // Hand the slot straight on; `active` stays the same.
      clearTimeout(next.timer);
      next.resolve(true);
      return;
    }
    active -= 1;
  }

  /** Resolves true with a slot held, false when the caller must give up. */
  function acquire() {
    if (active < max) {
      active += 1;
      return Promise.resolve(true);
    }
    if (waiting.length >= maxQueue) return Promise.resolve(false);
    counters.queued += 1;
    return new Promise((resolve) => {
      const entry = { resolve, timer: null };
      entry.timer = setTimeout(() => {
        const i = waiting.indexOf(entry);
        if (i >= 0) waiting.splice(i, 1);
        resolve(false);
      }, waitMs);
      waiting.push(entry);
    });
  }

  function reject(res) {
    counters.rejected += 1;
    res.set('Retry-After', String(retryAfterSeconds));
    res.status(503).json({
      message: 'The server is busy with other call log reads. Retry after the interval in the Retry-After header.',
    });
  }

  async function gate(req, res, next) {
    if (req.method === 'OPTIONS') return next();
    const got = await acquire();
    if (!got) {
      logger?.warn?.({ gate: name, active, waiting: waiting.length, max }, 'concurrency gate full, answering 503');
      return reject(res);
    }
    counters.served += 1;
    let released = false;
    const done = () => {
      if (released) return;
      released = true;
      release();
    };
    res.once('finish', done);
    res.once('close', done);
    next();
  }

  gate.stats = () => ({ active, waiting: waiting.length, max, ...counters });
  return gate;
}

/** The gate for GET /api/calls/:callId/logs and /invocation-log. */
export function createCallLogGate(config = callLogGateConfig(), logger) {
  return createConcurrencyGate({ ...config, name: 'call-log', logger });
}
