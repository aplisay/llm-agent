import fs from 'node:fs';
import { Storage } from '@google-cloud/storage';
import { pipeline } from 'node:stream/promises';
import { GcmEncryptStream } from './gcm-encrypt-stream.js';
import { deriveKey, generateKey } from './encryption-key.js';
import {
  parseGcsPath,
  defaultRecordingBaseUrl,
  objectNameFor,
} from './gcs-path.js';

/**
 * @typedef {Object} UploadEncryptedOggOptions
 * @property {string} localPath Path to the local OGG file to upload.
 * @property {string} callId Used to derive the GCS object name.
 * @property {string=} clientEncryptionKey When set, derive the key from this
 *   string (client retains plaintext access). When omitted, generate a random
 *   key and return its base64 so the platform can decrypt during download.
 * @property {string=} baseUrl Override of the GCS base URL. Defaults to
 *   {@link defaultRecordingBaseUrl}.
 * @property {number=} uploadTimeoutMs Defaults to 30 seconds.
 * @property {{ debug?: Function, info?: Function, warn?: Function }=} logger
 *   Optional structured logger; methods called with `(meta, message)`.
 * @property {boolean=} deleteLocalOnSuccess Defaults to true.
 */

/**
 * @typedef {Object} UploadEncryptedOggResult
 * @property {string} gcsBucket
 * @property {string} gcsObject
 * @property {string=} serverGeneratedKey base64-encoded raw key, only present
 *   when no `clientEncryptionKey` was supplied.
 */

const NOOP_LOGGER = { debug() {}, info() {}, warn() {} };

/**
 * Stream a local OGG file through AES-256-GCM into a GCS object. The on-wire
 * format is `IV || ciphertext || authTag`, matching {@link GcmDecryptStream}.
 *
 * @param {UploadEncryptedOggOptions} options
 * @returns {Promise<UploadEncryptedOggResult>}
 */
export async function uploadEncryptedOgg(options) {
  const {
    localPath,
    callId,
    clientEncryptionKey,
    baseUrl,
    uploadTimeoutMs = 30 * 1000,
    logger: providedLogger,
    deleteLocalOnSuccess = true,
  } = options;
  const logger = providedLogger || NOOP_LOGGER;

  const { bucket, prefix } = parseGcsPath(baseUrl || defaultRecordingBaseUrl());
  const gcsObject = objectNameFor(prefix, callId);

  if (!fs.existsSync(localPath)) {
    logger.warn?.(
      { callId, localPath },
      'uploadEncryptedOgg: source file not found',
    );
    throw new Error(`Recording source file not found: ${localPath}`);
  }

  try {
    const stat = await fs.promises.stat(localPath);
    logger.info?.(
      { callId, localPath, localSize: stat.size },
      'uploadEncryptedOgg: source file size before upload',
    );
  } catch (err) {
    logger.warn?.(
      { callId, localPath, err },
      'uploadEncryptedOgg: failed to stat source file',
    );
  }

  let key;
  let serverGeneratedKey;
  if (clientEncryptionKey) {
    key = deriveKey(clientEncryptionKey);
    logger.debug?.({ callId }, 'uploadEncryptedOgg: using client-provided key');
  } else {
    const { key: rawKey, base64 } = generateKey();
    key = rawKey;
    serverGeneratedKey = base64;
    logger.debug?.({ callId }, 'uploadEncryptedOgg: using server-generated key');
  }

  const storage = new Storage();
  const file = storage.bucket(bucket).file(gcsObject);

  const readStream = fs.createReadStream(localPath);
  const encryptStream = new GcmEncryptStream(key);
  const writeStream = file.createWriteStream({
    metadata: { contentType: 'application/octet-stream' },
    resumable: false,
  });

  const timeoutError = new Error('Recording upload to GCS timed out');
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      logger.warn?.({ callId }, 'uploadEncryptedOgg: timeout reached');
      readStream.destroy(timeoutError);
      encryptStream.destroy(timeoutError);
      writeStream.destroy(timeoutError);
      reject(timeoutError);
    }, uploadTimeoutMs);
  });

  try {
    logger.debug?.({ callId }, 'uploadEncryptedOgg: starting encrypted upload');
    await Promise.race([
      pipeline(readStream, encryptStream, writeStream),
      timeoutPromise,
    ]);
    logger.debug?.({ callId }, 'uploadEncryptedOgg: upload complete');
    if (deleteLocalOnSuccess) {
      await fs.promises.unlink(localPath).catch((err) => {
        logger.warn?.(
          { err, localPath, callId },
          'uploadEncryptedOgg: upload succeeded but local cleanup failed',
        );
      });
    }
  } catch (err) {
    logger.warn?.(
      { err, localPath, callId },
      'uploadEncryptedOgg: failed to upload',
    );
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  logger.info?.(
    { callId, bucket, gcsObject, hasServerKey: Boolean(serverGeneratedKey) },
    'uploadEncryptedOgg: uploaded encrypted recording to GCS',
  );

  return { gcsBucket: bucket, gcsObject, serverGeneratedKey };
}
