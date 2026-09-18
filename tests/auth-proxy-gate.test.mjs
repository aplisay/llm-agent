// auth-proxy-gate (lib/auth/auth-proxy-gate.js), the trust boundary in front of
// /api/auth/*. Two jobs, tested separately below:
//   ATTRIBUTION — `x-client-ip` survives ONLY with the matching AUTH_PROXY_SECRET
//                 and a single valid IP; the secret header itself never survives.
//   REFUSAL     — the BFF-only endpoints (sign-up) 404 for everyone else.
// No DB needed.
import { createAuthProxyGate } from '../lib/auth/auth-proxy-gate.js';

const quietLogger = { info() { }, warn() { }, error() { } };

// A request that is NOT one of the BFF-only paths, so these exercise
// attribution alone. `url` matters now: the gate reads it to decide refusal.
function run(gate, headers, url = '/get-session') {
  const req = { headers: { ...headers }, url };
  let nexted = false;
  gate(req, res(), () => { nexted = true; });
  expect(nexted).toBe(true);
  return req.headers;
}

/** Minimal Express-ish response recorder. */
function res() {
  const out = { code: null, body: null };
  out.status = (c) => { out.code = c; return out; };
  out.json = (b) => { out.body = b; return out; };
  return out;
}

/** Drive one request and report what the gate did with it. */
function attempt(gate, { url, headers = {} }) {
  const req = { headers: { ...headers }, url };
  const response = res();
  let nexted = false;
  gate(req, response, () => { nexted = true; });
  return { nexted, status: response.code, body: response.body, headers: req.headers };
}

describe('auth proxy gate — attribution', () => {
  const SECRET = 'squeamish-ossifrage';
  const gate = createAuthProxyGate({ secret: SECRET, logger: quietLogger });

  it('keeps a valid IP when the secret matches, and strips the secret header', () => {
    const headers = run(gate, {
      'x-client-ip': ' 203.0.113.9 ',
      'x-auth-proxy-secret': SECRET,
      'x-forwarded-for': '10.0.0.1',
    });
    expect(headers['x-client-ip']).toBe('203.0.113.9');
    expect(headers['x-auth-proxy-secret']).toBeUndefined();
    expect(headers['x-forwarded-for']).toBe('10.0.0.1'); // untouched
  });

  it('keeps a valid IPv6 address', () => {
    const headers = run(gate, { 'x-client-ip': '2001:db8::1', 'x-auth-proxy-secret': SECRET });
    expect(headers['x-client-ip']).toBe('2001:db8::1');
  });

  it('strips the IP on a wrong secret', () => {
    const headers = run(gate, { 'x-client-ip': '203.0.113.9', 'x-auth-proxy-secret': 'nope' });
    expect(headers['x-client-ip']).toBeUndefined();
    expect(headers['x-auth-proxy-secret']).toBeUndefined();
  });

  it('strips the IP when no secret is presented', () => {
    const headers = run(gate, { 'x-client-ip': '203.0.113.9' });
    expect(headers['x-client-ip']).toBeUndefined();
  });

  it.each([
    ['not an IP', 'localhost'],
    ['truncated IPv4', '1.2.3'],
    ['a list', '203.0.113.9, 198.51.100.2'],
  ])('strips %s even with the right secret', (_label, value) => {
    const headers = run(gate, { 'x-client-ip': value, 'x-auth-proxy-secret': SECRET });
    expect(headers['x-client-ip']).toBeUndefined();
  });

  it('strips a repeated (array) header', () => {
    const headers = run(gate, {
      'x-client-ip': ['203.0.113.9', '198.51.100.2'],
      'x-auth-proxy-secret': SECRET,
    });
    expect(headers['x-client-ip']).toBeUndefined();
  });

  it('always strips when no secret is configured (feature off)', () => {
    const off = createAuthProxyGate({ secret: undefined, logger: quietLogger });
    const headers = run(off, { 'x-client-ip': '203.0.113.9', 'x-auth-proxy-secret': '' });
    expect(headers['x-client-ip']).toBeUndefined();
  });
});

