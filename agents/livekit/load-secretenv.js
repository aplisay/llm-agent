// Emit only shell exports on stdout: entrypoint.sh evaluates them. See
// agents/livekit/deploy/gcp/README.md; diagnostics belong on stderr.
import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

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

const supplied = Boolean(process.env.SECRETENV_KEY && process.env.SECRETENV_BUNDLE);
if (supplied) {
  log('SECRETENV_KEY/_BUNDLE already in the environment — skipping Secret Manager');
} else {
  const { key, bundle } = await fetchPair();
  process.env.SECRETENV_KEY = key;
  process.env.SECRETENV_BUNDLE = bundle;
}

// Only the pair crosses back to the shell; everything else the agent decrypts
// for itself. Nothing to export when it was already in the environment.
if (!supplied) {
  const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  process.stdout.write(`export SECRETENV_KEY=${shQuote(process.env.SECRETENV_KEY)}\n`);
  process.stdout.write(`export SECRETENV_BUNDLE=${shQuote(process.env.SECRETENV_BUNDLE)}\n`);
}
