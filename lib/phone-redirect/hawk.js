/**
 * Hawk request signing (HMAC-SHA256), client side only. Pure.
 * https://github.com/mozilla/hawk/blob/main/API.md
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';

/** The hash of a request body, as Hawk's `hash` attribute. */
export function payloadHash(payload, contentType) {
  const type = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return createHash('sha256').update(`hawk.1.payload\n${type}\n${payload ?? ''}\n`).digest('base64');
}

/** The MAC over the normalised request string. */
export function requestMac({ key, ts, nonce, method, resource, host, port, hash = '', ext = '' }) {
  const normalised = `hawk.1.header\n${ts}\n${nonce}\n${String(method).toUpperCase()}\n${resource}\n${String(host).toLowerCase()}\n${port}\n${hash}\n${ext}\n`;
  return createHmac('sha256', key).update(normalised).digest('base64');
}

/**
 * The Authorization header for one request.
 * @param {object} args
 * @param {{ id: string, key: string }} args.credentials
 * @param {string} args.method
 * @param {string|URL} args.url
 * @param {string} [args.payload]      the exact body text, when there is one
 * @param {string} [args.contentType]  needed with a payload
 * @param {number} [args.now]          milliseconds
 * @param {string} [args.nonce]
 */
export function hawkHeader({ credentials, method, url, payload, contentType, now = Date.now(), nonce = randomBytes(6).toString('base64url') }) {
  const target = new URL(url);
  const ts = Math.floor(now / 1000);
  const hash = payload === undefined ? '' : payloadHash(payload, contentType);
  const mac = requestMac({
    key: credentials.key,
    ts,
    nonce,
    method,
    resource: `${target.pathname}${target.search}`,
    host: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    hash,
  });
  return `Hawk id="${credentials.id}", ts="${ts}", nonce="${nonce}"${hash ? `, hash="${hash}"` : ''}, mac="${mac}"`;
}
