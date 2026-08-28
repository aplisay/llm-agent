/**
 * The trust boundary in front of /api/auth/*.
 *
 * polite-ai's BFF proxies the public auth endpoints server-to-server. It proves
 * that with a shared secret in `x-auth-proxy-secret`, and this middleware is the
 * only thing that checks it. Two jobs follow from that single question — did
 * this come from our own server, or from someone's browser?
 *
 * 1. ATTRIBUTION. The IP better-auth would otherwise see is the BFF's egress —
 *    one bucket for every user on the platform (the 5/hour platform-wide reset
 *    cap). The BFF forwards the END-USER's IP as `x-client-ip`, and better-auth
 *    reads it ahead of `x-forwarded-for` (advanced.ipAddress.ipAddressHeaders in
 *    lib/auth/index.js). Unless the secret matches AND the value is a single
 *    syntactically-valid IP, the header is STRIPPED before better-auth sees it,
 *    so a direct caller cannot spoof per-client buckets.
 *
 * 2. REFUSAL. Some better-auth endpoints have no business being reachable from
 *    the open internet; `BFF_ONLY` below is that list. Today it holds
 *    `/sign-up/email`, which creates an account and sends mail to whatever
 *    address the body names — the same shape that made polite-ai's /waitlist an
 *    open mail relay on 2026-08-28. It was reachable by anyone, sat outside the
 *    send budgets in lib/auth/index.js (whose hooks.before map covers only the
 *    three reset/verification paths), and had no rate-limit rule of its own.
 *
 * The second job is new, and worth stating plainly because this file's previous
 * name — `client-ip-gate` — actively hid its absence: the middleware ALWAYS
 * called `next()`. It read as a gate and was not one, which is much of why
 * nobody noticed the endpoint behind it stood open.
 *
 * WHAT THIS IS NOT: an authorisation layer for the platform. It answers exactly
 * one question, and everything past it still authenticates normally. Public
 * self-signup is not meant to come through here at all — that is
 * `POST /api/users/signup`, which is deliberately public and carries the
 * protections this route lacks: a global 60/hour cap that IP rotation cannot
 * defeat, a `provisional` row that cannot act until an admin activates it, and
 * a double opt-in email.
 *
 * The secret header itself is always removed, so it can never reach downstream
 * logging.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const CLIENT_IP_HEADER = 'x-client-ip';
const SECRET_HEADER = 'x-auth-proxy-secret';

/**
 * better-auth paths only polite-ai's BFF may reach, matched against the path
 * below the `/api/auth` mount.
 *
 * An exact-match Set rather than a prefix test: better-auth's route space is
 * wide, and a prefix rule would quietly capture siblings as that space grows —
 * which is how a sign-IN endpoint ends up refusing real users because someone
 * wrote `/sign-`.
 */
const BFF_ONLY = new Set(['/sign-up/email']);

// Compare via digests: constant-time and length-blind.
const digest = (value) => createHash('sha256').update(String(value)).digest();

/** The path better-auth routes on: no query string, no mount prefix. */
function routePath(req) {
  const path = (req.url || '').split('?')[0];
  // Express usually strips the mount prefix into req.url, but the gate is cheap
  // to make independent of how it was mounted — so accept either shape.
  return path.startsWith('/api/auth') ? path.slice('/api/auth'.length) || '/' : path;
}

export function createAuthProxyGate({ secret, logger }) {
  const secretHash = secret ? digest(secret) : null;
  if (!secretHash) {
    logger?.warn(
      'auth proxy gate: AUTH_PROXY_SECRET unset — x-client-ip is always stripped, '
      + 'and the BFF-only auth endpoints (sign-up) are refused for everyone, '
      + 'so invite completion will fail. Set it here and on polite-ai.',
    );
  }
  return function authProxyGate(req, res, next) {
    const provided = req.headers[SECRET_HEADER];
    delete req.headers[SECRET_HEADER];

    const claimed = req.headers[CLIENT_IP_HEADER];
    const authorised = Boolean(
      secretHash
      && typeof provided === 'string'
      && provided.length > 0
      && timingSafeEqual(digest(provided), secretHash),
    );

    // Job 2 — refuse the BFF-only endpoints to everyone else. Deliberately
    // fail-CLOSED when no secret is configured: that costs invite completion,
    // which fails loudly and gets fixed, rather than silently reopening a public
    // mail relay, which does neither.
    if (!authorised && BFF_ONLY.has(routePath(req))) {
      logger?.warn(
        { path: routePath(req) },
        'refused a BFF-only auth endpoint reached without the proxy secret',
      );
      // 404 rather than 403: without the secret this endpoint does not exist as
      // far as the caller is concerned, and "forbidden" would confirm it does.
      return res.status(404).json({ error: 'Not found' });
    }

    // Job 1 — attribution.
    const ip = typeof claimed === 'string' ? claimed.trim() : '';
    if (authorised && isIP(ip) !== 0) {
      req.headers[CLIENT_IP_HEADER] = ip;
    } else {
      delete req.headers[CLIENT_IP_HEADER];
    }
    return next();
  };
}

export default createAuthProxyGate;
