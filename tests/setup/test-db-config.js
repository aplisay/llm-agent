// Connection details for the containerised test Postgres.
//
// Kept in one place because two things have to agree on them: global-setup.js,
// which creates one database per jest worker before any worker starts, and
// database-test-wrapper.js, which points lib/database.js at the database its
// own worker owns.

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

// The database a given jest worker owns. JEST_WORKER_ID is 1-based, and is set
// in each worker process (it is absent, so treated as 1, when jest runs a
// single file in band).
export const workerDatabase = (workerId = process.env.JEST_WORKER_ID || '1') =>
  `${bootstrapDatabase}_${workerId}`;
