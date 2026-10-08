// Per-principal limiter on GET /api/calls/:callId/logs and /invocation-log
// (middleware/rate-limit.js). Exercised on a bare express app with a stub
// auth middleware, the same mount shape as index.mjs. No DB needed.
import express from 'express';
import request from 'supertest';
import {
  createCallLogLimiter,
  callLogLimitConfig,
  principalKey,
  CALL_LOG_RATE_LIMIT_DEFAULT,
  CALL_LOG_RATE_WINDOW_MS_DEFAULT,
} from '../middleware/rate-limit.js';

const PATHS = ['/api/calls/:callId/logs', '/api/calls/:callId/invocation-log'];

/** An app that authenticates from an `x-test-user` header, then rate-limits. */
function buildApp({ limit = 3, windowMs = 60_000 } = {}) {
  const app = express();
  app.use((req, res, next) => {
    const id = req.headers['x-test-user'];
    if (id) res.locals.user = { id };
    next();
  });
  app.use(PATHS, createCallLogLimiter({ limit, windowMs }));
  app.get('/api/calls/:callId/logs', (req, res) => res.json({ route: 'logs' }));
  app.get('/api/calls/:callId/invocation-log', (req, res) => res.json({ route: 'invocation-log' }));
  app.get('/api/calls/:callId', (req, res) => res.json({ route: 'call' }));
  return app;
}

const logs = (app, user, callId = 'c1') =>
  request(app).get(`/api/calls/${callId}/logs`).set(user ? { 'x-test-user': user } : {});

describe('call log rate limiter', () => {
  test('allows requests up to the limit and reports the budget in RateLimit headers', async () => {
    const app = buildApp({ limit: 3 });
    for (let i = 0; i < 3; i++) {
      const res = await logs(app, 'alice');
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit']).toMatch(/limit=3/);
      expect(res.headers['ratelimit']).toMatch(new RegExp(`remaining=${2 - i}`));
    }
  });

  test('answers 429 with Retry-After and a JSON message once the limit is exceeded', async () => {
    const app = buildApp({ limit: 2, windowMs: 60_000 });
    await logs(app, 'alice');
    await logs(app, 'alice');
    const res = await logs(app, 'alice');
    expect(res.status).toBe(429);
    const retryAfter = Number(res.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
    expect(res.body).toEqual({ message: expect.stringMatching(/Too many call log requests/) });
  });

  test('keys on the principal, not the call: a different call id draws from the same bucket', async () => {
    const app = buildApp({ limit: 2 });
    expect((await logs(app, 'alice', 'c1')).status).toBe(200);
    expect((await logs(app, 'alice', 'c2')).status).toBe(200);
    expect((await logs(app, 'alice', 'c3')).status).toBe(429);
  });

  test('both call-log paths share one bucket per principal', async () => {
    const app = buildApp({ limit: 2 });
    expect((await logs(app, 'alice')).status).toBe(200);
    const inv = await request(app).get('/api/calls/c1/invocation-log').set('x-test-user', 'alice');
    expect(inv.status).toBe(200);
    expect((await logs(app, 'alice')).status).toBe(429);
    expect((await request(app).get('/api/calls/c1/invocation-log').set('x-test-user', 'alice')).status).toBe(429);
  });

  test('one saturated principal does not affect another', async () => {
    const app = buildApp({ limit: 1 });
    expect((await logs(app, 'alice')).status).toBe(200);
    expect((await logs(app, 'alice')).status).toBe(429);
    expect((await logs(app, 'bob')).status).toBe(200);
  });

  test('other call routes are not limited', async () => {
    const app = buildApp({ limit: 1 });
    expect((await logs(app, 'alice')).status).toBe(200);
    expect((await logs(app, 'alice')).status).toBe(429);
    for (let i = 0; i < 3; i++) {
      const res = await request(app).get('/api/calls/c1').set('x-test-user', 'alice');
      expect(res.status).toBe(200);
      expect(res.headers['ratelimit']).toBeUndefined();
    }
  });

  test('the window resets the budget', async () => {
    const app = buildApp({ limit: 1, windowMs: 50 });
    expect((await logs(app, 'alice')).status).toBe(200);
    expect((await logs(app, 'alice')).status).toBe(429);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await logs(app, 'alice')).status).toBe(200);
  });

  test('CORS preflight is never counted', async () => {
    const app = buildApp({ limit: 1 });
    for (let i = 0; i < 3; i++) {
      const res = await request(app).options('/api/calls/c1/logs').set('x-test-user', 'alice');
      expect(res.status).not.toBe(429);
    }
    expect((await logs(app, 'alice')).status).toBe(200);
  });

  test('a request with no principal falls back to the client IP', async () => {
    const app = buildApp({ limit: 1 });
    const fromIp = (ip) => request(app).get('/api/calls/c1/logs').set('x-forwarded-for', ip);
    expect((await fromIp('203.0.113.9')).status).toBe(200);
    expect((await fromIp('203.0.113.9')).status).toBe(429);
    expect((await fromIp('198.51.100.7')).status).toBe(200);
  });
});

describe('principalKey', () => {
  test('prefers user.id, then user.user_id, then the XFF client IP', () => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' } };
    expect(principalKey(req, { locals: { user: { id: 'u1', user_id: 'legacy' } } })).toBe('principal:u1');
    expect(principalKey(req, { locals: { user: { user_id: 'defaultNotAuthenticated' } } })).toBe('principal:defaultNotAuthenticated');
    expect(principalKey(req, { locals: {} })).toBe('ip:203.0.113.9');
    expect(principalKey(req, undefined)).toBe('ip:203.0.113.9');
  });
});

describe('callLogLimitConfig', () => {
  test('defaults to 60 requests per minute', () => {
    expect(callLogLimitConfig({})).toEqual({
      limit: CALL_LOG_RATE_LIMIT_DEFAULT,
      windowMs: CALL_LOG_RATE_WINDOW_MS_DEFAULT,
    });
    expect(CALL_LOG_RATE_LIMIT_DEFAULT).toBe(60);
    expect(CALL_LOG_RATE_WINDOW_MS_DEFAULT).toBe(60_000);
  });

  test('reads CALL_LOG_RATE_LIMIT and CALL_LOG_RATE_WINDOW_MS', () => {
    expect(callLogLimitConfig({ CALL_LOG_RATE_LIMIT: '120', CALL_LOG_RATE_WINDOW_MS: '30000' }))
      .toEqual({ limit: 120, windowMs: 30_000 });
  });

  test.each([['0'], ['-5'], ['abc'], [''], ['1.5x']])('falls back to the default for %p', (value) => {
    expect(callLogLimitConfig({ CALL_LOG_RATE_LIMIT: value, CALL_LOG_RATE_WINDOW_MS: value }))
      .toEqual({ limit: 60, windowMs: 60_000 });
  });
});
