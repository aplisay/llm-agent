/**
 * Registrar accounts (regserver): the rules that need no database.
 *
 * A registrar-mode registration is an identity the platform issues, so the
 * validation is the mirror image of a line's: the fields a line requires are
 * the ones an account refuses. The minted credentials are what makes one realm
 * per deployment safe, so their shape and uniqueness are pinned here too.
 */
import { validatePhoneRegistration, validateRegistrarAccount } from '../lib/validation.js';
import { mintRegistrarUsername, mintRegistrarPassword, REGISTRAR_USERNAME_RE } from '../lib/utils/credentials.js';
import { registrarRealm, credentialsFor, REGISTRAR_PORT, REGISTRAR_TRANSPORT } from '../lib/registrar-accounts.js';

describe('validatePhoneRegistration in registrar mode', () => {
  test('needs no credentials at all', () => {
    const result = validatePhoneRegistration({ mode: 'registrar' });
    expect(result.isValid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('refuses a supplied registrar, username or password', () => {
    const result = validatePhoneRegistration({
      mode: 'registrar', registrar: 'sip.example.com', username: 'me', password: 'x'
    });
    expect(result.isValid).toBe(false);
    expect(result.errors).toHaveLength(3);
    for (const field of ['registrar', 'username', 'password']) {
      expect(result.errors.some((e) => e.startsWith(`${field} is issued by the platform`))).toBe(true);
    }
  });

  test('accepts kind pbx and nothing else', () => {
    expect(validatePhoneRegistration({ mode: 'registrar', kind: 'pbx' }).isValid).toBe(true);
    const device = validatePhoneRegistration({ mode: 'registrar', kind: 'device' });
    expect(device.isValid).toBe(false);
    expect(device.errors[0]).toMatch(/kind must be 'pbx'/);
  });

  test('refuses b2buaId: ownership follows the socket, not the API', () => {
    const result = validatePhoneRegistration({ mode: 'registrar', b2buaId: '203.0.113.10' });
    expect(result.isValid).toBe(false);
    expect(result.errors[0]).toMatch(/b2buaId is written by the node/);
  });

  test('still checks that options is an object', () => {
    expect(validateRegistrarAccount({ options: 'nope' }).isValid).toBe(false);
    expect(validateRegistrarAccount({ options: { max_bindings: 1 } }).isValid).toBe(true);
  });

  test('an unknown mode is refused before anything else is looked at', () => {
    const result = validatePhoneRegistration({ mode: 'proxy', registrar: 'sip.example.com', username: 'u', password: 'p' });
    expect(result.isValid).toBe(false);
    expect(result.errors).toEqual(["mode must be 'client' or 'registrar'"]);
  });

  test('client mode is unchanged: registrar, username and password are required', () => {
    const missing = validatePhoneRegistration({ mode: 'client' });
    expect(missing.isValid).toBe(false);
    expect(missing.errors.some((e) => e.startsWith('registrar is required'))).toBe(true);
    expect(missing.errors.some((e) => e.startsWith('username is required'))).toBe(true);
    expect(missing.errors.some((e) => e.startsWith('password is required'))).toBe(true);

    const fine = validatePhoneRegistration({ registrar: 'sip.example.com', username: 'u', password: 'p' });
    expect(fine.isValid).toBe(true);
  });
});

describe('minted credentials', () => {
  test('usernames are pbx- plus ten lower-case base32 characters, and do not repeat', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const username = mintRegistrarUsername();
      expect(username).toMatch(REGISTRAR_USERNAME_RE);
      seen.add(username);
    }
    expect(seen.size).toBe(2000);
  });

  test('passwords are 24 letters and digits, and do not repeat', () => {
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const password = mintRegistrarPassword();
      expect(password).toMatch(/^[A-Za-z0-9]{24}$/);
      seen.add(password);
    }
    expect(seen.size).toBe(500);
  });
});

describe('registrarRealm', () => {
  test('is the configured hostname, lower-cased', () => {
    expect(registrarRealm({ REGSERVER_REGISTRAR: 'SIP.polite.ai' })).toBe('sip.polite.ai');
  });

  test('strips a scheme, port or parameter that found its way into the variable', () => {
    expect(registrarRealm({ REGSERVER_REGISTRAR: 'sips:sip.polite.ai:5061;transport=tls' })).toBe('sip.polite.ai');
    expect(registrarRealm({ REGSERVER_REGISTRAR: ' sip.polite.ai/ ' })).toBe('sip.polite.ai');
  });

  test('is null when unset or not a hostname', () => {
    expect(registrarRealm({})).toBeNull();
    expect(registrarRealm({ REGSERVER_REGISTRAR: '' })).toBeNull();
    expect(registrarRealm({ REGSERVER_REGISTRAR: 'not a host' })).toBeNull();
    expect(registrarRealm({ REGSERVER_REGISTRAR: 'localhost' })).toBeNull();
  });
});

describe('credentialsFor', () => {
  test('is what a PBX form needs, with the port and transport fixed', () => {
    const view = credentialsFor({ id: 'r1', registrar: 'sip.polite.ai', username: 'pbx-abcdefghij', password: 'secret' });
    expect(view).toEqual({
      id: 'r1', registrar: 'sip.polite.ai', port: REGISTRAR_PORT, transport: REGISTRAR_TRANSPORT,
      username: 'pbx-abcdefghij', password: 'secret'
    });
    expect(REGISTRAR_PORT).toBe(5061);
    expect(REGISTRAR_TRANSPORT).toBe('tls');
  });

  test('takes an explicit password over the instance getter', () => {
    const view = credentialsFor({ id: 'r1', registrar: 'x', username: 'u', password: 'old' }, 'new');
    expect(view.password).toBe('new');
  });
});
