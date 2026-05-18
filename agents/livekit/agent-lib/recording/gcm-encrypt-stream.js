import { randomBytes, createCipheriv } from 'node:crypto';
import { Transform } from 'node:stream';
import { GCM_IV_LENGTH } from './encryption-key.js';

/**
 * Streaming AES-256-GCM encryptor.
 *
 * Wire format produced (matches the decrypt stream and the Python sibling):
 *
 *   IV (12 bytes) || ciphertext || auth tag (16 bytes)
 *
 * The IV is prepended on first chunk and the auth tag is appended on flush,
 * which is what the download endpoint expects and what `GcmDecryptStream`
 * parses out.
 */
export class GcmEncryptStream extends Transform {
  /**
   * @param {Buffer} key 32-byte AES-256 key.
   */
  constructor(key) {
    super();
    this.key = key;
    this.iv = randomBytes(GCM_IV_LENGTH);
    this.cipher = null;
    this.ivPushed = false;
  }

  _transform(chunk, _encoding, callback) {
    try {
      if (!this.ivPushed) {
        this.ivPushed = true;
        this.push(this.iv);
        this.cipher = createCipheriv('aes-256-gcm', this.key, this.iv);
      }
      if (this.cipher && chunk.length > 0) {
        const out = this.cipher.update(chunk);
        if (out.length > 0) this.push(out);
      }
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _flush(callback) {
    try {
      if (!this.cipher) {
        return callback();
      }
      const final = this.cipher.final();
      if (final.length > 0) this.push(final);
      this.push(this.cipher.getAuthTag());
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
