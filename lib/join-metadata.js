import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Seals a WebRTC join's call metadata for the LiveKit agent dispatch. The browser
// can decode its participant token, and the metadata can hold customer secrets.
// The key derives from LIVEKIT_API_SECRET, which the API and the worker share.

const VERSION = 'v1';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const KEY_INFO = 'aplisay/livekit-join-metadata/v1';

function deriveKey(secret) {
  if (!secret) {
    throw new Error('no secret to seal or open join metadata with');
  }
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), KEY_INFO, KEY_LENGTH));
}

/**
 * Seal call metadata for the agent dispatch in a participant token.
 *
 * @param {object} metadata JSON-serialisable call metadata
 * @param {string | undefined} secret LIVEKIT_API_SECRET
 * @returns {string} `v1.<base64url(iv | tag | ciphertext)>`
 */
export function sealJoinMetadata(metadata, secret) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(metadata), 'utf8'), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

/**
 * Open a value made by sealJoinMetadata. Throws if the value is malformed or
 * was sealed with a different secret.
 *
 * @param {string} sealed
 * @param {string | undefined} secret LIVEKIT_API_SECRET
 * @returns {object}
 */
export function openJoinMetadata(sealed, secret) {
  const [version, body, ...rest] = String(sealed).split('.');
  if (version !== VERSION || !body || rest.length) {
    throw new Error('sealed join metadata is not in a known format');
  }
  const raw = Buffer.from(body, 'base64url');
  if (raw.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('sealed join metadata is too short');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret), raw.subarray(0, IV_LENGTH));
  decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  const plaintext = Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}
