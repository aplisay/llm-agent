/**
 * GCS path helpers shared by every agent that uploads recordings and by the
 * REST download endpoint. Keeping these here means there is exactly one
 * formula for the bucket / object name a recording lands at.
 */

/**
 * @typedef {Object} GcsPath
 * @property {string} bucket
 * @property {string} prefix Always empty or ending with a single trailing slash.
 */

/**
 * Parse a `gs://bucket[/prefix]` URL into `{ bucket, prefix }`.
 *
 * @param {string} baseUrl
 * @returns {GcsPath}
 */
export function parseGcsPath(baseUrl) {
  if (!baseUrl.startsWith('gs://')) {
    throw new Error('Recording storage path must be a gs:// URL');
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

/**
 * Default base URL used when `RECORDING_STORAGE_PATH` is unset. Mirrors the
 * historical LiveKit default so a fresh deploy without explicit configuration
 * keeps working.
 *
 * @returns {string}
 */
export function defaultRecordingBaseUrl() {
  const { RECORDING_STORAGE_PATH, NODE_ENV } = process.env;
  return (
    RECORDING_STORAGE_PATH || `gs://llm-voice/${NODE_ENV || 'development'}-recordings`
  );
}

/**
 * Build the GCS object name for a given call. Recordings are always OGG.
 *
 * @param {string} prefix Empty string or trailing-slash prefix from {@link parseGcsPath}.
 * @param {string} callId
 * @returns {string}
 */
export function objectNameFor(prefix, callId) {
  return `${prefix}${callId}.ogg`;
}
