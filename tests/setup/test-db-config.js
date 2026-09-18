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
 * Derive stable database names per checkout so another worktree's setup cannot drop an active suite's databases.
 * TEST_DB_TAG overrides the path-derived tag; see PR #302.
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
