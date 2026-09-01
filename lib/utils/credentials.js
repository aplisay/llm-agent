import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import logger from '../logger.js';

const { CREDENTIALS_KEY } = process.env;

const deriveKey = (secret) => secret && createHash('sha256').update(String(secret)).digest();
const encryptionKey = deriveKey(CREDENTIALS_KEY);

// True when CREDENTIALS_KEY is configured, i.e. encryptSecret really encrypts.
// Lets startup sweeps skip rewriting rows they could only store back as
// plaintext anyway.
export const credentialsEncryptionEnabled = Boolean(encryptionKey);

/** Whether a usable CREDENTIALS_KEY was configured at process start. */
export const hasCredentialsKey = !!encryptionKey;

/**
 * Structural test: does `value` have the exact shape encryptSecret writes —
 * enc:<b64 12-byte iv>:<b64 16-byte tag>:<b64 ciphertext>? A plaintext
 * credential that merely starts with "enc:" fails this, so it is a stronger
 * discriminator than the bare prefix. Passing says nothing about WHICH key
 * encrypted it — use classifyStoredSecret for that.
 */
export function isEncryptedSecretFormat(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:')) return false;
  const parts = value.split(':');
  if (parts.length !== 4) return false;
  const [, ivB64, tagB64, dataB64] = parts;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    // Round-trip the base64 so "enc:AAAA:!!!!:junk"-style lookalikes (which
    // Buffer.from silently truncates) are rejected, not misread.
    return iv.length === 12 && tag.length === 16 && data.length > 0
      && iv.toString('base64') === ivB64 && tag.toString('base64') === tagB64;
  } catch {
    return false;
  }
}

/**
 * Classify a stored credential value for the at-rest audit/sweep
 * (lib/utils/credentials-sweep.js). GCM's auth tag makes 'encrypted' a
 * cryptographic verdict, not a guess: a successful decrypt proves the value
 * was written under the current CREDENTIALS_KEY.
 *
 * @returns {'empty'|'non-string'|'plaintext'|'enc-lookalike'|'encrypted'|'encrypted-foreign'|'encrypted-unverified'}
 *  - empty: null/undefined
 *  - non-string: stored as a non-string (never produced by encryptSecret)
 *  - plaintext: no enc: prefix — a legacy value stored before a key was set
 *  - enc-lookalike: enc:-prefixed but structurally invalid; in reality
 *    plaintext, but today's read path nulls it — surfaced, never swept
 *  - encrypted: tag verifies under the current key
 *  - encrypted-foreign: valid structure, tag fails — written under some other
 *    key, or corrupted
 *  - encrypted-unverified: valid structure but no CREDENTIALS_KEY in this
 *    process to verify against
 */
export function classifyStoredSecret(value) {
  if (value == null) return 'empty';
  if (typeof value !== 'string') return 'non-string';
  if (!value.startsWith('enc:')) return 'plaintext';
  if (!isEncryptedSecretFormat(value)) return 'enc-lookalike';
  if (!encryptionKey) return 'encrypted-unverified';
  const [, ivB64, tagB64, dataB64] = value.split(':');
  try {
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
    return 'encrypted';
  } catch {
    return 'encrypted-foreign';
  }
}

export function encryptSecret(plainText) {
  if (plainText == null) return null;
  try {
    if (!encryptionKey) {
      logger.warn('CREDENTIALS_KEY not set; storing password in plaintext');
      return plainText;
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'enc:' + Buffer.from(iv).toString('base64') + ':' + Buffer.from(tag).toString('base64') + ':' + Buffer.from(ciphertext).toString('base64');
  } catch (e) {
    logger.error(e, 'Failed to encrypt secret; storing plaintext');
    return plainText;
  }
}

export function decryptSecret(stored) {
  if (stored == null) return null;
  try {
    if (typeof stored === 'string' && stored.startsWith('enc:')) {
      if (!encryptionKey) {
        logger.warn('CREDENTIALS_KEY not set; cannot decrypt stored password');
        return null;
      }
      const [, ivB64, tagB64, dataB64] = stored.split(':');
      const iv = Buffer.from(ivB64, 'base64');
      const tag = Buffer.from(tagB64, 'base64');
      const data = Buffer.from(dataB64, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
      return plaintext;
    }
    return stored;
  } catch (e) {
    logger.error(e, 'Failed to decrypt secret');
    return null;
  }
}

export const PHONE_REGISTRATION_STATUS_VALUES = ['active', 'failed', 'disabled'];
export const PHONE_REGISTRATION_STATE_VALUES = ['initial', 'registering', 'registered', 'failed'];
export const PHONE_REGISTRATION_SCHEMA_VERSION = 1;


