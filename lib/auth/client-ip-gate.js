/**
 * Express gate for the `x-client-ip` header on /api/auth/*.
 *
 * polite-ai's BFF proxies the public auth endpoints server-to-server, so the
 * IP better-auth's rate limiter would otherwise see is the BFF's egress — one
 * bucket for every user on the platform (the 5/hour platform-wide reset cap).
 * The BFF therefore forwards the END-USER's IP as `x-client-ip`, authenticated
 * by the shared secret in `x-auth-proxy-secret`, and better-auth is configured
 * to read `x-client-ip` ahead of `x-forwarded-for`
 * (advanced.ipAddress.ipAddressHeaders in lib/auth/index.js).
 *
 * This middleware makes that trustworthy: unless the request carries the
 * matching secret AND a single syntactically-valid IP, `x-client-ip` is
 * STRIPPED before better-auth can read it — a direct caller cannot spoof
 * per-client buckets, and with no secret configured the feature is entirely
 * off. The secret header itself is always removed so it can never leak into
 * downstream logging.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const CLIENT_IP_HEADER = 'x-client-ip';
const SECRET_HEADER = 'x-auth-proxy-secret';

// Compare via digests: constant-time and length-blind.
const digest = (value) => createHash('sha256').update(String(value)).digest();

export function createClientIpGate({ secret, logger }) {
  const secretHash = secret ? digest(secret) : null;
  if (!secretHash) {
    logger?.info('client-ip gate: AUTH_PROXY_SECRET unset — x-client-ip is always stripped');
  }
  return function clientIpGate(req, _res, next) {
    const provided = req.headers[SECRET_HEADER];
    delete req.headers[SECRET_HEADER];

    const claimed = req.headers[CLIENT_IP_HEADER];
    const authorised = Boolean(
      secretHash
      && typeof provided === 'string'
      && provided.length > 0
      && timingSafeEqual(digest(provided), secretHash),
    );
    const ip = typeof claimed === 'string' ? claimed.trim() : '';
    if (authorised && isIP(ip) !== 0) {
      req.headers[CLIENT_IP_HEADER] = ip;
    } else {
      delete req.headers[CLIENT_IP_HEADER];
    }
    next();
  };
}

export default createClientIpGate;
