// Bounded concurrency gate on GET /api/calls/:callId/logs and /invocation-log
// (middleware/concurrency-gate.js). Exercised on a bare express app whose
// handlers block until the test releases them, so the number of reads in
// flight is under the test's control. No DB needed.
import express from 'express';
import request from 'supertest';
import {
  createConcurrencyGate,
  createCallLogGate,
  callLogGateConfig,
  CALL_LOG_QUEUE_WAIT_MS_DEFAULT,
} from '../middleware/concurrency-gate.js';
import { poolConfig, POOL_MAX_DEFAULT } from '../lib/db-pool-config.js';

const PATHS = ['/api/calls/:callId/logs', '/api/calls/:callId/invocation-log'];

/**
 * An app whose call-log handlers park until `releaseOne()` is called, so the
 * test decides how many reads are in flight at once.
 */
function buildApp(gateOptions) {
  const app = express();
  const gate = createConcurrencyGate({ name: 'test', ...gateOptions });
  const parked = [];
  const releaseOne = () => parked.shift()?.();
  const releaseAll = () => { while (parked.length) releaseOne(); };
  app.use(PATHS, gate);
  const slow = (route) => (req, res) => {
    parked.push(() => res.json({ route }));
  };
  app.get('/api/calls/:callId/logs', slow('logs'));
  app.get('/api/calls/:callId/invocation-log', slow('invocation-log'));
  app.get('/api/calls/:callId', (req, res) => res.json({ route: 'call' }));
  return { app, gate, parked, releaseOne, releaseAll };
}

// A supertest request only starts when it is awaited, so start it at once:
// the tests below need a read to be in flight before the next one is sent.
const start = (test) => test.then((res) => res);
const get = (app, path) => start(request(app).get(path));
const logs = (app, callId = 'c1') => get(app, `/api/calls/${callId}/logs`);
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

