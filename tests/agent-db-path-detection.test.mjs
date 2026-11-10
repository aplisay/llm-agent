// middleware/auth.js should treat a request as an agent-db request whenever the router would.
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };
const SHARED = 'agent-db-path-test-token';

describe('agent-db path detection', () => {
  let app;
  let savedToken;

  beforeAll(async () => {
    process.env.BETTER_AUTH_ENABLED = 'false';
    savedToken = process.env.SHARED_API_TOKEN;
    process.env.SHARED_API_TOKEN = SHARED;
    await setupRealDatabase();
    const { default: initAuth } = await import('../middleware/auth.js');
    app = express();
    app.use((req, res, next) => { req.log = log; next(); });
    initAuth(app, log);
    app.get('/api/agent-db/agent', (req, res) => res.json({ principal: res.locals.user?.id }));
  });

  afterAll(async () => {
    if (savedToken === undefined) delete process.env.SHARED_API_TOKEN;
    else process.env.SHARED_API_TOKEN = savedToken;
    await teardownRealDatabase();
  });

  test.each([
    '/api/agent-db/agent',
    '/api/agent-db/agent/',
    '/API/agent-db/agent',
    '/api/Agent-DB/agent',
  ])('%s without the shared token gets the agent-db answer', async (path) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/agent-db is internal only/);
  });

  test('an absolute-form request target gets the agent-db answer', async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const { port } = server.address();
      const status = await new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: `http://127.0.0.1:${port}/api/agent-db/agent` }, (res) => {
          res.resume();
          resolve(res.statusCode);
        }).on('error', reject);
      });
      expect(status).toBe(403);
    } finally {
      server.close();
    }
  });

  test('the shared token reaches the route whatever the letter case', async () => {
    const res = await request(app).get('/API/agent-db/agent').set('x-shared-token', SHARED);
    expect(res.status).toBe(200);
    expect(res.body.principal).toBe('system');
  });

  test('a path that only begins with the same letters is not an agent-db path', async () => {
    const res = await request(app).get('/api/agent-dbx');
    expect(res.body?.message ?? '').not.toMatch(/agent-db is internal only/);
  });
});
