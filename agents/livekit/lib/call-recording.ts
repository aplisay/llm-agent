import { Storage } from '@google-cloud/storage';
import { randomBytes, createCipheriv } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import logger from '../agent-lib/logger.js';

const GCM_IV_LENGTH = 12;
const GCM_AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

const { RECORDING_STORAGE_PATH, NODE_ENV } = process.env;

function parseGcsPath(baseUrl: string): { bucket: string; prefix: string } {
  // Expect format: gs://bucket[/optional/prefix/]
  if (!baseUrl.startsWith('gs://')) {
    throw new Error('RECORDING_STORAGE_PATH must be a gs:// URL');
  }

  const withoutScheme = baseUrl.slice('gs://'.length);
  const firstSlash = withoutScheme.indexOf('/');
  if (firstSlash === -1) {
    return { bucket: withoutScheme, prefix: '' };
  }

  const bucket = withoutScheme.slice(0, firstSlash);
  let prefix = withoutScheme.slice(firstSlash + 1);
  if (prefix.length > 0 && !prefix.endsWith('/')) {
    prefix += '/';
  }
  return { bucket, prefix };
}

const RECORDER_IO_FILENAME = 'audio.ogg';

export interface UploadRecorderIOOptions {
  /** When set, use this key for encryption (client-provided); server will not store the key. */
  clientEncryptionKey?: string;
}

/**
 * Derive a 32-byte key from a client-provided string (same as legacy room-listener).
 */
function deriveKey(clientKey: string): Buffer {
  const keyBytes = Buffer.from(clientKey, 'utf8');
  if (keyBytes.length >= KEY_LENGTH) {
    return keyBytes.subarray(0, KEY_LENGTH);
  }
  return Buffer.concat([keyBytes, Buffer.alloc(KEY_LENGTH - keyBytes.length, 0)]);
}

/**
 * Streaming encrypt Transform: outputs IV (12 bytes) then ciphertext then auth tag (16 bytes).
 * Matches the format expected by the download API's GcmDecryptStream.
 */
class GcmEncryptStream extends Transform {
  private readonly key: Buffer;
  private readonly iv: Buffer;
  private cipher: ReturnType<typeof createCipheriv> | null = null;
  private ivPushed = false;

  constructor(key: Buffer) {
    super();
    this.key = key;
    this.iv = randomBytes(GCM_IV_LENGTH);
  }

  _transform(chunk: Buffer, _encoding: string, callback: (err?: Error | null, data?: never) => void): void {
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

  _flush(callback: (err?: Error | null) => void): void {
    try {
      if (!this.cipher) {
        return callback();
      }
      const final = this.cipher.final();
      if (final.length > 0) this.push(final);
      this.push((this.cipher as import('node:crypto').CipherGCM).getAuthTag());
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

/**
 * Upload the RecorderIO OGG file from the session directory to GCS, optionally encrypted.
 * When clientEncryptionKey is omitted, a random key is generated and returned so the server can store it for decryption on download.
 */
export async function uploadRecorderIOToGcs(
  sessionDirectory: string,
  callId: string,
  options?: UploadRecorderIOOptions,
): Promise<{ gcsBucket: string; gcsObject: string; serverGeneratedKey?: string }> {
  const basePath =
    RECORDING_STORAGE_PATH || `gs://llm-voice/${NODE_ENV || 'development'}-recordings`;
  const { bucket, prefix } = parseGcsPath(basePath);
  const objectName = `${prefix}${callId}.ogg`;
  const localPath = path.join(sessionDirectory, RECORDER_IO_FILENAME);

  if (!fs.existsSync(localPath)) {
    logger.warn({ callId, sessionDirectory, localPath }, 'uploadRecorderIOToGcs: OGG file not found, skipping upload');
    throw new Error(`RecorderIO recording file not found: ${localPath}`);
  }

  let key: Buffer;
  let serverGeneratedKey: string | undefined;

  if (options?.clientEncryptionKey) {
    key = deriveKey(options.clientEncryptionKey);
    logger.debug({ callId }, 'uploadRecorderIOToGcs: using client-provided encryption key');
  } else {
    const randomKey = randomBytes(KEY_LENGTH);
    key = randomKey;
    serverGeneratedKey = randomKey.toString('base64');
    logger.debug({ callId }, 'uploadRecorderIOToGcs: using server-generated encryption key');
  }

  const storage = new Storage();
  const file = storage.bucket(bucket).file(objectName);

  const readStream = fs.createReadStream(localPath);
  const encryptStream = new GcmEncryptStream(key);
  const writeStream = file.createWriteStream({
    metadata: { contentType: 'application/octet-stream' },
    resumable: false,
  });

  const UPLOAD_TIMEOUT_MS = 30 * 1000; // 30 seconds
  const timeoutError = new Error('RecorderIO upload to GCS timed out');
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      logger.warn({ callId }, 'uploadRecorderIOToGcs: timeout reached, destroying streams');
      readStream.destroy(timeoutError);
      encryptStream.destroy(timeoutError);
      writeStream.destroy(timeoutError);
      reject(timeoutError);
    }, UPLOAD_TIMEOUT_MS);
  });

  try {
    logger.debug({ callId }, 'uploadRecorderIOToGcs: uploading encrypted RecorderIO recording to GCS');
    await Promise.race([
      pipeline(readStream, encryptStream, writeStream),
      timeoutPromise,
    ]);
    logger.debug({ callId }, 'uploadRecorderIOToGcs: uploaded encrypted RecorderIO recording to GCS');
    logger.debug({ callId }, 'uploadRecorderIOToGcs: deleting local OGG file');
    await fs.promises.unlink(localPath);
    logger.debug({ callId }, 'uploadRecorderIOToGcs: deleted local OGG file');
  } catch (err) {
    logger.warn({ err, localPath, callId }, 'uploadRecorderIOToGcs: failed to upload or delete local OGG file');
    throw err; // Rethrow so caller does not set recordingId on failed upload
  } finally {
    clearTimeout(timeoutId!);
  }

  logger.info(
    { callId, bucket, objectName, hasServerKey: Boolean(serverGeneratedKey) },
    'uploadRecorderIOToGcs: uploaded encrypted RecorderIO recording to GCS',
  );
  return { gcsBucket: bucket, gcsObject: objectName, serverGeneratedKey };
}
