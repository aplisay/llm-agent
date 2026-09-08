// Connection details for the containerised test Postgres.
//
// Kept in one place because two things have to agree on them: global-setup.js,
// which creates one database per jest worker before any worker starts, and
// database-test-wrapper.js, which points lib/database.js at the database its
// own worker owns.

import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const inContainer = process.env.USE_CONTAINER_NETWORKING === 'true';

export const testDbConnection = {
  host: inContainer ? 'postgres' : 'localhost',
  port: inContainer ? 5432 : 5433,
  user: 'testuser',
  password: 'testpass',
};

// The database the container creates on boot. Nothing runs against it: it is
// only there to give global-setup.js a connection from which to create and
// drop the per-worker databases.
export const bootstrapDatabase = 'llmvoicetest';

/**
 * Per-CHECKOUT tag, so two checkouts sharing this container do not share
 * database names.
 *
 * global-setup.js drops every worker database it is about to create, WITH
 * (FORCE), which terminates whatever is connected to them. With one set of
 * names per machine, a second run starting mid-way through a first one
 * destroys the first one's databases underneath it: the losing side fails at
 * its first query, often with an empty error, sometimes `database
 * "llmvoicetest_N" does not exist`, and lib/database.js's pg-listen error
 * handler then exits the process.
 *
 * That is not theoretical. On 2026-09-08 two sessions ran the suite on this
 * machine at once — six global setups inside 65 seconds — and the resulting
 * failures were indistinguishable from flakes. One was reported as a flake.
 * A red run that is really a collision is worse than a slow one: it teaches
 * people to re-run until green, which is how a real regression gets through.
 *
 * Derived from the checkout path rather than a random value, so a given
 * checkout keeps the same names across runs and its databases are reused
 * rather than accumulating. Worktrees each get their own, which is the point.
 * `TEST_DB_TAG` overrides it where something outside needs to pin the name.
 * Truncated to 8 hex characters: the whole identifier has to stay inside
 * Postgres's 63-byte limit, and collisions between two paths on one laptop are
 * not a real risk.
 */
const checkoutTag = process.env.TEST_DB_TAG
  || createHash('sha1').update(repoRoot).digest('hex').slice(0, 8);

// The database a given jest worker owns. JEST_WORKER_ID is 1-based, and is set
// in each worker process (it is absent, so treated as 1, when jest runs a
// single file in band).
export const workerDatabase = (workerId = process.env.JEST_WORKER_ID || '1') =>
  `${bootstrapDatabase}_${checkoutTag}_${workerId}`;

/** The checkout tag in use, so a failure can say which checkout owns what. */
export const testDbTag = checkoutTag;
