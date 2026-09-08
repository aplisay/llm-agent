import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';
import { testDbConnection, bootstrapDatabase, workerDatabase } from './test-db-config.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const livekitRegistryDist = join(
  repoRoot,
  'agents/livekit/dist/lib/livekit-model-registry.js',
);

/**
 * Open a connection to the bootstrap database, retrying while the container
 * comes up. `docker compose` gates the test runner on a healthcheck, but a
 * local `yarn test:setup` does not, and the first connection used to be a race
 * that a sleep in the runbook papered over.
 */
async function connectToBootstrap({ attempts = 20, delayMs = 500 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const client = new pg.Client({ ...testDbConnection, database: bootstrapDatabase });
    try {
      await client.connect();
      return client;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => {});
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  throw new Error(
    `test Postgres not reachable on ${testDbConnection.host}:${testDbConnection.port} `
    + `after ${attempts} attempts: ${lastError?.message}`,
  );
}

/**
 * One database per jest worker, so the suite can run with maxWorkers > 1.
 *
 * They are dropped and recreated rather than reused. lib/database.js syncs
 * with `alter`, never `force`, so tables and their rows outlive a run: a rerun
 * against the same volume inherits whatever the last one left behind, which
 * has produced failures that disappear on a clean volume.
 */
async function createWorkerDatabases(workers) {
  const client = await connectToBootstrap();
  try {
    for (let workerId = 1; workerId <= workers; workerId++) {
      const name = workerDatabase(String(workerId));
      // FORCE terminates connections a crashed earlier run left behind, which
      // would otherwise make the drop fail. Postgres 13+; both compose files
      // pin postgres:15.
      await client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await client.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await client.end();
  }
}

export default async (globalConfig) => {
  // The livekit registry is only needed by suites that import it. In single-agent
  // container builds (e.g. the jambonz image) the agents/livekit source tree isn't
  // present, so attempting `yarn build` there fails with a bogus spawn ENOENT
  // (non-existent cwd). Only build when the source package is actually checked out.
  const livekitPkg = join(repoRoot, 'agents/livekit/package.json');
  if (!existsSync(livekitRegistryDist) && existsSync(livekitPkg)) {
    execSync('yarn build', {
      cwd: join(repoRoot, 'agents/livekit'),
      stdio: 'inherit',
    });
  }
  dotenv.config();
  // Nuke all the database config because we are using a test database container even in a real environment
  Object.keys(process.env).forEach(key => {
    if (key.startsWith('POSTGRES_')) {
      delete process.env[key];
    }
  });

  // After the env is cleaned, so the connection details come from
  // test-db-config.js and never from a stray .env in the checkout.
  await createWorkerDatabases(globalConfig?.maxWorkers ?? 1);
};

