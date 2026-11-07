/**
 * Where call recordings are kept. RECORDING_STORAGE_PATH picks the back end:
 *
 *   gs://bucket[/prefix]   Google Cloud Storage (Google credentials as usual)
 *   s3://bucket[/prefix]   S3 or an S3-compatible store: S3_ENDPOINT (unset
 *                          means AWS), S3_REGION, S3_ACCESS_KEY_ID,
 *                          S3_SECRET_ACCESS_KEY, S3_FORCE_PATH_STYLE
 *   file:///directory      a local directory (share it between the workers
 *                          and the API server)
 *
 * Unset means recording is off. lib/recording/CONTRACT.md lists the files
 * that must stay in step with this one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

/**
 * @returns {{ enabled: boolean, backend?: 'gcs'|'s3'|'file', baseUrl?: string, legacyDefault?: boolean, reason?: string }}
 */
export function recordingStorageConfig(env = process.env) {
  const configured = (env.RECORDING_STORAGE_PATH || '').trim();
  if (configured) {
    const backend = configured.startsWith('gs://') ? 'gcs'
      : configured.startsWith('s3://') ? 's3'
        : configured.startsWith('file://') ? 'file'
          : null;
    if (!backend) {
      return { enabled: false, reason: 'RECORDING_STORAGE_PATH must start with gs://, s3:// or file://' };
    }
    if (backend === 's3') {
      const missing = ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((name) => !env[name]);
      if (missing.length) return { enabled: false, backend, reason: `missing ${missing.join(', ')}` };
    }
    return { enabled: true, backend, baseUrl: configured };
  }
  // Deployments made before RECORDING_STORAGE_PATH existed rely on this
  // default bucket, and they all have Google credentials. A self-hosted
  // install without them gets recording off instead of failed uploads.
  if (hasGoogleCredentials(env)) {
    return {
      enabled: true,
      backend: 'gcs',
      baseUrl: `gs://llm-voice/${env.NODE_ENV || 'development'}-recordings`,
      legacyDefault: true,
    };
  }
  return { enabled: false, reason: 'RECORDING_STORAGE_PATH is unset' };
}

function hasGoogleCredentials(env) {
  if (env.GOOGLE_APPLICATION_CREDENTIALS || env.GOOGLE_CREDENTIAL || env.K_SERVICE) return true;
  try {
    return fs.statSync('credentials/google.json').size > 0;
  } catch {
    return false;
  }
}

/** Split `scheme://bucket[/prefix]` into a bucket and a prefix that is empty or ends with '/'. */
export function parseStoragePath(baseUrl) {
  const match = /^(gs|s3):\/\/([^/]+)\/?(.*)$/.exec(baseUrl);
  if (!match) throw new Error(`not a bucket URL: ${baseUrl}`);
  let prefix = match[3];
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return { bucket: match[2], prefix };
}

/**
 * Open the configured store. Throws when recording is off, so callers check
 * recordingStorageConfig() first.
 */
const stores = new Map();

export async function openRecordingStore(env = process.env) {
  const config = recordingStorageConfig(env);
  if (!config.enabled) throw new Error(`recording storage is off: ${config.reason}`);
  // One client per store, so a GCS client keeps its auth token between calls.
  const cacheKey = [config.backend, config.baseUrl, env.S3_ENDPOINT, env.S3_ACCESS_KEY_ID].join('|');
  if (!stores.has(cacheKey)) {
    stores.set(cacheKey, config.backend === 'file' ? fileStore(config.baseUrl)
      : config.backend === 's3' ? s3Store(config.baseUrl, env)
        : gcsStore(config.baseUrl));
  }
  return stores.get(cacheKey);
}

async function gcsStore(baseUrl) {
  const { Storage } = await import('@google-cloud/storage');
  const { bucket, prefix } = parseStoragePath(baseUrl);
  const files = new Storage().bucket(bucket);
  return {
    backend: 'gcs',
    bucket,
    prefix,
    createWriteStream: (name) => files.file(name).createWriteStream({
      metadata: { contentType: 'application/octet-stream' },
      resumable: false,
    }),
    createReadStream: (name) => files.file(name).createReadStream(),
    async size(name) {
      const [metadata] = await files.file(name).getMetadata();
      return metadata?.size != null ? Number(metadata.size) : null;
    },
    async delete(name) {
      await files.file(name).delete({ ignoreNotFound: true });
    },
  };
}