describe('call log concurrency gate', () => {
  test('lets `max` reads through at once and parks the next one', async () => {
    const { app, gate, parked, releaseAll } = buildApp({ max: 2, waitMs: 5_000 });
    const first = logs(app);
    const second = logs(app);
    const third = logs(app);
    await tick();
    expect(parked).toHaveLength(2);
    expect(gate.stats()).toMatchObject({ active: 2, waiting: 1, max: 2 });
    releaseAll();
    await tick();
    expect(parked).toHaveLength(1);
    releaseAll();
    const results = await Promise.all([first, second, third]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(gate.stats()).toMatchObject({ active: 0, waiting: 0, served: 3, rejected: 0 });
  });

  test('answers 503 with Retry-After when no slot frees up within the wait', async () => {
    const { app, gate, releaseAll } = buildApp({ max: 1, waitMs: 50 });
    const held = logs(app);
    await tick();
    const res = await logs(app);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('1');
    expect(res.body).toEqual({ message: expect.stringMatching(/busy with other call log reads/) });
    expect(gate.stats()).toMatchObject({ active: 1, waiting: 0, rejected: 1 });
    releaseAll();
    expect((await held).status).toBe(200);
    expect(gate.stats().active).toBe(0);
  });

  test('a request that waits gets the slot when one frees up in time', async () => {
    const { app, parked, releaseOne } = buildApp({ max: 1, waitMs: 5_000 });
    const held = logs(app);
    await tick();
    const queued = logs(app);
    await tick();
    expect(parked).toHaveLength(1);
    releaseOne();
    expect((await held).status).toBe(200);
    await tick();
    expect(parked).toHaveLength(1);
    releaseOne();
    expect((await queued).status).toBe(200);
  });

  test('a full wait list is refused at once, without waiting', async () => {
    const { app, gate, releaseAll } = buildApp({ max: 1, waitMs: 5_000, maxQueue: 1 });
    const held = logs(app);
    await tick();
    const queued = logs(app);
    await tick();
    expect(gate.stats()).toMatchObject({ active: 1, waiting: 1 });
    const started = Date.now();
    const res = await logs(app);
    expect(res.status).toBe(503);
    expect(Date.now() - started).toBeLessThan(1_000);
    releaseAll();
    expect((await held).status).toBe(200);
    await tick();
    releaseAll();
    expect((await queued).status).toBe(200);
  });

  test('both call-log paths share the gate', async () => {
    const { app, gate, releaseAll } = buildApp({ max: 1, waitMs: 50 });
    const held = get(app, '/api/calls/c1/invocation-log');
    await tick();
    expect((await logs(app)).status).toBe(503);
    expect(gate.stats().active).toBe(1);
    releaseAll();
    expect((await held).status).toBe(200);
  });

  test('the slot is released when the client goes away before the response', async () => {
    const { app, gate } = buildApp({ max: 1, waitMs: 50 });
    const server = app.listen(0);
    try {
      const { port } = server.address();
      const aborter = new AbortController();
      const abandoned = fetch(`http://127.0.0.1:${port}/api/calls/c1/logs`, { signal: aborter.signal })
        .catch(() => 'aborted');
      await tick();
      expect(gate.stats().active).toBe(1);
      aborter.abort();
      expect(await abandoned).toBe('aborted');
      // The socket close reaches the server a moment later.
      for (let i = 0; i < 50 && gate.stats().active > 0; i++) await tick(10);
      expect(gate.stats().active).toBe(0);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test('other call routes and CORS preflight never take a slot', async () => {
    const { app, gate, releaseAll } = buildApp({ max: 1, waitMs: 50 });
    const held = logs(app);
    await tick();
    expect((await request(app).get('/api/calls/c1')).status).toBe(200);
    expect((await request(app).options('/api/calls/c1/logs')).status).not.toBe(503);
    expect(gate.stats()).toMatchObject({ active: 1, waiting: 0 });
    releaseAll();
    expect((await held).status).toBe(200);
  });

  test('a 503 is logged as a warning when a logger is given', async () => {
    const warnings = [];
    const logger = { warn: (...args) => warnings.push(args) };
    const app = express();
    const parked = [];
    app.use(PATHS, createCallLogGate({ max: 1, waitMs: 20, maxQueue: 4, retryAfterSeconds: 1 }, logger));
    app.get('/api/calls/:callId/logs', (req, res) => { parked.push(() => res.json({})); });
    const held = logs(app);
    await tick();
    expect((await logs(app)).status).toBe(503);
    expect(warnings).toHaveLength(1);
    expect(warnings[0][0]).toMatchObject({ gate: 'call-log', max: 1 });
    parked.shift()();
    await held;
  });

  test('refuses a non-positive max', () => {
    expect(() => createConcurrencyGate({ max: 0 })).toThrow(/max/);
    expect(() => createConcurrencyGate({})).toThrow(/max/);
  });
});

describe('callLogGateConfig', () => {
  test('defaults to half the pool, a 2 s wait and a wait list of four per slot', () => {
    expect(callLogGateConfig({})).toEqual({
      max: 2,
      waitMs: CALL_LOG_QUEUE_WAIT_MS_DEFAULT,
      maxQueue: 8,
      retryAfterSeconds: 2,
      poolMax: POOL_MAX_DEFAULT,
      clamped: false,
    });
    expect(CALL_LOG_QUEUE_WAIT_MS_DEFAULT).toBe(2000);
  });

  test('reads the CALL_LOG_* variables and rounds Retry-After up to whole seconds', () => {
    expect(callLogGateConfig({ CALL_LOG_MAX_CONCURRENT: '3', CALL_LOG_QUEUE_WAIT_MS: '2500', CALL_LOG_QUEUE_MAX: '5' }))
      .toMatchObject({ max: 3, waitMs: 2500, maxQueue: 5, retryAfterSeconds: 3, clamped: false });
  });

  test('clamps the cap below the pool size so the gate can never hold the whole pool', () => {
    expect(callLogGateConfig({ CALL_LOG_MAX_CONCURRENT: '5' })).toMatchObject({ max: 4, poolMax: 5, clamped: true });
    expect(callLogGateConfig({ CALL_LOG_MAX_CONCURRENT: '50', POSTGRES_POOL_MAX: '10' })).toMatchObject({ max: 9, poolMax: 10, clamped: true });
    expect(callLogGateConfig({ POSTGRES_POOL_MAX: '10' })).toMatchObject({ max: 5, clamped: false });
  });

  test('keeps one slot on a pool of one', () => {
    expect(callLogGateConfig({ POSTGRES_POOL_MAX: '1' })).toMatchObject({ max: 1, poolMax: 1, clamped: false });
    expect(callLogGateConfig({ POSTGRES_POOL_MAX: '1', CALL_LOG_MAX_CONCURRENT: '3' })).toMatchObject({ max: 1, clamped: true });
  });

  test.each([['0'], ['-5'], ['abc'], [''], ['1.5x']])('falls back to the defaults for %p', (value) => {
    expect(callLogGateConfig({ CALL_LOG_MAX_CONCURRENT: value, CALL_LOG_QUEUE_WAIT_MS: value, CALL_LOG_QUEUE_MAX: value }))
      .toMatchObject({ max: 2, waitMs: 2000, maxQueue: 8 });
  });
});

describe('poolConfig', () => {
  test('matches the Sequelize defaults when nothing is set', () => {
    expect(poolConfig({})).toEqual({ max: 5, min: 0, acquire: 60_000, idle: 10_000 });
  });

  test('reads the POSTGRES_POOL_* variables', () => {
    expect(poolConfig({ POSTGRES_POOL_MAX: '12', POSTGRES_POOL_MIN: '2', POSTGRES_POOL_ACQUIRE_MS: '5000', POSTGRES_POOL_IDLE_MS: '30000' }))
      .toEqual({ max: 12, min: 2, acquire: 5000, idle: 30_000 });
  });

  test('never lets min exceed max', () => {
    expect(poolConfig({ POSTGRES_POOL_MAX: '3', POSTGRES_POOL_MIN: '9' })).toMatchObject({ max: 3, min: 3 });
  });

  test.each([['0'], ['-1'], ['x'], ['']])('falls back to the defaults for %p', (value) => {
    expect(poolConfig({ POSTGRES_POOL_MAX: value, POSTGRES_POOL_ACQUIRE_MS: value, POSTGRES_POOL_IDLE_MS: value }))
      .toEqual({ max: 5, min: 0, acquire: 60_000, idle: 10_000 });
  });
});
