/**
 * The parts of desk phone provisioning that need no database: the certificate
 * check, the Snom settings file and the service's settings.
 */
import fs from 'node:fs';
import { makeTestCa } from './setup/test-ca.js';
import {
  loadTrust, verifyDeviceCertificate, macOfCertificate, certificateFromHeader, parsePemBundle, normaliseFingerprint,
} from '../lib/provisioning/certificate.js';
import { renderSnomSettings, parseSnomUserAgent } from '../lib/provisioning/snom.js';
import { mintToken, hashToken, TOKEN_RE } from '../lib/provisioning/token.js';
import { provisioningConfig, SNOM_ROOT_FINGERPRINTS } from '../lib/provisioning/server.js';
import { deviceAdminPassword, provisioningPublicUrl } from '../lib/provisioning/address.js';

const MAC = '000413a1b2c3';

describe('the phone certificate check', () => {
  let ca;
  let other;
  let trust;
  let phone;

  beforeAll(() => {
    ca = makeTestCa('Test Phone');
    other = makeTestCa('Another Maker');
    trust = loadTrust(ca.bundlePem, [ca.fingerprint]);
    phone = ca.issue(MAC.toUpperCase());
  });
  afterAll(() => {
    ca.remove();
    other.remove();
  });

  test('a certificate under the pinned root is accepted, and its MAC is read from the common name', () => {
    const checked = verifyDeviceCertificate(phone.certificate, trust);
    expect(checked).toMatchObject({ ok: true, mac: MAC });
    expect(checked.fingerprint).toBe(normaliseFingerprint(phone.certificate.fingerprint256));
    expect(checked.serial).toBe(phone.certificate.serialNumber);
    expect(macOfCertificate(ca.issue('00:04:13:A1:B2:C3').certificate)).toBe(MAC);
  });

  test('the intermediate may come from the phone when the bundle has only the root', () => {
    const rootOnly = loadTrust(ca.rootPem, [ca.fingerprint]);
    expect(verifyDeviceCertificate(phone.certificate, rootOnly).ok).toBe(false);
    expect(verifyDeviceCertificate(phone.certificate, rootOnly, { presented: [ca.intermediate] }).ok).toBe(true);
  });

  test('a certificate under another CA is refused, whatever MAC it names', () => {
    const forged = other.issue(MAC.toUpperCase());
    expect(verifyDeviceCertificate(forged.certificate, trust)).toEqual({ ok: false, reason: 'certificate_untrusted' });
    // The other maker's intermediate does not help it.
    expect(verifyDeviceCertificate(forged.certificate, trust, { presented: [other.intermediate, other.root] }).ok).toBe(false);
  });

  test('a root in the bundle that is not pinned is not trusted', () => {
    const both = `${ca.bundlePem}\n${other.bundlePem}`;
    const pinnedOne = loadTrust(both, [ca.fingerprint]);
    expect(pinnedOne.roots).toHaveLength(1);
    expect(verifyDeviceCertificate(other.issue(MAC).certificate, pinnedOne).ok).toBe(false);
    expect(() => loadTrust(other.bundlePem, [ca.fingerprint])).toThrow(/no root with a pinned fingerprint/);
    expect(() => loadTrust(ca.bundlePem, [])).toThrow(/no pinned root/);
  });

  test('a certificate outside its dates is refused', () => {
    const late = new Date(Date.now() + 11 * 365 * 24 * 3600 * 1000);
    expect(verifyDeviceCertificate(phone.certificate, trust, { now: late })).toEqual({ ok: false, reason: 'certificate_expired' });
    expect(verifyDeviceCertificate(phone.certificate, trust, { now: new Date('2000-01-01') }).reason).toBe('certificate_expired');
  });

  test('a certificate whose common name is not a MAC is refused, and so is a CA certificate', () => {
    expect(verifyDeviceCertificate(ca.issue('reception-phone').certificate, trust)).toEqual({ ok: false, reason: 'certificate_no_mac' });
    expect(verifyDeviceCertificate(ca.intermediate, trust)).toEqual({ ok: false, reason: 'certificate_untrusted' });
  });

  test('a certificate passed in a header is read URL-encoded or plain, and junk is no certificate', () => {
    expect(certificateFromHeader(encodeURIComponent(phone.pem)).fingerprint256).toBe(phone.certificate.fingerprint256);
    expect(certificateFromHeader(phone.pem).fingerprint256).toBe(phone.certificate.fingerprint256);
    expect(certificateFromHeader('not a certificate')).toBeNull();
    expect(certificateFromHeader(undefined)).toBeNull();
    expect(parsePemBundle('')).toEqual([]);
  });

  describe('the service settings', () => {
    const files = () => ({ '/ca.pem': ca.bundlePem, '/tls.crt': 'CERT', '/tls.key': 'KEY' });
    const read = (path) => {
      if (!(path in files())) throw new Error(`no file ${path}`);
      return files()[path];
    };
    const base = () => ({ PROV_PUBLIC_URL: 'https://prov.example.net', PROV_SNOM_CA_FILE: '/ca.pem', PROV_SNOM_CA_FINGERPRINTS: ca.fingerprint });

    test('one way of getting the certificate must be set, and only one', () => {
      expect(() => provisioningConfig(base(), read)).toThrow(/either/i);
      expect(() => provisioningConfig({
        ...base(), PROV_TLS_CERT_FILE: '/tls.crt', PROV_TLS_KEY_FILE: '/tls.key', PROV_CLIENT_CERT_HEADER: 'ssl-client-cert', PROV_TRUSTED_PROXIES: '10.0.0.1',
      }, read)).toThrow(/not both/);
      expect(() => provisioningConfig({ ...base(), PROV_CLIENT_CERT_HEADER: 'ssl-client-cert' }, read)).toThrow(/PROV_TRUSTED_PROXIES/);
      expect(() => provisioningConfig({ ...base(), PROV_TLS_CERT_FILE: '/tls.crt' }, read)).toThrow(/both needed/);
      const direct = provisioningConfig({ ...base(), PROV_TLS_CERT_FILE: '/tls.crt', PROV_TLS_KEY_FILE: '/tls.key' }, read);
      expect(direct).toMatchObject({ publicUrl: 'https://prov.example.net', port: 4010, tls: { cert: 'CERT', key: 'KEY' } });
      const proxied = provisioningConfig({ ...base(), PROV_CLIENT_CERT_HEADER: 'SSL-Client-Cert', PROV_TRUSTED_PROXIES: '10.0.0.0/8, 192.168.1.5' }, read);
      expect(proxied.certificateHeader).toBe('ssl-client-cert');
      expect(proxied.proxies.check('10.20.30.40')).toBe(true);
      expect(proxied.proxies.check('192.168.1.6')).toBe(false);
    });

    test('it will not start without an https address, a CA file and a pinned root in it', () => {
      const tls = { PROV_TLS_CERT_FILE: '/tls.crt', PROV_TLS_KEY_FILE: '/tls.key' };
      expect(() => provisioningConfig({ ...base(), ...tls, PROV_PUBLIC_URL: 'http://prov.example.net' }, read)).toThrow(/https/);
      expect(() => provisioningConfig({ ...base(), ...tls, PROV_SNOM_CA_FILE: '' }, read)).toThrow(/PROV_SNOM_CA_FILE/);
      // With no fingerprints set the pin is Snom's own root, which the test CA is not.
      expect(() => provisioningConfig({ ...base(), ...tls, PROV_SNOM_CA_FINGERPRINTS: '' }, read)).toThrow(/pinned fingerprint/);
      expect(SNOM_ROOT_FINGERPRINTS.every((value) => /^[0-9a-f]{64}$/.test(value))).toBe(true);
      expect(provisioningPublicUrl({ PROV_PUBLIC_URL: 'https://prov.example.net/' })).toBe('https://prov.example.net');
      expect(provisioningPublicUrl({})).toBeNull();
    });
  });
});