function fileStore(baseUrl) {
  const root = path.resolve(new URL(baseUrl).pathname);
  const resolve = (name) => {
    const full = path.resolve(root, name);
    if (!full.startsWith(root + path.sep)) throw new Error(`recording path outside the store: ${name}`);
    return full;
  };
  return {
    backend: 'file',
    bucket: root,
    prefix: '',
    createWriteStream(name) {
      const full = resolve(name);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      return fs.createWriteStream(full, { mode: 0o600 });
    },
    createReadStream: (name) => fs.createReadStream(resolve(name)),
    async size(name) {
      return (await fs.promises.stat(resolve(name))).size;
    },
    async delete(name) {
      await fs.promises.rm(resolve(name), { force: true });
    },
  };
}

function s3Store(baseUrl, env) {
  const { bucket, prefix } = parseStoragePath(baseUrl);
  const region = env.S3_REGION || 'us-east-1';
  const endpoint = new URL(env.S3_ENDPOINT || `https://s3.${region}.amazonaws.com`);
  // Most S3-compatible stores (MinIO, Ceph) want path-style; AWS takes either.
  const pathStyle = env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE !== 'false' : Boolean(env.S3_ENDPOINT);
  const credentials = { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY, sessionToken: env.S3_SESSION_TOKEN };

  async function request(method, name, body) {
    const key = name.split('/').map(encodeURIComponent).join('/');
    const url = new URL(endpoint);
    if (pathStyle) url.pathname = `${url.pathname.replace(/\/$/, '')}/${bucket}/${key}`;
    else { url.host = `${bucket}.${url.host}`; url.pathname = `/${key}`; }
    const headers = signS3Request({ method, url, body, region, credentials });
    const response = await fetch(url, { method, headers, body });
    if (!response.ok && !(method === 'DELETE' && response.status === 404)) {
      throw new Error(`S3 ${method} ${name}: HTTP ${response.status}`);
    }
    return response;
  }

  return {
    backend: 's3',
    bucket,
    prefix,
    // Recordings are a few MB, so one PUT of the whole object is enough.
    createWriteStream(name) {
      const chunks = [];
      return new Writable({
        write(chunk, _encoding, done) { chunks.push(chunk); done(); },
        final(done) { request('PUT', name, Buffer.concat(chunks)).then(() => done(), done); },
      });
    },
    createReadStream(name) {
      const out = new Readable({ read() {} });
      request('GET', name)
        .then((response) => Readable.fromWeb(response.body).on('error', (err) => out.destroy(err)).pipe(new Writable({
          write(chunk, _e, done) { out.push(chunk); done(); },
          final(done) { out.push(null); done(); },
        })))
        .catch((err) => out.destroy(err));
      return out;
    },
    async size(name) {
      const length = (await request('HEAD', name)).headers.get('content-length');
      return length == null ? null : Number(length);
    },
    async delete(name) {
      await request('DELETE', name);
    },
  };
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * AWS Signature Version 4 headers for one S3 request with a fully hashed
 * payload. Exported for its test against the AWS documentation example.
 */
export function signS3Request({ method, url, body, region, credentials, headers = {}, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const all = {
    ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])),
    host: url.host,
    'x-amz-content-sha256': sha256(body ?? ''),
    'x-amz-date': amzDate,
    ...(credentials.sessionToken ? { 'x-amz-security-token': credentials.sessionToken } : {}),
  };
  const names = Object.keys(all).sort();
  const query = [...url.searchParams].sort().map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const canonical = [
    method, url.pathname, query,
    ...names.map((n) => `${n}:${all[n]}`), '',
    names.join(';'), all['x-amz-content-sha256'],
  ].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const signingKey = ['aws4_request'].reduce(
    (key, part) => hmac(key, part),
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, day), region), 's3'),
  );
  const signature = crypto.createHmac('sha256', signingKey).update(toSign).digest('hex');
  const { host, ...rest } = all;
  return {
    ...rest,
    authorization: `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`,
  };
}
