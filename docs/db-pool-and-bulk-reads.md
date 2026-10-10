# Database pool and the bulk call-log reads

The API process has one Sequelize instance (`lib/database.js`) and one
connection pool. Every route draws from that pool: the public API, the
workers' internal `/api/agent-db/*` calls, and the auth middleware's own
lookups. Nothing in Sequelize gives one route priority over another. A
connection is handed out in request order, and a request that cannot get one
waits up to the pool's `acquire` timeout.

That is a problem when a few slow requests hold the pool. The two bulk
call-log reads, `GET /api/calls/{id}/logs` and `GET /api/calls/{id}/invocation-log`,
each scan a log table and (for the invocation log) gunzip every row, so each
holds a connection for far longer than a normal request. With the default pool
of five, five such reads in flight hold every connection. A worker setting up a
call then queues behind them for its phone-endpoint or call lookup, hits its
own HTTP timeout, and the call fails.

## What is in place

Two settings keep agent-db traffic served while the bulk reads are slow.

**Per-process pool size, from the environment** (`lib/db-pool-config.js`).
`POSTGRES_POOL_MAX` (default 5), `POSTGRES_POOL_MIN`, `POSTGRES_POOL_ACQUIRE_MS`
and `POSTGRES_POOL_IDLE_MS` set the Sequelize pool. The defaults match what
Sequelize used before, so nothing changes unless a deployment sets them.

**A bounded concurrency gate on the bulk reads** (`middleware/concurrency-gate.js`).
At most `CALL_LOG_MAX_CONCURRENT` of the two call-log reads run at once per
process. The default is half the pool, and the value is always clamped below
`POSTGRES_POOL_MAX`, so these reads can never hold every connection. A request
over the cap waits up to `CALL_LOG_QUEUE_WAIT_MS` (default 2000) for a slot,
with at most `CALL_LOG_QUEUE_MAX` waiting. When no slot frees up in time, or
the wait list is full, the request is answered `503` with a `Retry-After`
header. The gate is mounted in `index.mjs` after the auth middleware, so a
refused request takes no slot, and before express-openapi, so an over-cap
request never reaches the database.

The gate composes with the per-principal rate limit on the same two paths: the
rate limit bounds how often one client may ask, the gate bounds how much of
the pool all clients together may hold.

Both are per process, like the pool they protect. Under Cloud Run each
instance has its own pool and its own gate.

## Why not simply a bigger pool

Raising `pool.max` was the cheapest option and it is still available through
`POSTGRES_POOL_MAX`, but it does not remove the failure, it only moves the
threshold. Enough slow reads still hold the whole pool. It also has a hard
ceiling. Every API instance and every `jambonz-agent` instance opens up to
`pool.max` connections to the same Cloud SQL instance, and `pg-listen` holds
one more per process. The fleet-wide demand is roughly

    (api instances + jambonz instances) x (pool.max + 1)

and that must stay under the Cloud SQL `max_connections` (set by the instance's
memory band unless a flag overrides it). Check the configured `max-instances`
of each service against that before raising the pool. A larger pool with a
small instance count is fine; a larger pool at the configured maximum scale may
not be.

## Why not a second Sequelize instance for agent-db

A dedicated pool for the internal routes would give them connections no public
read can take. But every model in `lib/database.js` is bound to the one
Sequelize instance, and the agent-db routes use the same models as the public
routes. A second instance means defining every model twice, or passing the
instance through every helper the routes share. It also doubles the per-process
connection demand against the same Cloud SQL ceiling. The gate gives the same
guarantee (the bulk reads can never exhaust the pool) with one small
middleware, so it was chosen instead. The second instance remains the right
next step if a future bulk read cannot be gated this way.

## Tuning

- `CALL_LOG_MAX_CONCURRENT` lower means more headroom for everything else and
  more `503`s for log readers under load. It is clamped to `POSTGRES_POOL_MAX - 1`,
  and the process logs a warning at boot when it clamps.
- `CALL_LOG_QUEUE_WAIT_MS` is the longest a reader waits before a `503`. The
  `Retry-After` header is this value rounded up to whole seconds.
- A client that gets `503` should wait `Retry-After` seconds and retry. The
  response body carries a `message` like the other error responses.