/**
 * The half that did not exist before 2026-08-28. `/sign-up/email` creates an
 * account and mails whoever the body names; reachable by anyone, outside the
 * send budgets and with no rate-limit rule of its own, that is the same shape
 * as the /waitlist mail relay. Only polite-ai's BFF may reach it now.
 */
describe('auth proxy gate — BFF-only refusal', () => {
  const SECRET = 'squeamish-ossifrage';
  const gate = createAuthProxyGate({ secret: SECRET, logger: quietLogger });
  const SIGNUP = '/sign-up/email';

  it('refuses sign-up without the secret, and does not call through', () => {
    const r = attempt(gate, { url: SIGNUP });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(404);
  });

  it('refuses sign-up on a WRONG secret', () => {
    const r = attempt(gate, { url: SIGNUP, headers: { 'x-auth-proxy-secret': 'nope' } });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(404);
  });

  it('answers 404, not 403 — the endpoint must not advertise itself', () => {
    // 403 would confirm the path exists and invite probing for the secret.
    const r = attempt(gate, { url: SIGNUP });
    expect(r.status).toBe(404);
    expect(JSON.stringify(r.body)).not.toMatch(/forbidden|secret|proxy/i);
  });

  it('lets the BFF through with the right secret', () => {
    const r = attempt(gate, { url: SIGNUP, headers: { 'x-auth-proxy-secret': SECRET } });
    expect(r.nexted).toBe(true);
    expect(r.status).toBe(null);
  });

  it('ignores the query string when matching', () => {
    const r = attempt(gate, { url: `${SIGNUP}?callbackURL=https://polite.ai/x` });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(404);
  });

  it('matches whether or not the mount prefix was stripped', () => {
    const r = attempt(gate, { url: `/api/auth${SIGNUP}` });
    expect(r.nexted).toBe(false);
    expect(r.status).toBe(404);
  });

  it('leaves every OTHER auth endpoint public', () => {
    // Sign-in, reset and verification are public by design; those are guarded by
    // the send budgets in lib/auth/index.js, not by this gate. Refusing them here
    // would lock every existing user out.
    const urls = [
      '/sign-in/email',
      '/request-password-reset',
      '/send-verification-email',
      '/get-session',
      '/sign-out',
    ];
    // Compared as a map so a failure names the path that broke, rather than
    // just reporting `false !== true` from somewhere inside the loop.
    const admitted = Object.fromEntries(
      urls.map((url) => [url, attempt(gate, { url }).nexted]),
    );
    expect(admitted).toEqual(Object.fromEntries(urls.map((url) => [url, true])));
  });

  it('does not match a sign-IN path that merely starts the same way', () => {
    // Guards the exact-match choice: a prefix rule would take this with it.
    const r = attempt(gate, { url: '/sign-up/email-verify' });
    expect(r.nexted).toBe(true);
  });

  it('fails CLOSED with no secret configured — signup refused, not opened', () => {
    // An unconfigured deploy loses invite completion (loud, fixable). The other
    // way round silently reopens a public mail relay.
    const off = createAuthProxyGate({ secret: undefined, logger: quietLogger });
    expect(attempt(off, { url: SIGNUP }).status).toBe(404);
    expect(attempt(off, { url: SIGNUP, headers: { 'x-auth-proxy-secret': 'anything' } }).status).toBe(404);
    // …and unrelated endpoints keep working.
    expect(attempt(off, { url: '/sign-in/email' }).nexted).toBe(true);
  });

  it('still strips the secret header on the path it admits', () => {
    const r = attempt(gate, { url: SIGNUP, headers: { 'x-auth-proxy-secret': SECRET } });
    expect(r.headers['x-auth-proxy-secret']).toBeUndefined();
  });
});
