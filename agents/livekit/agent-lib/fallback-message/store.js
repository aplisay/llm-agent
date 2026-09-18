/**
 * GCS read/write for the fallback-message cache.
 *
 * Every function here is **never-throw**. This code runs only when agent setup
 * has already failed, and the caller's remaining options are to play the
 * announcement or drop to `fallback.number`; a bucket outage must degrade to
 * "synthesise it again this call", never to an exception that costs the caller
 * the announcement as well as the agent.
 *
 * Mirrored by `agents/pipecat/pipecat_aplisay/fallback_message/store.py`.
 */

import { Storage } from '@google-cloud/storage';
import { parseGcsPath, defaultFallbackMessageBaseUrl, objectNameForKey } from './gcs-path.js';

const NOOP_LOGGER = { debug() {}, info() {}, warn() {} };

/** Default deadline for either direction. Short: the caller is on the line. */
export const DEFAULT_TIMEOUT_MS = 5000;

let sharedStorage;
/** Lazily constructed so importing this module never touches credentials. */
function storage() {
  if (!sharedStorage) {
    sharedStorage = new Storage();
  }
  return sharedStorage;
}

/** @param {Promise<any>} promise @param {number} ms @param {string} what */
function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/**
 * Read a cached announcement.
 *
 * @param {Object} options
 * @param {string} options.key Digest from `fallbackMessageKey`.
 * @param {string=} options.baseUrl Defaults to {@link defaultFallbackMessageBaseUrl}.
 * @param {number=} options.timeoutMs
 * @param {{debug?:Function,info?:Function,warn?:Function}=} options.logger
 * @returns {Promise<Buffer|null>} WAV bytes, or `null` on a miss or any failure.
 */
export async function fetchCachedMessage({ key, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, logger = NOOP_LOGGER }) {
  const { bucket, prefix } = parseGcsPath(baseUrl || defaultFallbackMessageBaseUrl());
  const gcsObject = objectNameForKey(prefix, key);
  try {
    const [contents] = await withTimeout(
      storage().bucket(bucket).file(gcsObject).download(),
      timeoutMs,
      'fallback message download',
    );
    logger.debug?.({ key, bucket, gcsObject, bytes: contents.length }, 'fallback message cache hit');
    return contents;
  } catch (e) {
    // 404 is the ordinary first-use miss and is not worth a warning; anything
    // else is worth seeing, but is still only a miss as far as the caller goes.
    if (e?.code === 404) {
      logger.debug?.({ key, bucket, gcsObject }, 'fallback message cache miss');
    } else {
      logger.warn?.({ e, key, bucket, gcsObject }, 'fallback message cache read failed; will synthesise');
    }
    return null;
  }
}

/**
 * Write a freshly synthesised announcement into the cache.
 *
 * Written with `ifGenerationMatch: 0`, which makes the upload succeed only if
 * the object does not yet exist. When a model outage fails many calls at once
 * every worker misses the cache and synthesises concurrently; this way the
 * first to finish publishes and the rest get a precondition failure, which is
 * reported here as success because the cache does now hold the object. Without
 * it the losers would overwrite a perfectly good object with an identical one,
 * burning writes and briefly exposing readers to a partial overwrite.
 *
 * @param {Object} options
 * @param {string} options.key
 * @param {Buffer} options.wav Complete WAV payload from `encodeWav`.
 * @param {string=} options.baseUrl
 * @param {number=} options.timeoutMs
 * @param {{debug?:Function,info?:Function,warn?:Function}=} options.logger
 * @returns {Promise<boolean>} True when the cache holds the object afterwards.
 */
export async function storeCachedMessage({ key, wav, baseUrl, timeoutMs = DEFAULT_TIMEOUT_MS, logger = NOOP_LOGGER }) {
  const { bucket, prefix } = parseGcsPath(baseUrl || defaultFallbackMessageBaseUrl());
  const gcsObject = objectNameForKey(prefix, key);
  try {
    await withTimeout(
      storage()
        .bucket(bucket)
        .file(gcsObject)
        .save(wav, {
          resumable: false,
          contentType: 'audio/wav',
          preconditionOpts: { ifGenerationMatch: 0 },
        }),
      timeoutMs,
      'fallback message upload',
    );
    logger.info?.({ key, bucket, gcsObject, bytes: wav.length }, 'cached synthesised fallback message');
    return true;
  } catch (e) {
    if (e?.code === 412) {
      logger.debug?.({ key, bucket, gcsObject }, 'fallback message already cached by a concurrent writer');
      return true;
    }
    logger.warn?.({ e, key, bucket, gcsObject }, 'failed to cache fallback message; will re-synthesise next time');
    return false;
  }
}
