// client-ip-gate (lib/auth/client-ip-gate.js): `x-client-ip` survives ONLY when
// the request carries the matching AUTH_PROXY_SECRET and a single valid IP;
// the secret header itself never survives. No DB needed.
import { createClientIpGate } from '../lib/auth/client-ip-gate.js';

const quietLogger = { info() { }, warn() { }, error() { } };

function run(gate, headers) {
  const req = { headers: { ...headers } };
  let nexted = false;
  gate(req, {}, () => { nexted = true; });
  expect(nexted).toBe(true);
  return req.headers;
}

describe('client-ip gate', () => {
  const SECRET = 'squeamish-ossifrage';
  const gate = createClientIpGate({ secret: SECRET, logger: quietLogger });

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
    const off = createClientIpGate({ secret: undefined, logger: quietLogger });
    const headers = run(off, { 'x-client-ip': '203.0.113.9', 'x-auth-proxy-secret': '' });
    expect(headers['x-client-ip']).toBeUndefined();
  });
});
