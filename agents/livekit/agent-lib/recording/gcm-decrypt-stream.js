import { createDecipheriv } from 'node:crypto';
import { Transform } from 'node:stream';
import { GCM_IV_LENGTH, GCM_AUTH_TAG_LENGTH } from './encryption-key.js';

/**
 * Streaming AES-256-GCM decryptor for the wire format emitted by
 * {@link GcmEncryptStream}:
 *
 *   IV (12 bytes) || ciphertext || auth tag (16 bytes)
 *
 * We keep a 16-byte trailing buffer back so we can hand the auth tag to
 * `decipher.setAuthTag` in `_flush` rather than buffering the entire stream
 * in memory.
 */
export class GcmDecryptStream extends Transform {
  /**
   * @param {Buffer} key 32-byte AES-256 key.
   */
  constructor(key) {
    super();
    this.key = key;
    this.ivBuffer = Buffer.alloc(0);
    this.trailingBuffer = Buffer.alloc(0);
    this.decipher = null;
  }

  _transform(chunk, _encoding, callback) {
    try {
      if (!this.decipher) {
        this.ivBuffer = Buffer.concat([this.ivBuffer, chunk]);
        if (this.ivBuffer.length < GCM_IV_LENGTH) {
          return callback();
        }
        const iv = this.ivBuffer.subarray(0, GCM_IV_LENGTH);
        const remaining = this.ivBuffer.subarray(GCM_IV_LENGTH);
        this.decipher = createDecipheriv('aes-256-gcm', this.key, iv);
        this.trailingBuffer = remaining;
        // Fall through so a single-chunk payload (whole file in one buffer)
        // still gets drained. Previously this returned early and `_flush`
        // would fail because trailingBuffer was longer than the auth tag.
      } else {
        this.trailingBuffer = Buffer.concat([this.trailingBuffer, chunk]);
      }

      while (this.trailingBuffer.length > GCM_AUTH_TAG_LENGTH) {
        const toDecrypt = this.trailingBuffer.subarray(
          0,
          this.trailingBuffer.length - GCM_AUTH_TAG_LENGTH,
        );
        this.trailingBuffer = this.trailingBuffer.subarray(
          this.trailingBuffer.length - GCM_AUTH_TAG_LENGTH,
        );
        const decrypted = this.decipher.update(toDecrypt);
        if (decrypted.length > 0) {
          this.push(decrypted);
        }
      }
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }

  _flush(callback) {
    try {
      if (!this.decipher) {
        return callback();
      }
      if (this.trailingBuffer.length !== GCM_AUTH_TAG_LENGTH) {
        return callback(
          new Error(
            `Invalid ciphertext: auth tag must be ${GCM_AUTH_TAG_LENGTH} bytes`,
          ),
        );
      }
      this.decipher.setAuthTag(this.trailingBuffer);
      const finalData = this.decipher.final();
      if (finalData.length > 0) {
        this.push(finalData);
      }
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
