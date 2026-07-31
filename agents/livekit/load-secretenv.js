// load-secretenv.js — everything the container needs to have secrets before
// the agent starts. Run by entrypoint.sh, which `eval`s its stdout.
//
// Two jobs:
//
//   1. Put SECRETENV_KEY / SECRETENV_BUNDLE in the environment, reading them
//      from Google Secret Manager when they are not already there. Same client
//      library and the same `${GOOGLE_SECRETENV_PATH}_{KEY,BUNDLE}/versions/latest`
//      resource names as aplisay-sbc/google-secret-helper.js. Credentials come
//      from ADC — on a GCE VM the instance's own service account, which needs
//      roles/secretmanager.secretAccessor on both secrets and the
//      cloud-platform OAuth scope.
//
//   2. Materialise the Google service-account JSON at the path the bundle's
//      GOOGLE_APPLICATION_CREDENTIALS names. The google-cloud-storage client
//      used for recording uploads authenticates via ADC, i.e. it opens that
//      *file*. The image used to bake it at build time
//      (`npx secretenv -r GOOGLE_CREDENTIAL > credentials/google.json`), which
//      put a live service-account private key in a registry layer; this is the
//      runtime equivalent, and the direct analogue of
//      agents/pipecat/pipecat_aplisay/secretenv.py::_materialise_google_credential.
//
// Decrypting the bundle here is only in service of (2) — the agent decrypts it
// again for itself, through its `dotenv` dependency (aliased to
// github:rjp44/secretenv). The pair leaves this process on stdout and nothing
// else is written anywhere except that one credential file.
//
// Diagnostics go to stderr, so stdout carries only the export lines.
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const ATTEMPTS = Math.max(1, Number(process.env.SECRETENV_FETCH_ATTEMPTS || 3));

const log = (msg) => process.stderr.write(`load-secretenv: ${msg}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function accessSecret(client, name) {
  const [version] = await client.accessSecretVersion({ name: `${name}/versions/latest` });
  const data = version.payload?.data;
  if (!data) throw new Error(`${name}: version carried no payload.data`);
  // Trailing newlines creep in when a secret is published by hand, and would
  // corrupt the base64 that secretenv expects.
  return Buffer.from(data).toString('utf8').trim();
}

async function fetchPair() {
  const base = (process.env.GOOGLE_SECRETENV_PATH || '').trim().replace(/\/+$/, '');
  if (!/^projects\/[^/]+\/secrets\/[A-Za-z0-9_-]+$/.test(base)) {
    log(`GOOGLE_SECRETENV_PATH is not a secret resource path: ${base || '(unset)'}`);
    log('expected projects/<project-number>/secrets/<SECRET_BASE_NAME>');
    process.exit(2);
  }

  const client = new SecretManagerServiceClient();

  // The library retries transient RPC failures itself; this outer loop is for
  // the reboot case, where docker can start before the metadata server is
  // answering and ADC fails outright.
  for (let attempt = 1; ; attempt++) {
    try {
      const [key, bundle] = await Promise.all([
        accessSecret(client, `${base}_KEY`),
        accessSecret(client, `${base}_BUNDLE`),
      ]);
      if (!key || !bundle) throw new Error(`empty payload (key ${key.length}b, bundle ${bundle.length}b)`);
      log(`loaded ${base}_{KEY,BUNDLE} (${key.length}b key, ${bundle.length}b bundle)`);
      return { key, bundle };
    } catch (err) {
      if (attempt >= ATTEMPTS) {
        log(`FAILED to read ${base}_{KEY,BUNDLE}: ${err.message}`);
        log('the VM needs the cloud-platform OAuth scope and roles/secretmanager.secretAccessor on both secrets');
        process.exit(1);
      }
      log(`${err.message} — retrying in ${attempt}s [${attempt}/${ATTEMPTS - 1}]`);
      await sleep(attempt * 1000);
    }
  }
}

// Best-effort and idempotent, like the pipecat implementation: a no-op when the
// path is unset, the source secret is absent, or something already exists at
// the path (a mounted secret, say). Never fatal — a missing credential costs
// recording uploads, and refusing to boot over it would cost every call.
function materialiseGoogleCredential(env) {
  const path = env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) return;
  // GOOGLE_CREDENTIAL is the JSON payload the Node images have always written;
  // GOOGLE_APPLICATION_CREDENTIALS_JSON is the inline form pipecat also takes.
  const content = env.GOOGLE_CREDENTIAL || env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!content) {
    log(`GOOGLE_APPLICATION_CREDENTIALS=${path} but the bundle has no GOOGLE_CREDENTIAL — not writing it`);
    return;
  }
  if (existsSync(path)) {
    log(`Google credential already present at ${path} — leaving it alone`);
    return;
  }
  try {
    const dir = dirname(path);
    if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
    // 0600 — this is a service-account private key.
    writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 });
    log(`materialised Google credential at ${path} (${content.length}b)`);
  } catch (err) {
    log(`WARNING: could not write the Google credential to ${path}: ${err.message}`);
  }
}

const supplied = Boolean(process.env.SECRETENV_KEY && process.env.SECRETENV_BUNDLE);
if (supplied) {
  log('SECRETENV_KEY/_BUNDLE already in the environment — skipping Secret Manager');
} else {
  const { key, bundle } = await fetchPair();
  process.env.SECRETENV_KEY = key;
  process.env.SECRETENV_BUNDLE = bundle;
}

// Decrypt in-process purely so the credential above can be written. `dotenv` is
// aliased to secretenv, so config() expands SECRETENV_BUNDLE into process.env.
try {
  const dotenv = (await import('dotenv')).default;
  dotenv.config();
  materialiseGoogleCredential(process.env);
} catch (err) {
  log(`WARNING: could not decrypt the bundle to materialise credentials: ${err.message}`);
}

// Only the pair crosses back to the shell; everything else the agent decrypts
// for itself. Nothing to export when it was already in the environment.
if (!supplied) {
  const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  process.stdout.write(`export SECRETENV_KEY=${shQuote(process.env.SECRETENV_KEY)}\n`);
  process.stdout.write(`export SECRETENV_BUNDLE=${shQuote(process.env.SECRETENV_BUNDLE)}\n`);
}
