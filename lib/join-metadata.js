import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Seals a WebRTC join's call metadata into the credentials the browser gets: the
// LiveKit participant token, or the Pipecat join token. The browser can decode
// both, and the metadata can hold customer secrets. The key derives from a secret
// the API and that worker share (LIVEKIT_API_SECRET or PIPECAT_JOIN_SECRET).
// agents/pipecat/pipecat_aplisay/join_metadata.py is the Python side.

const VERSION = 'v1';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

// HKDF info labels, one per worker family, so each purpose gets its own key.
export const JOIN_METADATA_KEY_INFO = {
  livekit: 'aplisay/livekit-join-metadata/v1',
  pipecat: 'aplisay/pipecat-join-metadata/v1',
};

function deriveKey(secret, info) {
  if (!secret) {
    throw new Error('no secret to seal or open join metadata with');
  }
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, KEY_LENGTH));
}

/**
 * Seal call metadata for the browser's join credentials.
 *
 * @param {object} metadata JSON-serialisable call metadata
 * @param {string | undefined} secret LIVEKIT_API_SECRET or PIPECAT_JOIN_SECRET
 * @param {string} [info] one of JOIN_METADATA_KEY_INFO
 * @returns {string} `v1.<base64url(iv | tag | ciphertext)>`
 */
export function sealJoinMetadata(metadata, secret, info = JOIN_METADATA_KEY_INFO.livekit) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, info), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(metadata), 'utf8'), cipher.final()]);
  return `${VERSION}.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`;
}

/**
 * The join credentials' field for a join's `options.metadata`: `{ sealedCallMetadata }`,
 * or `{}` when there is no metadata to carry.
 *
 * @param {unknown} metadata `options.metadata` from the join request
 * @param {string | undefined} secret LIVEKIT_API_SECRET or PIPECAT_JOIN_SECRET
 * @param {string} [info] one of JOIN_METADATA_KEY_INFO
 * @returns {{ sealedCallMetadata?: string }}
 */
export function sealedCallMetadata(metadata, secret, info) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !Object.keys(metadata).length) {
    return {};
  }
  return { sealedCallMetadata: sealJoinMetadata(metadata, secret, info) };
}

/**
 * Open a value made by sealJoinMetadata. Throws if the value is malformed or
 * was sealed with a different secret or info label.
 *
 * @param {string} sealed
 * @param {string | undefined} secret LIVEKIT_API_SECRET or PIPECAT_JOIN_SECRET
 * @param {string} [info] one of JOIN_METADATA_KEY_INFO
 * @returns {object}
 */
export function openJoinMetadata(sealed, secret, info = JOIN_METADATA_KEY_INFO.livekit) {
  const [version, body, ...rest] = String(sealed).split('.');
  if (version !== VERSION || !body || rest.length) {
    throw new Error('sealed join metadata is not in a known format');
  }
  const raw = Buffer.from(body, 'base64url');
  if (raw.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('sealed join metadata is too short');
  }
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secret, info), raw.subarray(0, IV_LENGTH));
  decipher.setAuthTag(raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
  const plaintext = Buffer.concat([decipher.update(raw.subarray(IV_LENGTH + TAG_LENGTH)), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8'));
}
