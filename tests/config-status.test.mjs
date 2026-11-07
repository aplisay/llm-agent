// Configuration status (lib/config-status.js), placeholder handling
// (lib/env-placeholders.js) and the unauthenticated GET /api/health.
import express from 'express';
import request from 'supertest';
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';
import { clearPlaceholders, clearedPlaceholders } from '../lib/env-placeholders.js';
import { RUNTIMES, configStatus, formatStatus } from '../lib/config-status.js';

const log = { info() {}, warn() {}, error() {}, debug() {}, child() { return this; } };

describe('clearPlaceholders', () => {
  test('deletes values written as <...> and keeps the rest', () => {
    const env = {
      OPENAI_API_KEY: '<YOUR OPENAI KEY>',
      JAMBONZ_SERVER: '<JAMBONZ API SERVER HOSTNAME>, usually api.server.name',
      POSTGRES_HOST: 'localhost',
      EMAIL_FROM_NAME: 'A <b> c',
      EMPTY: '',
    };
    expect(clearPlaceholders(env).sort()).toEqual(['JAMBONZ_SERVER', 'OPENAI_API_KEY']);
    expect(env).toEqual({ POSTGRES_HOST: 'localhost', EMAIL_FROM_NAME: 'A <b> c', EMPTY: '' });
    expect(clearedPlaceholders()).toEqual(expect.arrayContaining(['JAMBONZ_SERVER', 'OPENAI_API_KEY']));
  });
});

describe('configuration status', () => {
  let app;

  beforeAll(async () => {
    // CI enables better-auth, whose start-up import lands between tests and fails the suite.
    process.env.BETTER_AUTH_ENABLED = 'false';
    await setupRealDatabase();
    const { default: initAuth } = await import('../middleware/auth.js');
    const { default: healthPath } = await import('../api/paths/health.js');
    app = express();
    app.use((req, res, next) => { req.log = log; next(); });
    initAuth(app, log);
    app.get('/api/health', healthPath().GET);
    app.get('/api/models', (req, res) => res.json({}));
  });

  afterAll(async () => {
    await teardownRealDatabase();
  });

  test('each runtime needs exactly what its handler checks before listing models', async () => {
    const { default: handlers } = await import('../lib/handlers/index.js');
    const { implementations } = await handlers();
    for (const runtime of RUNTIMES) {
      const handler = implementations.find((h) => h.name === runtime.name);
      expect({ runtime: runtime.name, needs: Object.keys(handler?.needKey ?? {}) })
        .toEqual({ runtime: runtime.name, needs: runtime.needs });
    }
  });

  test('names the variables a disabled runtime is missing, and never a value', async () => {
    const secret = 'value-that-must-not-appear-1234';
    const status = await configStatus({ env: { LIVEKIT_URL: 'wss://lk.example', LIVEKIT_API_KEY: secret } });
    const livekit = status.runtimes.find((r) => r.name === 'livekit');
    expect(livekit).toMatchObject({ enabled: false, missing: ['LIVEKIT_API_SECRET'] });
    expect(status.runtimes.find((r) => r.name === 'text')).toMatchObject({ enabled: true, missing: [] });
    expect(status.warnings).toEqual(expect.arrayContaining([expect.stringMatching(/^CREDENTIALS_KEY is unset/)]));
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(formatStatus(status)).toMatch(/livekit\s+disabled\s+missing LIVEKIT_API_SECRET/);
  });

  test('GET /api/health answers without a key; other routes still need one', async () => {
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ status: 'ok', database: { ok: true } });
    expect(health.body.runtimes.map((r) => r.name)).toEqual(RUNTIMES.map((r) => r.name));
    const models = await request(app).get('/api/models');
    expect(models.status).toBe(401);
  });

  test('GET /api/health never returns a configured value', async () => {
    const values = Object.entries(process.env)
      .filter(([name, value]) => /KEY|SECRET|TOKEN|PASSWORD/.test(name) && value && value.length >= 6)
      .map(([, value]) => value);
    const body = JSON.stringify((await request(app).get('/api/health')).body);
    for (const value of values) expect(body.includes(value)).toBe(false);
  });
});