describe('the Snom settings file', () => {
  const ha1 = (n) => String(n).repeat(32);
  const profile = {
    settingServer: 'https://prov.example.net/snom/abcdefghijklmnopqrstuvwxyz/{mac}.xml',
    identities: 6,
    family: 'd7',
    adminPassword: 'phone-admin-secret',
    lines: [
      { key: 2, label: 'Sales', username: 'lbbbbbbbbbbbbbbb', ha1: ha1(2), registrar: 'sip.example.net', port: 5061 },
      { key: 1, label: 'Ada B. 100', username: 'laaaaaaaaaaaaaaa', ha1: ha1(1), registrar: 'sip.example.net', port: 5061 },
      { key: 3, label: 'Other', username: 'lccccccccccccccc', ha1: ha1(3), registrar: 'sip.example.net', port: 5061 },
    ],
  };

  test('matches the golden file', () => {
    const golden = new URL('./fixtures/provisioning/snom-d717-three-lines.xml', import.meta.url);
    const rendered = renderSnomSettings(profile);
    if (process.env.UPDATE_GOLDEN) fs.writeFileSync(golden, rendered);
    expect(rendered).toBe(fs.readFileSync(golden, 'utf8'));
  });

  test('has one identity for each line, in key order, with the hash and no password', () => {
    const xml = renderSnomSettings(profile);
    const values = (name) => [...xml.matchAll(new RegExp(`<${name} idx="(\\d+)" perm="R">([^<]*)</${name}>`, 'g'))].map((m) => [Number(m[1]), m[2]]);
    expect(values('user_name').slice(0, 3)).toEqual([[1, 'laaaaaaaaaaaaaaa'], [2, 'lbbbbbbbbbbbbbbb'], [3, 'lccccccccccccccc']]);
    expect(values('user_hash').slice(0, 3)).toEqual([[1, ha1(1)], [2, ha1(2)], [3, ha1(3)]]);
    // user_pass is there and empty for every identity.
    expect(values('user_pass')).toHaveLength(6);
    expect(values('user_pass').every(([, value]) => value === '')).toBe(true);
    expect(values('user_active')).toEqual([[1, 'on'], [2, 'on'], [3, 'on'], [4, 'off'], [5, 'off'], [6, 'off']]);
    expect(values('user_srtp').every(([, value]) => value === 'on')).toBe(true);
    expect(values('user_savp').every(([, value]) => value === 'mandatory')).toBe(true);
    expect(values('user_outbound')[0]).toEqual([1, 'sip.example.net:5061;transport=tls']);
    expect([...xml.matchAll(/<fkey idx="(\d+)" context="(\d+)" label="([^"]*)" perm="R">line<\/fkey>/g)].map((m) => m.slice(1)))
      .toEqual([['0', '1', 'Ada B. 100'], ['1', '2', 'Sales'], ['2', '3', 'Other']]);
    expect(xml).toContain('<setting_server perm="R">https://prov.example.net/snom/abcdefghijklmnopqrstuvwxyz/{mac}.xml</setting_server>');
    expect(xml).toContain('<challenge_checksync perm="R">on</challenge_checksync>');
  });

  test('labels are escaped, and a D8xx phone gets its own web login names', () => {
    const xml = renderSnomSettings({ ...profile, family: 'd8', lines: [{ ...profile.lines[0], key: 1, label: 'R&D <"lab">' }] });
    expect(xml).toContain('label="R&amp;D &lt;&quot;lab&quot;&gt;"');
    expect(xml).toContain('<user_realname idx="1" perm="R">R&amp;D &lt;&quot;lab&quot;&gt;</user_realname>');
    expect(xml).toContain('<webserver_admin_password perm="R">phone-admin-secret</webserver_admin_password>');
    expect(xml).not.toContain('http_pass');
  });

  test('the model and firmware are read from the User-Agent', () => {
    expect(parseSnomUserAgent('Mozilla/4.0 (compatible; snomD785-SIP 10.1.184.14 2010.12-00004-g5ae8e3e)')).toEqual({ model: 'D785', firmware: '10.1.184.14' });
    expect(parseSnomUserAgent('snom710-SIP 8.9.3.80')).toEqual({ model: '710', firmware: '8.9.3.80' });
    expect(parseSnomUserAgent('curl/8.0')).toBeNull();
    expect(parseSnomUserAgent(undefined)).toBeNull();
  });
});

describe('addresses and the phone admin password', () => {
  test('a token is 26 base32 characters and only its hash is kept', () => {
    const token = mintToken();
    expect(token).toMatch(TOKEN_RE);
    expect(mintToken()).not.toBe(token);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });

  test('the admin password is the same at every fetch when a key is set, and differs by phone', () => {
    const env = { CREDENTIALS_KEY: 'k' };
    expect(deviceAdminPassword('device-1', env)).toBe(deviceAdminPassword('device-1', env));
    expect(deviceAdminPassword('device-1', env)).not.toBe(deviceAdminPassword('device-2', env));
    expect(deviceAdminPassword('device-1', env)).toHaveLength(20);
    expect(deviceAdminPassword('device-1', {})).not.toBe(deviceAdminPassword('device-1', {}));
  });
});
