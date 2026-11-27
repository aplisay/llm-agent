/**
 * The HTTP side of the provisioning service. It only finds the pieces of a
 * request (address, file, certificate, source) and hands them to handleFetch.
 *
 * Two ways to get the phone's certificate, and exactly one must be set up:
 *  - This process ends TLS itself (PROV_TLS_CERT_FILE, PROV_TLS_KEY_FILE) and
 *    asks the phone for its certificate. It reads the two files again once a
 *    minute, so a renewed certificate is served with no restart.
 *  - A proxy ends TLS and passes the certificate in a header
 *    (PROV_CLIENT_CERT_HEADER). The header is read only on a connection from
 *    an address in PROV_TRUSTED_PROXIES. From anywhere else it is ignored.
 * In both, the chain is checked here, against the pinned vendor roots.
 */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import { BlockList, isIP } from 'node:net';
import { createSecureContext } from 'node:tls';
import { loadTrust, certificateFromHeader, normaliseFingerprint } from './certificate.js';
import { provisioningPublicUrl } from './address.js';

// SHA-256 of the root Snom publishes as ca-256.crt, which signs the certificates of phones with a SHA-2 certificate.
export const SNOM_ROOT_FINGERPRINTS = ['746d74357f0a00ecc615d59514ffbadf7caa06ed8a66f33aaea6a1a151a21d40'];

const RATE_WINDOW_MS = 60 * 1000;
// Refused requests from one address in a minute before it is shut out for the rest of that minute.
// Served requests never count, so an office of phones behind one address is not held back.
const RATE_MAX = 30;
const RATE_ADDRESSES = 10000;
// How often the certificate files are read again.
const CERTIFICATE_CHECK_MS = 60 * 1000;

const list = (value) => String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);

