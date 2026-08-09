import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
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

describe('validatePhoneRegistration — registrar OR options.register_proxy must be routable', () => {
  test('FQDN registrar with no register_proxy is valid (existing behaviour)', () => {
    const r = validatePhoneRegistration({ ...base, registrar: 'provider.example.com:5060' });
    expect(r.isValid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('non-FQDN registrar with no register_proxy is rejected (existing behaviour)', () => {
    const r = validatePhoneRegistration({ ...base, registrar: 'pbx-internal' });
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /register_proxy/.test(e))).toBe(true);
  });

  test('non-FQDN registrar is ACCEPTED when a routable register_proxy is supplied', () => {
    const r = validatePhoneRegistration({
      ...base,
      registrar: 'pbx-internal',
      options: { register_proxy: 'proxy.provider.example.com:5060' },
    });
    expect(r.isValid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("the user's payload: registrar 'nathan' + sip: register_proxy is accepted", () => {
    const r = validatePhoneRegistration({
      ...base,
      registrar: 'nathan',
      options: { transport: 'tls', register: true, register_proxy: 'sip:proxy.example.com:5060', realm: '' },
    });
    expect(r.isValid).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test('FQDN registrar with a (redundant) routable register_proxy is valid', () => {
    const r = validatePhoneRegistration({
      ...base,
      registrar: 'provider.example.com',
      options: { register_proxy: '203.0.113.10' },
    });
    expect(r.isValid).toBe(true);
  });

  test('rejected when NEITHER registrar nor register_proxy is routable', () => {
    const r = validatePhoneRegistration({
      ...base,
      registrar: 'pbx-internal',
      options: { register_proxy: 'also-not-fqdn' },
    });
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /register_proxy/.test(e))).toBe(true);
  });

  test('rejected when register_proxy is a private IP (not internet-routable)', () => {
    const r = validatePhoneRegistration({
      ...base,
      registrar: 'pbx-internal',
      options: { register_proxy: '192.168.1.10' },
    });
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /register_proxy/.test(e))).toBe(true);
  });

  test('registrar with XML-breaking characters is rejected even with a valid register_proxy', () => {
    const r = validatePhoneRegistration({
      ...base,
      registrar: 'bad"/><x',
      options: { register_proxy: 'proxy.example.com' },
    });
    expect(r.isValid).toBe(false);
  });

  test('missing registrar is always rejected', () => {
    const r = validatePhoneRegistration({ ...base, options: { register_proxy: 'proxy.example.com' } });
    expect(r.isValid).toBe(false);
    expect(r.errors.some((e) => /registrar/.test(e))).toBe(true);
  });
});

// Regression guard for the OpenAPI request-validation layer.
//
// POST /phone-endpoints bodies are checked against the `Registrar` schema pattern in
// api/api-doc.yaml by express-openapi-validator BEFORE the handler (and thus before
// validatePhoneRegistration) ever runs. That coarse syntactic pattern must stay in lockstep
// with isPlausibleSipHost(). When it drifted — its host character class omitted `_` — a
// legitimate non-FQDN registrar such as "pbx_company:5060" (sent alongside a routable
// options.register_proxy) was rejected at the schema layer, surfacing as a misleading
// `oneOf` error instead of reaching the handler. These tests read the live pattern out of
// the spec so the two layers can't silently diverge again.
const apiDoc = yaml.load(readFileSync(path.resolve(process.cwd(), 'api/api-doc.yaml'), 'utf8'));
const OPENAPI_REGISTRAR_PATTERN = apiDoc?.components?.schemas?.Registrar?.pattern;
const openapiRegistrar = new RegExp(OPENAPI_REGISTRAR_PATTERN);

describe('OpenAPI Registrar pattern (api-doc.yaml request-validation layer)', () => {
  test('the Registrar schema pattern is present in the spec', () => {
    expect(typeof OPENAPI_REGISTRAR_PATTERN).toBe('string');
    expect(OPENAPI_REGISTRAR_PATTERN.length).toBeGreaterThan(0);
  });

  // The exact reported regression: a non-FQDN registrar containing an underscore.
  test('accepts the reported non-FQDN, underscore registrar "pbx_company:5060"', () => {
    expect(openapiRegistrar.test('pbx_company:5060')).toBe(true);
  });

  test('accepts other non-FQDN / underscore / user@ / scheme / FQDN forms', () => {
    for (const v of [
      'abc_company',
      'pbx-internal',
      'sip:pbx_01:5060',
      '4126@pbx_company:5060',
      'provider.example.com:5060',
      '203.0.113.10:5060',
    ]) {
      expect(openapiRegistrar.test(v)).toBe(true);
    }
  });

  test('still rejects whitespace and XML-breaking characters', () => {
    for (const v of ['bad host', 'evil"/><param', 'a<b>', '']) {
      expect(openapiRegistrar.test(v)).toBe(false);
    }
  });

  // Drift guard: the coarse OpenAPI pattern must accept exactly what isPlausibleSipHost accepts.
  // Edit one regex without the other and this fails. (The register_proxy cross-field rule is NOT
  // expressible in an OpenAPI pattern and stays in validatePhoneRegistration; equivalence is only
  // asserted at the syntactic host level. Corpus entries carry no leading/trailing whitespace,
  // because isPlausibleSipHost trims its input and the raw schema pattern does not.)
  test('agrees with isPlausibleSipHost across a representative corpus', () => {
    const corpus = [
      'pbx_company:5060', 'abc_company', 'pbx-internal', 'provider.example.com',
      'provider.example.com:5060', 'sip:pbx_01:5060', 'sips:host.example.org',
      'user@pbx', '4126@pbx_company:5060', '203.0.113.10', '203.0.113.10:5060',
      'bad host', 'has space', 'evil"/><param', 'a<b>', '..x', 'x..y', '', 'tel:+441234',
    ];
    for (const v of corpus) {
      expect(openapiRegistrar.test(v)).toBe(isPlausibleSipHost(v));
    }
  });
});
