/**
 * The HTTP side of the provisioning service. It only finds the pieces of a
 * request (address, file, certificate, source) and hands them to handleFetch.
 *
 * Two ways to get the phone's certificate, and exactly one must be set up:
 *  - This process ends TLS itself (PROV_TLS_CERT_FILE, PROV_TLS_KEY_FILE) and
 *    asks the phone for its certificate.
 *  - A proxy ends TLS and passes the certificate in a header
 *    (PROV_CLIENT_CERT_HEADER). The header is read only on a connection from
 *    an address in PROV_TRUSTED_PROXIES. From anywhere else it is ignored.
 * In both, the chain is checked here, against the pinned vendor roots.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { loadTrust, certificateFromHeader, normaliseFingerprint } from './certificate.js';
import { provisioningPublicUrl } from './address.js';

// SHA-256 of the root Snom publishes as ca-256.crt, which signs the certificates of phones with a SHA-2 certificate.
export const SNOM_ROOT_FINGERPRINTS = ['746d74357f0a00ecc615d59514ffbadf7caa06ed8a66f33aaea6a1a151a21d40'];

const RATE_WINDOW_MS = 60 * 1000;
// A phone asks once a day and a few times at boot. This is far above that.
const RATE_MAX = 30;

const list = (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

function proxyList(entries) {
  const blocks = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : isIP(address) === 4 ? 'ipv4' : null;
    if (!family) throw new Error(`PROV_TRUSTED_PROXIES: ${entry} is not an address`);
    if (prefix === undefined) blocks.addAddress(address, family);
    else blocks.addSubnet(address, Number(prefix), family);
  }
  return blocks;
}

/**
 * Read and check the settings. Throws a plain sentence when the service
 * cannot be run safely as configured.
 */
export function provisioningConfig(env = process.env, readFile = (path) => fs.readFileSync(path, 'utf8')) {
  const publicUrl = provisioningPublicUrl(env);
  if (!publicUrl) throw new Error('PROV_PUBLIC_URL must be the https address phones fetch from');
  if (!env.PROV_SNOM_CA_FILE) throw new Error('PROV_SNOM_CA_FILE must name a PEM file of the Snom CA certificates');
  const fingerprints = list(env.PROV_SNOM_CA_FINGERPRINTS).map(normaliseFingerprint);
  const trust = { snom: loadTrust(readFile(env.PROV_SNOM_CA_FILE), fingerprints.length ? fingerprints : SNOM_ROOT_FINGERPRINTS) };

  const direct = Boolean(env.PROV_TLS_CERT_FILE || env.PROV_TLS_KEY_FILE);
  const proxied = Boolean(env.PROV_CLIENT_CERT_HEADER);
  if (direct === proxied) {
    throw new Error('Set either PROV_TLS_CERT_FILE and PROV_TLS_KEY_FILE, or PROV_CLIENT_CERT_HEADER and PROV_TRUSTED_PROXIES, not both');
  }
  const config = { publicUrl, trust, port: Number(env.PROV_PORT) || 4010 };
  if (direct) {
    if (!env.PROV_TLS_CERT_FILE || !env.PROV_TLS_KEY_FILE) throw new Error('PROV_TLS_CERT_FILE and PROV_TLS_KEY_FILE are both needed');
    return { ...config, tls: { cert: readFile(env.PROV_TLS_CERT_FILE), key: readFile(env.PROV_TLS_KEY_FILE) } };
  }
  const proxies = list(env.PROV_TRUSTED_PROXIES);
  if (!proxies.length) throw new Error('PROV_TRUSTED_PROXIES is needed with PROV_CLIENT_CERT_HEADER');
  return { ...config, certificateHeader: String(env.PROV_CLIENT_CERT_HEADER).toLowerCase(), proxies: proxyList(proxies) };
}

const plainAddress = (address) => String(address ?? '').replace(/^::ffff:/, '');

function fromTrustedProxy(config, req) {
  const address = plainAddress(req.socket.remoteAddress);
  const family = isIP(address) === 6 ? 'ipv6' : 'ipv4';
  return isIP(address) !== 0 && config.proxies.check(address, family);
}

/** The phone's certificate, the others it sent, and where the request came from. */
function peerOf(config, req) {
  if (config.tls) {
    const leaf = req.socket.getPeerX509Certificate?.() || null;
    const presented = [];
    for (let next = leaf?.issuerCertificate; next && presented.length < 4 && !presented.includes(next); next = next.issuerCertificate) {
      presented.push(next);
    }
    return { certificate: leaf, presented, sourceIp: plainAddress(req.socket.remoteAddress) };
  }
  if (!fromTrustedProxy(config, req)) return { certificate: null, presented: [], sourceIp: plainAddress(req.socket.remoteAddress) };
  // The proxy adds the address it saw as the last entry.
  const forwarded = list(req.headers['x-forwarded-for']).pop();
  return {
    certificate: certificateFromHeader(req.headers[config.certificateHeader]),
    presented: [],
    sourceIp: forwarded || plainAddress(req.socket.remoteAddress),
  };
}

function rateLimiter(now = () => Date.now()) {
  const seen = new Map();
  return (key) => {
    const at = now();
    const entry = seen.get(key);
    if (!entry || at - entry.start >= RATE_WINDOW_MS) {
      if (seen.size > 10000) seen.clear();
      seen.set(key, { start: at, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= RATE_MAX;
  };
}

/**
 * @param {object} config        from provisioningConfig
 * @param {object} deps
 * @param {Function} deps.handleFetch
 * @param {object} deps.logger
 * @returns {http.Server|https.Server} not yet listening
 */
export function createProvisioningServer(config, { handleFetch, logger }) {
  const allowed = rateLimiter();
  const empty = (res, status) => {
    res.writeHead(status, { 'Cache-Control': 'no-store', 'Content-Length': 0 });
    res.end();
  };
  const onRequest = async (req, res) => {
    try {
      const path = String(req.url || '').split('?')[0];
      if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('ok');
      }
      const peer = peerOf(config, req);
      const parts = path.split('/');
      // /<vendor>/<token>/<file>, nothing else.
      if (req.method !== 'GET' || parts.length !== 4 || parts[0] !== '') return empty(res, 404);
      if (!allowed(peer.sourceIp)) {
        logger.warn({ sourceIp: peer.sourceIp }, 'provisioning: too many requests from one address');
        return empty(res, 404);
      }
      const answer = await handleFetch({
        vendor: parts[1],
        token: parts[2],
        file: parts[3],
        certificate: peer.certificate,
        presented: peer.presented,
        trust: config.trust,
        publicUrl: config.publicUrl,
        sourceIp: peer.sourceIp,
        userAgent: req.headers['user-agent'],
      });
      res.writeHead(answer.status, { ...answer.headers, 'Content-Length': Buffer.byteLength(answer.body, 'utf8') });
      return res.end(answer.body);
    } catch (err) {
      logger.error({ err: err?.message }, 'provisioning: request failed');
      return empty(res, 404);
    }
  };
  if (!config.tls) return http.createServer(onRequest);
  return https.createServer({
    cert: config.tls.cert,
    key: config.tls.key,
    minVersion: 'TLSv1.2',
    // Ask for the phone's certificate and let the handshake finish whatever it is.
    // The chain is checked in handleFetch against the pinned roots, not against Node's CA list.
    requestCert: true,
    rejectUnauthorized: false,
  }, onRequest);
}
