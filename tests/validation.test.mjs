import { validatePhoneRegistration, isPlausibleSipHost, validateSipUri } from '../lib/validation.js';

const base = { username: 'user', password: 'secret' };

describe('validateSipUri (unchanged contract)', () => {
  test('accepts an FQDN', () => {
    expect(validateSipUri('sip:provider.example.com:5060')).toBe(true);
  });
  test('accepts a public IP', () => {
    expect(validateSipUri('203.0.113.10')).toBe(true);
  });
  test('rejects a single-label / non-FQDN host', () => {
    expect(validateSipUri('pbx-internal')).toBe(false);
  });
  test('rejects RFC1918 / localhost', () => {
    expect(validateSipUri('192.168.0.1')).toBe(false);
    expect(validateSipUri('localhost')).toBe(false);
  });
});

describe('isPlausibleSipHost', () => {
  test('accepts non-FQDN hostnames and FQDNs', () => {
    expect(isPlausibleSipHost('pbx-internal')).toBe(true);
    expect(isPlausibleSipHost('sip:pbx_01:5060')).toBe(true);
    expect(isPlausibleSipHost('provider.example.com')).toBe(true);
    expect(isPlausibleSipHost('user@pbx')).toBe(true);
  });
  test('rejects whitespace and XML-breaking characters', () => {
    expect(isPlausibleSipHost('has space')).toBe(false);
    expect(isPlausibleSipHost('evil"/><param')).toBe(false);
    expect(isPlausibleSipHost('')).toBe(false);
    expect(isPlausibleSipHost(null)).toBe(false);
  });
});

describe('validatePhoneRegistration — registrar OR proxy must be a routable FQDN', () => {
  test('FQDN registrar with no proxy is valid (existing behaviour)', () => {
    const r = validatePhoneRegistration({ ...base, registrar: 'provider.example.com:5060' });
    expect(r.isValid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('non-FQDN registrar with no proxy is rejected (existing behaviour)', () => {
    const r = validatePhoneRegistration({ ...base, registrar: 'pbx-internal' });
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /registrar/.test(e))).toBe(true);
  });

  test('non-FQDN registrar is ACCEPTED when a routable proxy is supplied', () => {
    const r = validatePhoneRegistration({
      ...base,
      registrar: 'pbx-internal',
      options: { proxy: 'proxy.provider.example.com:5060' },
    });
    expect(r.isValid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('FQDN registrar with a (redundant) routable proxy is valid', () => {
    const r = validatePhoneRegistration({
      ...base,
      registrar: 'provider.example.com',
      options: { proxy: '203.0.113.10' },
    });
    expect(r.isValid).toBe(true);
  });

  test('rejected when NEITHER registrar nor proxy is routable', () => {
    const r = validatePhoneRegistration({
      ...base,
      registrar: 'pbx-internal',
      options: { proxy: 'also-not-fqdn' },
    });
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /options\.proxy/.test(e))).toBe(true);
  });

  test('rejected when proxy is a private IP (not internet-routable)', () => {
    const r = validatePhoneRegistration({
      ...base,
      registrar: 'pbx-internal',
      options: { proxy: '192.168.1.10' },
    });
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /options\.proxy/.test(e))).toBe(true);
  });

  test('registrar with XML-breaking characters is rejected even with a valid proxy', () => {
    const r = validatePhoneRegistration({
      ...base,
      registrar: 'bad"/><x',
      options: { proxy: 'proxy.example.com' },
    });
    expect(r.isValid).toBe(false);
  });

  test('missing registrar is always rejected', () => {
    const r = validatePhoneRegistration({ ...base, options: { proxy: 'proxy.example.com' } });
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /registrar/.test(e))).toBe(true);
  });
});
