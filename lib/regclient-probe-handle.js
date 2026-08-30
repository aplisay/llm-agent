import crypto from 'crypto';

/**
 * Probe handles: a probe id that carries where it ran and what it was for.
 *
 * A probe lives in memory on one node. Its id means nothing anywhere else, and
 * two things follow from that which a bare id cannot express.
 *
 * **Which node.** The follow-up routes used to re-resolve the registration's
 * `b2bua_id` on every call. That is the right node right up until the
 * registration migrates — which is exactly what an operator is likely to be
 * doing while watching a probe, and which is a one-line database write. The
 * report and the event stream would then go to a node that never ran the probe
 * and return 404, with the probe still running perfectly well next door.
 *
 * **Which registration.** The node's probe route is addressed by probe id
 * alone, so a caller who could read *any* registration could pass their own
 * registration in the path and somebody else's probe id in the URL, and be
 * handed a report containing another tenant's SIP transcript — registrar,
 * account identity, credentials-in-flight. Ownership was checked on the path
 * parameter, and the path parameter was not what selected the data.
 *
 * So the id the facade hands out is signed over both. It is opaque to callers
 * — the API contract has always been "an opaque probe id" — and it is verified
 * against the registration in the path before anything is fetched. Ownership is
 * still checked separately: a handle says what it is for, not who may see it.
 *
 * Signed with the node API token, which is the one secret that is necessarily
 * present whenever a probe can run at all: without it the facade cannot reach a
 * node, so there is no probe to hand a handle for. A derived key rather than
 * the token itself, so a handle can never be mistaken for a credential.
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
  const secret = config.token;
  if (!secret) return { ok: false, reason: 'no node API token configured' };

  const parts = String(handle || '').split('.');
  if (parts.length !== 3 || parts[0] !== VERSION) {
    return { ok: false, reason: 'not a probe handle' };
  }
  const [, payload, signature] = parts;

  const expected = crypto.createHmac('sha256', keyFor(secret)).update(`${VERSION}.${payload}`).digest();
  const got = Buffer.from(signature, 'base64url');
  // Length check first: timingSafeEqual throws on a mismatch rather than
  // returning false.
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) {
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
