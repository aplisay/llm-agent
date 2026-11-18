/**
 * Checks the factory certificate a desk phone presents when it asks for its
 * settings. Pure: no database, no network.
 *
 * Trust is a PEM bundle of the vendor's CA certificates plus the SHA-256
 * fingerprints of the roots we pin. A root in the bundle that is not pinned is
 * ignored. The operating system's trust store is never used.
 */
import { X509Certificate } from 'node:crypto';

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const MAX_CHAIN = 4;

/** The fingerprint as 64 lower-case hex digits, from any usual spelling. */
export const normaliseFingerprint = (value) => String(value ?? '').replace(/[^0-9a-f]/gi, '').toLowerCase();

export const fingerprintOf = (certificate) => normaliseFingerprint(certificate.fingerprint256);

/** Every certificate in a PEM text. Throws on a block that does not parse. */
export function parsePemBundle(pem) {
  return (String(pem ?? '').match(PEM_RE) || []).map((block) => new X509Certificate(block));
}

const selfSigned = (certificate) => certificate.checkIssued(certificate) && certificate.verify(certificate.publicKey);

const inDate = (certificate, now) => new Date(certificate.validFrom) <= now && now <= new Date(certificate.validTo);

const signedBy = (certificate, issuer) => certificate.checkIssued(issuer) && certificate.verify(issuer.publicKey);

/**
 * Build the trust set of one vendor.
 * @param {string} pem           the vendor's roots and intermediates
 * @param {string[]} fingerprints SHA-256 fingerprints of the roots to pin
 * @returns {{ roots: X509Certificate[], intermediates: X509Certificate[] }}
 */
export function loadTrust(pem, fingerprints) {
  const pinned = new Set((fingerprints || []).map(normaliseFingerprint).filter((value) => value.length === 64));
  if (!pinned.size) throw new Error('no pinned root fingerprint');
  const certificates = parsePemBundle(pem);
  const roots = certificates.filter((certificate) => selfSigned(certificate) && pinned.has(fingerprintOf(certificate)));
  if (!roots.length) throw new Error('the CA bundle holds no root with a pinned fingerprint');
  const intermediates = certificates.filter((certificate) => certificate.ca && !selfSigned(certificate));
  return { roots, intermediates };
}

/**
 * The MAC address in the certificate's subject common name, as twelve
 * lower-case hex digits, or null. Read from the parsed subject, not from a
 * printed name. Two common names are refused.
 */
export function macOfCertificate(certificate) {
  const commonName = certificate.toLegacyObject().subject?.CN;
  if (typeof commonName !== 'string') return null;
  const mac = commonName.trim().replace(/[:-]/g, '').toLowerCase();
  return /^[0-9a-f]{12}$/.test(mac) ? mac : null;
}

/**
 * Check a phone's certificate against a vendor's trust set.
 *
 * @param {X509Certificate} leaf
 * @param {object} trust        from loadTrust
 * @param {object} [options]
 * @param {X509Certificate[]} [options.presented] certificates the phone sent with its own. Not trusted by themselves.
 * @param {Date} [options.now]
 * @returns {{ ok: true, mac, fingerprint, serial, issuer } | { ok: false, reason }}
 *   reason: 'certificate_expired' | 'certificate_untrusted' | 'certificate_no_mac'
 */
export function verifyDeviceCertificate(leaf, trust, { presented = [], now = new Date() } = {}) {
  const candidates = [...trust.intermediates, ...presented.filter((certificate) => certificate.ca)];
  let current = leaf;
  let anchored = false;
  for (let depth = 0; depth < MAX_CHAIN; depth += 1) {
    if (!inDate(current, now)) return { ok: false, reason: 'certificate_expired' };
    const root = trust.roots.find((candidate) => signedBy(current, candidate));
    if (root) {
      if (!inDate(root, now)) return { ok: false, reason: 'certificate_expired' };
      anchored = true;
      break;
    }
    const subject = current;
    const next = candidates.find((candidate) => candidate !== subject && signedBy(subject, candidate));
    if (!next) break;
    current = next;
  }
  if (!anchored) return { ok: false, reason: 'certificate_untrusted' };
  // A CA certificate is never a phone.
  if (leaf.ca) return { ok: false, reason: 'certificate_untrusted' };
  const mac = macOfCertificate(leaf);
  if (!mac) return { ok: false, reason: 'certificate_no_mac' };
  return { ok: true, mac, fingerprint: fingerprintOf(leaf), serial: leaf.serialNumber, issuer: leaf.issuer.replace(/\n/g, ', ') };
}

/** The certificate a proxy passed in a header: PEM, URL-encoded or not. Null when it does not parse. */
export function certificateFromHeader(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const pem = value.includes('%') ? decodeURIComponent(value) : value;
    const [first] = parsePemBundle(pem.replace(/\t/g, '\n'));
    return first || null;
  } catch {
    return null;
  }
}
