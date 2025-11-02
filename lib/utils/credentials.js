import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'crypto';
import logger from '../logger.js';

const { CREDENTIALS_KEY } = process.env;

const deriveKey = (secret) => secret && createHash('sha256').update(String(secret)).digest();
const encryptionKey = deriveKey(CREDENTIALS_KEY);

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


