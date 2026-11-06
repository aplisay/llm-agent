// First-boot bootstrap (lib/bootstrap.js) and the request path it opens through
// the real auth middleware.
//
// Runs in a database of its own: the bootstrap only acts while the users table
// is empty, and the per-worker test database is shared with other suites.
import pg from 'pg';
import express from 'express';
import request from 'supertest';
import { testDbConnection, bootstrapDatabase, workerDatabase } from './setup/test-db-config.js';
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

const database = `${workerDatabase()}_bootstrap`;
const KEY = 'bootstrap-test-key-0123456789abcdefghij';

async function adminQuery(sql) {
  const client = new pg.Client({ ...testDbConnection, database: bootstrapDatabase });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const log = {
  warnings: [],
  info() {}, error() {}, debug() {},
  warn(message) { this.warnings.push(message); },
  child() { return this; },
};

let bootstrap, bootstrapFromEnv, BootstrapError;
let User, Organisation, AuthKey, Agent;
let app;

beforeAll(async () => {
  await adminQuery(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE "${database}"`);
  // The wrapper pointed POSTGRES_DB at the shared worker database on import;
  // lib/database.js has not been loaded yet, so this still takes effect.
  process.env.POSTGRES_DB = database;
  // Keep lib/auth/index.js inert, as on an instance that uses API keys alone.
  // CI enables better-auth, whose start-up import lands between tests and fails the suite.
  process.env.BETTER_AUTH_ENABLED = 'false';
  await setupRealDatabase();

  ({ bootstrap, bootstrapFromEnv, BootstrapError } = await import('../lib/bootstrap.js'));
  ({ User, Organisation, AuthKey, Agent } = await import('../lib/database.js'));
  const { default: initAuth } = await import('../middleware/auth.js');
  const { can } = await import('../lib/auth/permissions.js');

  app = express();
  app.use((req, res, next) => { req.log = log; next(); });
  initAuth(app, log);
  app.get('/api/agents', async (req, res) => {
    const user = res.locals.user;
    const agents = await Agent.findAll({ where: user.sql.where });
    res.json({
      userId: user.id,
      organisationId: user.organisationId,
      canCreateAgent: can(user, 'agent', 'create'),
      canCreateTrunk: can(user, 'trunk', 'create'),
      agents: agents.map((agent) => agent.id),
    });
  });
}, 120000);

afterAll(async () => {
  await teardownRealDatabase();
  await adminQuery(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
});

describe('first-boot bootstrap', () => {
  it('creates nothing and says what to do when no key is requested', async () => {
    const result = await bootstrapFromEnv({ log, env: {} });

    expect(result).toEqual({ created: false, reason: 'not-requested' });
    expect(log.warnings.join(' ')).toMatch(/yarn bootstrap/);
    expect(await User.count()).toBe(0);
  });

  it('refuses a key that is too short', async () => {
    await expect(bootstrap({ key: 'changeme' })).rejects.toThrow(BootstrapError);
    expect(await User.count()).toBe(0);
    expect(await Organisation.count()).toBe(0);
  });

  it('refuses a key the auth middleware would read as a room join token', async () => {
    const instanceToken = btoa('instance:0123456789abcdef0123456789abcdef');
    await expect(bootstrap({ key: instanceToken })).rejects.toThrow(/instance/);
    expect(await User.count()).toBe(0);
  });

  it('creates one operator when two processes bootstrap at once, and holds an early request', async () => {
    // A request made before the key exists leaves a negative cache entry.
    expect(await AuthKey.verify(KEY)).toBe(false);

    // The request is sent while the bootstrap is still running, as a client
    // does when it calls a server that has just started on a new database.
    const [first, second, early] = await Promise.all([
      bootstrapFromEnv({ log, env: { BOOTSTRAP_API_KEY: KEY } }),
      bootstrapFromEnv({ log, env: { BOOTSTRAP_API_KEY: KEY } }),
      request(app).get('/api/agents').set('Authorization', `Bearer ${KEY}`),
    ]);
    const results = [first, second];

    expect(early.status).toBe(200);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(results.find((result) => !result.created)).toEqual({ created: false, reason: 'users-exist' });
    expect(await Organisation.count()).toBe(1);
    expect(await AuthKey.count()).toBe(1);

    const users = await User.findAll();
    expect(users).toHaveLength(1);
    const created = results.find((result) => result.created);
    expect(users[0]).toMatchObject({
      id: created.userId,
      organisationId: created.organisationId,
      role: 'superAdmin',
      status: 'active',
      signupMethod: 'bootstrap',
    });
    expect(created.key).toBe(KEY);
  });

  it('lets the key through the auth middleware as a scoped super admin', async () => {
    const [user] = await User.findAll();
    const agent = await Agent.create({
      name: 'Bootstrap test agent',
      type: 'text',
      modelName: 'text:anthropic/claude-opus-4-8',
      prompt: 'Say hello.',
      userId: user.id,
      organisationId: user.organisationId,
    });

    const response = await request(app).get('/api/agents').set('Authorization', `Bearer ${KEY}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      userId: user.id,
      organisationId: user.organisationId,
      canCreateAgent: true,
      canCreateTrunk: true,
      agents: [agent.id],
    });
  });

  it('rejects a request with no key or the wrong key', async () => {
    const none = await request(app).get('/api/agents');
    expect(none.status).toBe(401);

    const wrong = await request(app).get('/api/agents').set('Authorization', 'Bearer not-the-bootstrap-key-0123456789abcdef');
    expect(wrong.status).toBe(401);
  });

  it('does nothing once a user exists', async () => {
    const again = await bootstrap();
    expect(again).toEqual({ created: false, reason: 'users-exist' });

    // A stale, invalid value left in the environment must not break a later boot.
    await expect(bootstrapFromEnv({ log, env: { BOOTSTRAP_API_KEY: 'changeme' } }))
      .resolves.toEqual({ created: false, reason: 'users-exist' });

    expect(await User.count()).toBe(1);
    expect(await AuthKey.count()).toBe(1);
  });
});
