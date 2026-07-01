import { isSafeCallbackUrl, signBalanceCallback, maybeFireBalanceCallbacks } from '../lib/balance-callback.js';

// Phase-5 balance callbacks (pure): SSRF guard, HMAC signature, and edge-triggered
// firing. Stubs global.fetch (what sendCallHook calls) to capture deliveries.

const quietLog = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child() { return quietLog; } };

// Inject a capturing `send` so the edge-detection logic is tested in isolation,
// without going through sendCallHook's DNS/SSRF layer (which has its own test).
const fire = (org, prev, next, calls) =>
  maybeFireBalanceCallbacks(org, prev, next, { log: quietLog, send: async ({ callHook, payload }) => calls.push({ url: callHook.url, body: payload }) });

const cfg = { callbackUrl: 'https://hooks.example.com/billing', hashKey: 'secret', balanceLowPennies: 100 };
const org = (over = {}) => ({ id: 'org-1', billingConfig: cfg, ...over });

describe('balance-callback', () => {
  it('isSafeCallbackUrl blocks loopback/private/non-http, allows public https', () => {
    expect(isSafeCallbackUrl('https://hooks.example.com/x')).toBe(true);
    expect(isSafeCallbackUrl('http://localhost/x')).toBe(false);
    expect(isSafeCallbackUrl('http://127.0.0.1/x')).toBe(false);
    expect(isSafeCallbackUrl('http://10.0.0.5/x')).toBe(false);
    expect(isSafeCallbackUrl('http://192.168.1.1/x')).toBe(false);
    expect(isSafeCallbackUrl('http://169.254.169.254/latest')).toBe(false);
    expect(isSafeCallbackUrl('ftp://example.com')).toBe(false);
    expect(isSafeCallbackUrl('not a url')).toBe(false);
  });

  it('signBalanceCallback is a deterministic HMAC', () => {
    const a = signBalanceCallback({ hashKey: 'k', organisationId: 'o', event: 'balanceLow', balanceMicros: 5 });
    const b = signBalanceCallback({ hashKey: 'k', organisationId: 'o', event: 'balanceLow', balanceMicros: 5 });
    expect(a).toBe(b);
    expect(a).not.toBe(signBalanceCallback({ hashKey: 'k', organisationId: 'o', event: 'balanceLow', balanceMicros: 6 }));
  });

  it('fires balanceLow only when a settle CROSSES the low threshold', async () => {
    const calls = [];
    await fire(org(), 2_000_000, 500_000, calls); // 200p -> 50p crosses 100p low
    expect(calls).toHaveLength(1);
    expect(calls[0].body.event).toBe('balanceLow');
    expect(calls[0].body.balancePennies).toBe(50);
    expect(calls[0].body.thresholdPennies).toBe(100);
    expect(typeof calls[0].body.hash).toBe('string');

    const calls2 = [];
    await fire(org(), 2_000_000, 1_500_000, calls2); // 200p -> 150p stays above the low
    expect(calls2).toHaveLength(0);
  });

  it('fires balanceNegative when crossing zero', async () => {
    const calls = [];
    await fire(org(), 500_000, -100_000, calls);
    expect(calls.map((c) => c.body.event)).toContain('balanceNegative');
  });

  it('does not fire without config, on an increase, or for an unsafe URL', async () => {
    const a = [];
    await fire({ id: 'o', billingConfig: null }, 2_000_000, 0, a);
    expect(a).toHaveLength(0);

    const b = [];
    await fire(org(), 0, 2_000_000, b); // increase
    expect(b).toHaveLength(0);

    const c = [];
    await fire(org({ billingConfig: { ...cfg, callbackUrl: 'http://127.0.0.1/x' } }), 2_000_000, -1, c);
    expect(c).toHaveLength(0);
  });
});
