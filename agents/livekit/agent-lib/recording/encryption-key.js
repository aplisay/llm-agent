import { randomBytes } from 'node:crypto';

export const GCM_IV_LENGTH = 12;
export const GCM_AUTH_TAG_LENGTH = 16;
export const KEY_LENGTH = 32;

/**
 * Derive a 32-byte key from a client-provided string.
 *
 * Clients pick any string they like; we either truncate or right-pad with
 * zeros so the resulting buffer always matches AES-256's key size. The
 * Python sibling implements the same derivation so a recording encrypted on
 * one platform decrypts on the other.
 *
 * @param {string} clientKey
 * @returns {Buffer}
 */
export function deriveKey(clientKey) {
  const keyBytes = Buffer.from(clientKey, 'utf8');
  if (keyBytes.length >= KEY_LENGTH) {
    return keyBytes.subarray(0, KEY_LENGTH);
  }
  return Buffer.concat([keyBytes, Buffer.alloc(KEY_LENGTH - keyBytes.length, 0)]);
}

/**
 * Generate a random 32-byte key plus its base64 representation. The base64
 * value is what the server stores so it can decrypt on the operator's behalf
 * during download. Returned `key` is the raw buffer used for the in-stream
 * cipher.
 *
 * @returns {{ key: Buffer, base64: string }}
 */
export function generateKey() {
  const key = randomBytes(KEY_LENGTH);
  return { key, base64: key.toString('base64') };
}
