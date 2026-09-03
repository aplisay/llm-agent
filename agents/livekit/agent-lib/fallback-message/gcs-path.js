/**
 * GCS path helpers for the fallback-message cache.
 *
 * Sibling of `lib/recording/gcs-path.js` and deliberately shaped the same way:
 * exactly one formula for where a cached announcement lands, shared by every
 * runtime that reads or writes one.
 *
 * The cache lives in the same platform-owned bucket as call recordings, under
 * its own prefix. That bucket is already provisioned, credentialed, and
 * lifecycle-managed on every deployment, so the cache inherits all of it
 * without new infrastructure.
 *
 * Unlike recordings, cached announcements are stored unencrypted. A recording
 * is customer conversation audio, sometimes under a key we do not hold; an
 * announcement is a rendering of `options.fallback.message.text`, which sits
 * in clear in the database, so encrypting it would protect nothing. It would
 * also cost CPU precisely where we can least afford it — this path runs after
 * an agent session has failed, and heavy load is one of the likelier reasons
 * for that, so playout is disproportionately likely to happen when the machine
 * is already struggling. Keep it a download, a resample, and a write.
 */

/**
 * @typedef {Object} GcsPath
 * @property {string} bucket
 * @property {string} prefix Always empty or ending with a single trailing slash.
 */

export { parseGcsPath } from '../recording/gcs-path.js';

/**
 * Default base URL for the fallback-message cache.
 *
 * Derived from `RECORDING_STORAGE_PATH`'s bucket when set so that a deployment
 * which has already pointed recordings at its own bucket does not silently
 * keep writing announcements to the default one. Falls back to the same
 * `gs://llm-voice` default the recording path uses.
 *
 * @returns {string}
 */
export function defaultFallbackMessageBaseUrl() {
  const { FALLBACK_MESSAGE_STORAGE_PATH, RECORDING_STORAGE_PATH, NODE_ENV } = process.env;
  if (FALLBACK_MESSAGE_STORAGE_PATH) {
    return FALLBACK_MESSAGE_STORAGE_PATH;
  }
  const env = NODE_ENV || 'development';
  if (RECORDING_STORAGE_PATH) {
    // Reuse the configured bucket, but never the recordings prefix itself.
    const withoutScheme = RECORDING_STORAGE_PATH.slice('gs://'.length);
    const bucket = withoutScheme.split('/')[0];
    return `gs://${bucket}/${env}-fallback-messages`;
  }
  return `gs://llm-voice/${env}-fallback-messages`;
}

/**
 * Build the GCS object name for a cache key. Cached announcements are always
 * mono 16 kHz PCM in a WAV container — see `wav.js`.
 *
 * @param {string} prefix Empty string or trailing-slash prefix from `parseGcsPath`.
 * @param {string} key Digest from `fallbackMessageKey`.
 * @returns {string}
 */
export function objectNameForKey(prefix, key) {
  return `${prefix}${key}.wav`;
}
