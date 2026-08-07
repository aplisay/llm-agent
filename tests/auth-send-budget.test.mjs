// Email send-budget counters (lib/auth/send-budget.js): per-address hour/day
// caps + global hourly breaker, fixed windows anchored at first request,
// fail-OPEN on storage errors. Uses the test Postgres directly (same container
// the wrapper points every suite at) — the helper owns its own table.
import './setup/database-test-wrapper.js'; // sets POSTGRES_* to the test container
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createSendBudget } from '../lib/auth/send-budget.js';

const quietLogger = { info() { }, warn() { }, debug() { }, trace() { }, error() { } };

let pool;

const addr = () => `${randomUUID()}@example.com`;
const budget = (caps) => createSendBudget({
  pool,
  logger: quietLogger,
  caps: { addressHourly: 3, addressDaily: 10, globalHourly: 10_000, ...caps },
});

beforeAll(async () => {
  pool = new pg.Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  });
  await pool.query('SELECT 1'); // fail fast if the test DB is down
});

afterAll(async () => {
  await pool?.end();
});

describe('send-budget per-address hourly cap', () => {
  it('allows up to the cap then denies with scope address-hour', async () => {
    const b = budget({});
    const email = addr();
    for (let i = 0; i < 3; i++) {
      expect(await b.consume({ kind: 'reset', email })).toEqual({ allowed: true });
    }
    expect(await b.consume({ kind: 'reset', email }))
      .toEqual({ allowed: false, scope: 'address-hour' });
  });

  it('normalises case and whitespace into one bucket', async () => {
    const b = budget({ addressHourly: 1 });
    const email = addr();
    expect((await b.consume({ kind: 'reset', email })).allowed).toBe(true);
    const shouted = ` ${email.toUpperCase()} `;
    expect(await b.consume({ kind: 'reset', email: shouted }))
      .toEqual({ allowed: false, scope: 'address-hour' });
  });

  it('keeps kinds in separate buckets', async () => {
    const b = budget({ addressHourly: 1 });
    const email = addr();
    expect((await b.consume({ kind: 'reset', email })).allowed).toBe(true);
    expect((await b.consume({ kind: 'verify', email })).allowed).toBe(true);
    expect((await b.consume({ kind: 'reset', email })).allowed).toBe(false);
  });

  it('reopens after the window expires (window does not slide on rejection)', async () => {
    const b = budget({ addressHourly: 1 });
    const email = addr();
    expect((await b.consume({ kind: 'reset', email })).allowed).toBe(true);
    expect((await b.consume({ kind: 'reset', email })).allowed).toBe(false);
    // Age the hour bucket past its window; the day bucket stays fresh.
    await pool.query(
      'UPDATE auth_send_limits SET window_start = window_start - $1 WHERE key = $2',
      [61 * 60 * 1000, `h:reset:${email}`],
    );
    expect((await b.consume({ kind: 'reset', email })).allowed).toBe(true);
  });
});

describe('send-budget per-address daily cap', () => {
  it('denies with scope address-day once the day budget is spent', async () => {
    const b = budget({ addressHourly: 100, addressDaily: 2 });
    const email = addr();
    expect((await b.consume({ kind: 'verify', email })).allowed).toBe(true);
    expect((await b.consume({ kind: 'verify', email })).allowed).toBe(true);
    expect(await b.consume({ kind: 'verify', email }))
      .toEqual({ allowed: false, scope: 'address-day' });
  });
});

describe('send-budget global breaker', () => {
  it('denies with scope global-hour across distinct addresses', async () => {
    // The global counter is a single shared key, so start from its live value.
    const probe = budget({});
    await probe.consume({ kind: 'reset', email: addr() });
    const { rows } = await pool.query(
      "SELECT count FROM auth_send_limits WHERE key = 'g:sends'",
    );
    const b = budget({ globalHourly: rows[0].count + 1 });
    expect((await b.consume({ kind: 'reset', email: addr() })).allowed).toBe(true);
    expect(await b.consume({ kind: 'reset', email: addr() }))
      .toEqual({ allowed: false, scope: 'global-hour' });
  });

  it('address-scope denials do not spend the global budget', async () => {
    const before = await pool.query(
      "SELECT count FROM auth_send_limits WHERE key = 'g:sends'",
    );
    const b = budget({ addressHourly: 1 });
    const email = addr();
    await b.consume({ kind: 'reset', email });
    await b.consume({ kind: 'reset', email }); // denied at address-hour
    const after = await pool.query(
      "SELECT count FROM auth_send_limits WHERE key = 'g:sends'",
    );
    expect(after.rows[0].count).toBe(before.rows[0].count + 1);
  });
});

describe('send-budget failure mode', () => {
  it('fails OPEN when storage errors', async () => {
    const errors = [];
    const b = createSendBudget({
      pool: { query: async () => { throw new Error('pg down'); } },
      logger: { ...quietLogger, error: (...args) => errors.push(args) },
      caps: { addressHourly: 1, addressDaily: 1, globalHourly: 1 },
    });
    expect(await b.consume({ kind: 'reset', email: addr() }))
      .toEqual({ allowed: true, degraded: true });
    expect(errors.length).toBe(1);
  });
});
