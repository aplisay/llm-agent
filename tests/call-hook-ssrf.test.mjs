import { assertOutboundUrlAllowed } from '../lib/call-hook.js';

// SSRF guard for outbound webhooks (pure): resolves the host (injected lookup) and
// blocks any non-public address — incl. the DNS-rebinding case (a public hostname
// that resolves to a private IP) and IPv4-mapped IPv6.

const quietLog = { info() {}, error() {}, warn() {}, debug() {}, trace() {}, child() { return quietLog; } };

// Fake resolver: maps host -> [addresses]. Throws for an "unresolvable" host.
const makeLookup = (map) => async (host) => {
  if (!(host in map)) throw new Error('ENOTFOUND');
  return map[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
};

const check = (url, map) => assertOutboundUrlAllowed(url, { log: quietLog, lookup: makeLookup(map) });

describe('assertOutboundUrlAllowed (SSRF guard)', () => {
  it('allows a public address', async () => {
    expect(await check('https://hooks.example.com/x', { 'hooks.example.com': ['93.184.216.34'] })).toBe(true);
  });

  it('blocks loopback / private / link-local / CGN literals', async () => {
    expect(await check('http://127.0.0.1/x', { '127.0.0.1': ['127.0.0.1'] })).toBe(false);
    expect(await check('http://10.1.2.3/x', { '10.1.2.3': ['10.1.2.3'] })).toBe(false);
    expect(await check('http://192.168.0.1/x', { '192.168.0.1': ['192.168.0.1'] })).toBe(false);
    expect(await check('http://172.16.5.5/x', { '172.16.5.5': ['172.16.5.5'] })).toBe(false);
    expect(await check('http://169.254.169.254/latest/meta-data', { '169.254.169.254': ['169.254.169.254'] })).toBe(false);
    expect(await check('http://100.64.0.1/x', { '100.64.0.1': ['100.64.0.1'] })).toBe(false);
  });

  it('blocks IPv6 loopback / unique-local and IPv4-mapped private', async () => {
    expect(await check('http://[::1]/x', { '::1': ['::1'] })).toBe(false);
    expect(await check('http://[fd00::1]/x', { 'fd00::1': ['fd00::1'] })).toBe(false);
    expect(await check('https://mapped.example.com/x', { 'mapped.example.com': ['::ffff:127.0.0.1'] })).toBe(false);
  });

  it('blocks DNS rebinding: a public hostname that resolves to a private IP', async () => {
    expect(await check('https://evil.example.com/x', { 'evil.example.com': ['10.0.0.5'] })).toBe(false);
  });

  it('blocks IPv6 transition addresses (6to4 / NAT64 / Teredo)', async () => {
    expect(await check('https://a.example.com/x', { 'a.example.com': ['2002:7f00:1::1'] })).toBe(false); // 6to4 of 127.0.0.1
    expect(await check('https://b.example.com/x', { 'b.example.com': ['64:ff9b::7f00:1'] })).toBe(false); // NAT64 of 127.0.0.1
    expect(await check('https://c.example.com/x', { 'c.example.com': ['2001::1'] })).toBe(false); // Teredo
  });

  it('blocks if ANY resolved address is non-public', async () => {
    expect(await check('https://multi.example.com/x', { 'multi.example.com': ['93.184.216.34', '10.0.0.5'] })).toBe(false);
  });

  it('fail-closed: unresolvable host, non-http protocol, or bad URL', async () => {
    expect(await check('https://nope.example.com/x', {})).toBe(false); // ENOTFOUND -> false
    expect(await check('ftp://example.com/x', { 'example.com': ['93.184.216.34'] })).toBe(false);
    expect(await check('not a url', {})).toBe(false);
  });
});
