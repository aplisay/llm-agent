import { catalogueCache, withinMs } from '../lib/voices/catalogue-cache.js';
import Voices from '../lib/voices/index.js';

/**
 * The voice catalogue cache (lib/voices/catalogue-cache.js) and the per-vendor limit in
 * Voices.list. On staging (2026-10-01) a catalogue load that never settled was cached as a
 * pending promise and held every voice list, and every agent save naming that vendor, for ten
 * minutes.
 */

const quiet = { error: () => { }, warn: () => { }, child: () => quiet };
const never = () => new Promise(() => { });
const flush = () => new Promise((resolve) => setImmediate(resolve));

function harness({ ttlMs = 1000, deadlineMs = 50, retryMs = 500 } = {}) {
  let t = 0;
  const loads = [];
  let next = async () => `v${loads.length}`;
  const cache = catalogueCache({
    name: 'test',
    load: () => { loads.push(t); return next(); },
    ttlMs, deadlineMs, retryMs,
    now: () => t,
  });
  return {
    cache, loads,
    get: () => cache.get({ logger: quiet }),
    advance: (ms) => { t += ms; },
    setLoad: (fn) => { next = fn; },
  };
}

describe('catalogueCache', () => {
  test('loads once and serves the catalogue while it is fresh', async () => {
    const h = harness();
    expect(await h.get()).toBe('v1');
    h.advance(999);
    expect(await h.get()).toBe('v1');
    expect(h.loads).toHaveLength(1);
  });

  test('concurrent first requests share one load', async () => {
    const h = harness();
    const results = await Promise.all([h.get(), h.get(), h.get()]);
    expect(results).toEqual(['v1', 'v1', 'v1']);
    expect(h.loads).toHaveLength(1);
  });

  test('a stale catalogue is served at once while one refresh runs behind it', async () => {
    const h = harness();
    await h.get();
    h.advance(1000);
    let release;
    h.setLoad(() => new Promise((resolve) => { release = () => resolve('v2'); }));
    expect(await h.get()).toBe('v1');
    expect(await h.get()).toBe('v1');
    expect(h.loads).toHaveLength(2);
    release();
    await flush();
    expect(await h.get()).toBe('v2');
    expect(h.loads).toHaveLength(2);
  });

  test('a first load that never settles fails at the deadline, and the next request retries', async () => {
    const h = harness({ deadlineMs: 20 });
    h.setLoad(never);
    await expect(h.get()).rejects.toThrow('no answer after 20 ms');
    h.setLoad(async () => 'v2');
    expect(await h.get()).toBe('v2');
    expect(h.loads).toHaveLength(2);
  });

  test('a refresh that never settles keeps the last good catalogue and backs off', async () => {
    const h = harness({ deadlineMs: 20, retryMs: 500 });
    await h.get();
    h.advance(1000);
    h.setLoad(never);
    expect(await h.get()).toBe('v1');
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(await h.get()).toBe('v1');
    expect(h.loads).toHaveLength(2);
    h.advance(500);
    h.setLoad(async () => 'v3');
    expect(await h.get()).toBe('v1');
    await flush();
    expect(await h.get()).toBe('v3');
    expect(h.loads).toHaveLength(3);
  });

  test('a failed refresh keeps the last good catalogue', async () => {
    const h = harness();
    await h.get();
    h.advance(1000);
    h.setLoad(async () => { throw new Error('HTTP 503'); });
    expect(await h.get()).toBe('v1');
    await flush();
    expect(await h.get()).toBe('v1');
  });
});

describe('withinMs', () => {
  test('returns the answer when it comes in time', async () => {
    expect(await withinMs(Promise.resolve('ok'), 50, () => 'late')).toBe('ok');
  });

  test('returns the fallback when it does not', async () => {
    expect(await withinMs(never(), 10, () => 'late')).toBe('late');
  });
});

describe('Voices.list', () => {
  test('a stuck vendor is left out instead of holding up the list', async () => {
    const saved = { services: Voices.services, deadline: Voices.vendorDeadlineMs };
    Voices.vendorDeadlineMs = 20;
    Voices.services = async () => ({
      stuck: { listVoices: never },
      quick: { listVoices: async () => ({ 'en-GB': [{ name: 'a' }] }) },
    });
    try {
      const started = Date.now();
      const tree = await Voices.list();
      expect(Date.now() - started).toBeLessThan(1000);
      expect(tree).toEqual({ stuck: [], quick: { 'en-GB': [{ name: 'a' }] } });
    } finally {
      Voices.services = saved.services;
      Voices.vendorDeadlineMs = saved.deadline;
    }
  });
});
