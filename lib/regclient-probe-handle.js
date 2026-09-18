import crypto from 'crypto';

/**
 * Sign probe handles over node and registration so migration and path substitution cannot redirect reads. See PR
 * #265. Verify ownership separately; the signed payload provides integrity, not confidentiality.
 */

const VERSION = 'v1';

function keyFor(secret) {
  return crypto.createHash('sha256').update(`aplisay-probe-handle:${secret}`).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Wrap a node's probe id in a handle naming the node and the registration.
 *
 * Returns null when there is no secret to sign with, which the caller must
 * treat as a failure rather than falling back to the bare id: an unsigned id is
 * the hole this exists to close.
 */
export function signProbeHandle({ node, registrationId, probeId }, config = {}) {
  const secret = config.token;
  if (!secret || !node || !registrationId || !probeId) return null;

  const payload = b64url(JSON.stringify({ n: node, r: registrationId, p: probeId }));
  const mac = crypto.createHmac('sha256', keyFor(secret)).update(`${VERSION}.${payload}`).digest();
  return `${VERSION}.${payload}.${b64url(mac)}`;
}

/**
 * Read a handle back, checking it was issued by us and is for this
 * registration.
 *
 * `{ ok: false }` for anything that does not verify — a forgery, a handle for
 * another registration, or a bare probe id from an older client. The caller
 * answers 404 rather than 403: whether a probe exists on a node is itself
 * information about somebody else's registration.
 */
export function verifyProbeHandle(handle, { registrationId }, config = {}) {
  // The previous token verifies too, so rotating REGCLIENT_API_TOKEN does not
  // invalidate handles already in flight. Nodes accept two bearer tokens at
  // once for exactly this reason; the facade signing with one and verifying
  // against one alone meant a rotation turned every open probe into a 404
  // mid-watch. Signing still uses the current token only, so a handle issued
  // now never depends on the old secret.
  const secrets = [config.token, config.tokenPrevious].filter(Boolean);
  if (secrets.length === 0) return { ok: false, reason: 'no node API token configured' };

  const parts = String(handle || '').split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    return { ok: false, reason: 'not a probe handle' };
  }
  const [, payload, signature] = parts;

  const got = Buffer.from(signature, 'base64url');
  const verified = secrets.some((secret) => {
    const expected = crypto.createHmac('sha256', keyFor(secret)).update(`${VERSION}.${payload}`).digest();
    // Length check first: timingSafeEqual throws on a mismatch rather than
    // returning false.
    return got.length === expected.length && crypto.timingSafeEqual(got, expected);
  });
  if (!verified) {
    return { ok: false, reason: 'signature does not verify' };
  }

  let decoded;
  try {
    decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  }
  catch {
    return { ok: false, reason: 'malformed handle' };
  }
  if (!decoded?.n || !decoded?.r || !decoded?.p) {
    return { ok: false, reason: 'incomplete handle' };
  }
  if (decoded.r !== registrationId) {
    return { ok: false, reason: 'handle is for a different registration' };
  }
  return { ok: true, node: decoded.n, probeId: decoded.p, registrationId: decoded.r };
}