function proxyList(entries) {
  const blocks = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split('/');
    const family = isIP(address) === 6 ? 'ipv6' : isIP(address) === 4 ? 'ipv4' : null;
    if (!family) throw new Error(`PROV_TRUSTED_PROXIES: ${entry} is not an address`);
    if (prefix === undefined) {
      blocks.addAddress(address, family);
    } else {
      // An empty or odd prefix would read as /0 and trust every address.
      if (!/^\d{1,3}$/.test(prefix) || Number(prefix) > (family === 'ipv6' ? 128 : 32)) {
        throw new Error(`PROV_TRUSTED_PROXIES: ${entry} has a bad prefix length`);
      }
      blocks.addSubnet(address, Number(prefix), family);
    }
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
    const read = () => ({ cert: readFile(env.PROV_TLS_CERT_FILE), key: readFile(env.PROV_TLS_KEY_FILE) });
    return { ...config, tls: { ...read(), read } };
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

const tlsPeers = new WeakMap();

/** The phone's certificate, the others it sent, and where the request came from. */
function peerOf(config, req) {
  if (config.tls) {
    // Node gives the issuer chain only on the first read for a connection, so it is kept for the next requests on it.
    if (!tlsPeers.has(req.socket)) {
      const leaf = req.socket.getPeerX509Certificate?.() || null;
      const presented = [];
      for (let next = leaf?.issuerCertificate; next && presented.length < 4 && !presented.includes(next); next = next.issuerCertificate) {
        presented.push(next);
      }
      tlsPeers.set(req.socket, { certificate: leaf, presented });
    }
    return { ...tlsPeers.get(req.socket), sourceIp: plainAddress(req.socket.remoteAddress) };
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

/**
 * Counts refused requests for each source address in one-minute windows.
 * `blocked` says whether an address is over the limit, and `first` is true
 * the first time it is asked in that window.
 */
export function refusalLimiter({ now = () => Date.now(), max = RATE_MAX, addresses = RATE_ADDRESSES } = {}) {
  const seen = new Map();
  const live = (key) => {
    const entry = seen.get(key);
    if (entry && now() - entry.start >= RATE_WINDOW_MS) {
      seen.delete(key);
      return null;
    }
    return entry || null;
  };
  return {
    hit(key) {
      const entry = live(key);
      if (entry) {
        entry.count += 1;
        return;
      }
      if (seen.size >= addresses) {
        // Drop windows that have ended, then the oldest. Never the whole table.
        for (const [other, value] of seen) if (now() - value.start >= RATE_WINDOW_MS) seen.delete(other);
        for (const other of seen.keys()) {
          if (seen.size < addresses) break;
          seen.delete(other);
        }
      }
      seen.set(key, { start: now(), count: 1, told: false });
    },
    blocked(key) {
      const entry = live(key);
      if (!entry || entry.count < max) return { blocked: false };
      const first = !entry.told;
      entry.told = true;
      return { blocked: true, first };
    },
  };
}

// setSecureContext() drops every option it is not given, so both the first
// context and each later one are made from this.
const secureContextOptions = ({ cert, key }) => ({ cert, key, minVersion: 'TLSv1.2' });

/**
 * Loads a renewed certificate into a running TLS server.
 *
 * @param {https.Server} server
 * @param {{ cert: string, key: string, read: () => { cert: string, key: string } }} tls  what the server was made with, and how to read the files again
 * @param {object} deps
 * @param {object} deps.logger
 * @returns {{ check: () => boolean }} `check` reads the files and is true when it loaded a new certificate
 */
export function certificateReloader(server, tls, { logger }) {
  let loaded = { cert: tls.cert, key: tls.key };
  let warned = null;
  // One warning for one cause, not one a minute.
  const keep = (reason) => {
    if (warned !== reason) logger.warn({ reason }, 'provisioning: certificate files changed but were not loaded; still serving the old certificate');
    warned = reason;
    return false;
  };
  return {
    check() {
      let next;
      try {
        next = tls.read();
      } catch (err) {
        return keep(`could not read: ${err?.message}`);
      }
      if (next.cert === loaded.cert && next.key === loaded.key) {
        warned = null;
        return false;
      }
      try {
        // Throws when the key is not this certificate's. The two files are replaced
        // one after the other, so a read can catch one new and one old.
        createSecureContext(secureContextOptions(next));
        server.setSecureContext(secureContextOptions(next));
      } catch (err) {
        return keep(`not a certificate and its key: ${err?.message}`);
      }
      loaded = next;
      warned = null;
      let detail = {};
      try {
        const certificate = new X509Certificate(next.cert);
        detail = { validTo: certificate.validTo, fingerprint: certificate.fingerprint256 };
      } catch { /* The context took it, so this is only for the log line. */ }
      logger.info(detail, 'provisioning: loaded a renewed certificate');
      return true;
    },
  };
}

/**
 * @param {object} config        from provisioningConfig
 * @param {object} deps
 * @param {Function} deps.handleFetch
 * @param {Function} [deps.logRateLimited]  writes the fetch log row of a shut-out address
 * @param {object} deps.logger
 * @param {number} [deps.certificateCheckMs]  how often the certificate files are read again
 * @returns {http.Server|https.Server} not yet listening
 */
export function createProvisioningServer(config, { handleFetch, logRateLimited, logger, limiter = refusalLimiter(), certificateCheckMs = CERTIFICATE_CHECK_MS }) {
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
      const limit = limiter.blocked(peer.sourceIp);
      if (limit.blocked) {
        if (limit.first) {
          logger.warn({ sourceIp: peer.sourceIp }, 'provisioning: too many refused requests from one address');
          await logRateLimited?.({ vendor: parts[1], file: parts[3], sourceIp: peer.sourceIp, userAgent: req.headers['user-agent'] });
        }
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
      if (answer.status !== 200) limiter.hit(peer.sourceIp);
      res.writeHead(answer.status, { ...answer.headers, 'Content-Length': Buffer.byteLength(answer.body, 'utf8') });
      return res.end(answer.body);
    } catch (err) {
      logger.error({ err: err?.message }, 'provisioning: request failed');
      return empty(res, 404);
    }
  };
  if (!config.tls) return http.createServer(onRequest);
  const server = https.createServer({
    ...secureContextOptions(config.tls),
    // Ask for the phone's certificate and let the handshake finish whatever it is.
    // The chain is checked in handleFetch against the pinned roots, not against Node's CA list.
    requestCert: true,
    rejectUnauthorized: false,
  }, onRequest);
  if (config.tls.read) {
    const reloader = certificateReloader(server, config.tls, { logger });
    const timer = setInterval(() => reloader.check(), certificateCheckMs);
    if (timer.unref) timer.unref();
    server.on('close', () => clearInterval(timer));
  }
  return server;
}
