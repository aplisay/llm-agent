/**
 * The provisioning service loads a renewed TLS certificate by itself: it reads
 * its certificate files again and swaps the certificate in, with no restart.
 * No database. A test CA made with openssl issues every certificate.
 */
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { makeTestCa } from './setup/test-ca.js';
import { certificateReloader, createProvisioningServer, provisioningConfig } from '../lib/provisioning/server.js';

const MAC = '000413A1B2C3';
const CHECK_MS = 20;

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('a renewed certificate', () => {
  let ca;
  let dir;
  let certFile;
  let keyFile;
  let hosts;
  let phone;
  let server;
  let port;
  let log;
  let fetched;
  let reads;

  const put = (cert, key) => {
    fs.writeFileSync(certFile, cert.pem);
    fs.writeFileSync(keyFile, key.key);
  };
  // Node gives a connection's peer certificate on the first read only, so it is kept for a reused connection.
  const seen = new WeakMap();
  // The certificate a new connection is given, or the one an agent's open connection has.
  const served = (options = {}) => new Promise((resolve, reject) => {
    https.get({ host: '127.0.0.1', port, path: '/health', agent: false, rejectUnauthorized: false, ...options }, (res) => {
      if (!seen.has(res.socket)) seen.set(res.socket, res.socket.getPeerX509Certificate().fingerprint256);
      const fingerprint = seen.get(res.socket);
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, fingerprint, reused: res.req.reusedSocket }));
    }).on('error', reject);
  });
  const serving = (host) => until(async () => (await served()).fingerprint === host.certificate.fingerprint256);

  beforeAll(() => {
    ca = makeTestCa('Test Phone');
    hosts = [1, 2, 3, 4].map(() => ca.issue('localhost'));
    phone = ca.issue(MAC);
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-cert-reload-'));
    certFile = path.join(dir, 'tls.crt');
    keyFile = path.join(dir, 'tls.key');
    fs.writeFileSync(path.join(dir, 'ca.pem'), ca.bundlePem);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    ca.remove();
  });

  beforeEach(async () => {
    put(hosts[0], hosts[0]);
    log = { info: [], warn: [] };
    fetched = [];
    reads = 0;
    const config = provisioningConfig({
      PROV_PUBLIC_URL: 'https://prov.example.net',
      PROV_SNOM_CA_FILE: path.join(dir, 'ca.pem'),
      PROV_SNOM_CA_FINGERPRINTS: ca.fingerprint,
      PROV_TLS_CERT_FILE: certFile,
      PROV_TLS_KEY_FILE: keyFile,
    });
    const read = config.tls.read;
    config.tls.read = () => {
      reads += 1;
      return read();
    };
    server = createProvisioningServer(config, {
      handleFetch: async (request) => {
        fetched.push(request.certificate);
        return { status: 200, body: 'file', headers: {} };
      },
      logger: {
        info: (detail, message) => log.info.push({ detail, message }),
        warn: (detail, message) => log.warn.push({ detail, message }),
        error() {},
      },
      certificateCheckMs: CHECK_MS,
    });
    server.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    port = server.address().port;
  });

  afterEach(async () => {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  });

  test('is served to new connections with no restart, and an open connection is not cut', async () => {
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    try {
      const first = await served({ agent });
      expect(first.fingerprint).toBe(hosts[0].certificate.fingerprint256);

      put(hosts[1], hosts[1]);
      await serving(hosts[1]);

      // The connection opened before the renewal still answers, on the certificate it was opened with.
      expect(await served({ agent })).toEqual({ status: 200, fingerprint: hosts[0].certificate.fingerprint256, reused: true });
      expect(log.info).toEqual([{
        detail: { validTo: hosts[1].certificate.validTo, fingerprint: hosts[1].certificate.fingerprint256 },
        message: 'provisioning: loaded a renewed certificate',
      }]);
      expect(log.warn).toEqual([]);
    } finally {
      agent.destroy();
    }
  });

  test('leaves the server still asking each phone for its certificate', async () => {
    put(hosts[1], hosts[1]);
    await serving(hosts[1]);
    const get = (options) => new Promise((resolve, reject) => {
      https.get({ host: '127.0.0.1', port, path: `/snom/${'a'.repeat(26)}/${MAC.toLowerCase()}.xml`, agent: false, rejectUnauthorized: false, ...options }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', reject);
    });
    expect(await get({ cert: phone.pem, key: phone.key })).toBe(200);
    expect(await get({})).toBe(200);
    expect(fetched[0].fingerprint256).toBe(phone.certificate.fingerprint256);
    expect(fetched[1]).toBeNull();
  });

  test('is not loaded while its key is still the old one, and is loaded once the key follows', async () => {
    // The two files are replaced one after the other: a read between the two sees a new certificate and an old key.
    fs.writeFileSync(certFile, hosts[2].pem);
    await until(() => log.warn.length > 0);
    const readsAtWarning = reads;
    await until(() => reads > readsAtWarning + 5);
    expect((await served()).fingerprint).toBe(hosts[0].certificate.fingerprint256);
    // One warning for the one cause, however many checks see it.
    expect(log.warn).toHaveLength(1);
    expect(log.warn[0].message).toMatch(/still serving the old certificate/);
    expect(log.warn[0].detail.reason).toMatch(/^not a certificate and its key/);
    expect(log.info).toEqual([]);

    fs.writeFileSync(keyFile, hosts[2].key);
    await serving(hosts[2]);
    expect(log.info).toHaveLength(1);
    expect(log.warn).toHaveLength(1);
  });

  test('a file that cannot be read, or is not a certificate, keeps the old one in place', async () => {
    fs.rmSync(certFile);
    await until(() => log.warn.length === 1);
    expect(log.warn[0].detail.reason).toMatch(/^could not read/);
    expect((await served()).fingerprint).toBe(hosts[0].certificate.fingerprint256);

    fs.writeFileSync(certFile, 'not a certificate');
    await until(() => log.warn.length === 2);
    expect(log.warn[1].detail.reason).toMatch(/^not a certificate and its key/);
    expect((await served()).fingerprint).toBe(hosts[0].certificate.fingerprint256);

    // The same files as before: nothing to load, and nothing more to say.
    put(hosts[0], hosts[0]);
    const readsNow = reads;
    await until(() => reads > readsNow + 3);
    expect(log.info).toEqual([]);
    expect(log.warn).toHaveLength(2);

    put(hosts[3], hosts[3]);
    await serving(hosts[3]);
  });

  test('the check stops when the server closes', async () => {
    await until(() => reads > 2);
    await new Promise((resolve) => server.close(resolve));
    const readsAtClose = reads;
    await pause(CHECK_MS * 6);
    expect(reads).toBe(readsAtClose);
  });

  test('every context is made with the same TLS options as the first', () => {
    const made = [];
    const tls = { cert: hosts[0].pem, key: hosts[0].key, read: () => ({ cert: hosts[1].pem, key: hosts[1].key }) };
    const reloader = certificateReloader({ setSecureContext: (options) => made.push(options) }, tls, { logger: { info() {}, warn() {} } });
    expect(reloader.check()).toBe(true);
    expect(reloader.check()).toBe(false);
    expect(made).toEqual([{ cert: hosts[1].pem, key: hosts[1].key, minVersion: 'TLSv1.2' }]);
  });

  test('a server made from a certificate and key alone has nothing to read again', async () => {
    const plain = createProvisioningServer(
      { publicUrl: 'https://prov.example.net', trust: {}, tls: { cert: hosts[0].pem, key: hosts[0].key } },
      { handleFetch: async () => ({ status: 404, body: '', headers: {} }), logger: { info() {}, warn() {}, error() {} }, certificateCheckMs: CHECK_MS },
    );
    plain.listen(0, '127.0.0.1');
    await new Promise((resolve) => plain.once('listening', resolve));
    try {
      const before = port;
      port = plain.address().port;
      expect((await served()).fingerprint).toBe(hosts[0].certificate.fingerprint256);
      port = before;
    } finally {
      await new Promise((resolve) => plain.close(resolve));
    }
  });
});
