/**
 * Export the platform voices of one API server as JSON, or import such a file
 * into another (docs/custom-voices.md). REST only: each server needs the API key
 * of a caller with `voice:managePlatform`.
 *
 *   node scripts/platform-voices.mjs export --api <url> --key <key> > voices.json
 *   node scripts/platform-voices.mjs import voices.json --api <url> --key <key> [--only <name>]
 *   node scripts/platform-voices.mjs import voices.json --api <url> --key <key> --adopt --source-key <key> [--only <name>]
 *
 * export   writes every ready platform voice of --api to stdout.
 * import   creates each voice in --api from its prompt and waits for it to be
 *          ready or failed. A voice whose name is already a platform voice there
 *          is skipped, so a re-run is safe. Withdrawn voices are skipped.
 * --adopt  registers each voice's vendor voice id in --api instead of making a
 *          new voice, then releases the voice on the server it was exported from
 *          (needs --source-key). A voice --api already has by vendor voice id is
 *          only released on the source.
 * --only   imports the one voice with this name.
 *
 * --key and --source-key can also come from PLATFORM_VOICES_KEY and
 * PLATFORM_VOICES_SOURCE_KEY.
 */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const USAGE = `Usage:
  node scripts/platform-voices.mjs export --api <url> --key <key>
  node scripts/platform-voices.mjs import <file> --api <url> --key <key> [--only <name>]
  node scripts/platform-voices.mjs import <file> --api <url> --key <key> --adopt --source-key <key> [--only <name>]

  export          Write the ready platform voices of --api to stdout as JSON.
  import <file>   Create each voice of <file> in --api from its prompt, and wait
                  until it is ready or failed. Names that are already platform
                  voices in --api, and withdrawn voices, are skipped.
  --api <url>     The API server, e.g. https://llm-agent.example.com.
  --key <key>     API key with voice:managePlatform on --api (or PLATFORM_VOICES_KEY).
  --adopt         Register each voice's vendor voice id in --api instead of
                  creating it, then release it on the server in <file>.
  --source-key    API key with voice:managePlatform on that server (or
                  PLATFORM_VOICES_SOURCE_KEY). Needed with --adopt.
  --only <name>   Import only the voice with this name.
  --help          Show this text.`;

const DONE = new Set(['ready', 'failed']);

export function parseArgs(argv, env = process.env) {
  const opts = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--adopt') opts.adopt = true;
    else if (a === '--api') opts.api = value();
    else if (a === '--key') opts.key = value();
    else if (a === '--source-key') opts.sourceKey = value();
    else if (a === '--only') opts.only = value();
    else if (a.startsWith('--')) throw new Error(`Unknown option ${a}`);
    else opts.positional.push(a);
  }
  opts.command = opts.positional[0];
  opts.file = opts.positional[1];
  opts.key ??= env.PLATFORM_VOICES_KEY;
  opts.sourceKey ??= env.PLATFORM_VOICES_SOURCE_KEY;
  return opts;
}

/** The server's base URL, without a trailing `/api`. */
export function baseUrl(api) {
  return String(api).replace(/\/+$/, '').replace(/\/api$/, '');
}

function client(api, key, fetchImpl) {
  const base = baseUrl(api);
  return async (method, path, body) => {
    const res = await fetchImpl(`${base}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, body: json };
  };
}

function failure(what, res) {
  return new Error(`${what}: HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
}

async function platformVoices(call) {
  const res = await call('GET', '/voices/custom?visibility=platform');
  if (!res.ok) throw failure('listing platform voices', res);
  return res.body.voices || [];
}

export async function exportVoices({ api, key, fetchImpl = fetch, now = () => new Date() }) {
  const call = client(api, key, fetchImpl);
  const voices = (await platformVoices(call)).filter((v) => v.status === 'ready');
  return {
    source: baseUrl(api),
    exportedAt: now().toISOString(),
    voices: voices.map((v) => ({
      id: v.id,
      name: v.name,
      description: v.description ?? null,
      prompt: v.prompt,
      scriptHint: v.scriptHint ?? null,
      gender: v.gender ?? null,
      locale: v.locale,
      vendor: v.vendor,
      method: v.method,
      models: v.models || [],
      vendorVoiceId: v.voice,
      withdrawn: Boolean(v.withdrawnAt),
      ownership: v.ownership?.state ?? 'owner',
    })),
  };
}

async function waitForVoice(call, id, { sleep, pollMs, timeoutMs }) {
  const started = Date.now();
  for (;;) {
    const res = await call('GET', `/voices/custom/${id}`);
    if (!res.ok) throw failure(`reading voice ${id}`, res);
    if (DONE.has(res.body.status)) return res.body;
    if (Date.now() - started > timeoutMs) return res.body;
    await sleep(pollMs);
  }
}

/**
 * Import `data` (an export) into `api`. Resolves to a summary; `failed` is the
 * number of voices that did not end up there.
 */
export async function importVoices({
  data, api, key, adopt = false, sourceKey, only,
  fetchImpl = fetch, log = console.error, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  pollMs = 3000, timeoutMs = 180_000,
}) {
  const call = client(api, key, fetchImpl);
  const target = baseUrl(api);
  const source = data?.source ? baseUrl(data.source) : null;
  if (adopt && (!source || !sourceKey)) throw new Error('--adopt needs --source-key, and a file with its source');
  const sourceCall = adopt ? client(source, sourceKey, fetchImpl) : null;

  let voices = data?.voices || [];
  if (only !== undefined) {
    voices = voices.filter((v) => v.name === only);
    if (!voices.length) throw new Error(`No voice named ${only} in the file`);
  }

  // Every voice needs a model the target serves before anything is created.
  const models = await call('GET', '/models');
  if (!models.ok) throw failure('listing models', models);
  const served = new Set(Object.keys(models.body || {}));
  const modelFor = new Map();
  const missing = [];
  for (const v of voices) {
    const model = (v.models || []).find((m) => served.has(m));
    if (model) modelFor.set(v, model);
    else missing.push(`${v.name} (${(v.models || []).join(', ') || 'no models'})`);
  }
  if (missing.length) throw new Error(`${target} serves no model for: ${missing.join('; ')}`);

  const existing = (await platformVoices(call)).filter((v) => v.status !== 'deleted');
  const byName = new Map(existing.map((v) => [v.name, v]));
  const byVendorId = new Map(existing.filter((v) => v.voice).map((v) => [v.voice, v]));
  const summary = { created: 0, adopted: 0, released: 0, skipped: 0, failed: 0 };

  const release = async (v) => {
    const res = await sourceCall('PATCH', `/voices/custom/${v.id}`, { release: { to: target } });
    if (!res.ok) {
      log(`${v.name}: not released on ${source}: ${failure('release', res).message}. Run again to retry.`);
      summary.failed += 1;
      return;
    }
    log(`${v.name}: released on ${source}`);
    summary.released += 1;
  };

  for (const v of voices) {
    const model = modelFor.get(v);
    if (adopt) {
      if (v.ownership === 'released') {
        log(`${v.name}: skipped, already released on the source`);
        summary.skipped += 1;
        continue;
      }
      const held = byVendorId.get(v.vendorVoiceId);
      if (held) {
        if (held.ownership?.state === 'released') {
          log(`${v.name}: skipped, ${target} has ${v.vendorVoiceId} but has released it`);
          summary.skipped += 1;
        }
        else {
          log(`${v.name}: ${target} already has ${v.vendorVoiceId}`);
          await release(v);
        }
        continue;
      }
    }
    if (v.withdrawn) {
      log(`${v.name}: skipped, withdrawn on the source`);
      summary.skipped += 1;
      continue;
    }
    if (byName.has(v.name)) {
      log(`${v.name}: skipped, already a platform voice in ${target}`);
      summary.skipped += 1;
      continue;
    }
    const body = {
      visibility: 'platform',
      name: v.name,
      ...(v.description ? { description: v.description } : {}),
      prompt: v.prompt,
      ...(v.scriptHint ? { scriptHint: v.scriptHint } : {}),
      ...(v.gender ? { gender: v.gender } : {}),
      ...(v.vendor ? { vendor: v.vendor } : {}),
      ...(adopt ? { vendorVoiceId: v.vendorVoiceId, ...(source ? { adoptedFrom: source } : {}) } : {}),
    };
    const res = await call('POST', `/models/${encodeURIComponent(model)}/voices/${encodeURIComponent(v.locale)}`, body);
    if (!res.ok) {
      if (res.body?.code === 'vendor_voice_not_found') {
        log(`${v.name}: ${target} cannot use ${v.vendorVoiceId} with its vendor key; import without --adopt to create it again`);
      }
      else log(`${v.name}: ${failure('create', res).message}`);
      summary.failed += 1;
      continue;
    }
    byName.set(v.name, res.body);
    if (adopt) {
      log(`${v.name}: adopted as ${res.body.id}`);
      summary.adopted += 1;
      await release(v);
      continue;
    }
    const voice = await waitForVoice(call, res.body.id, { sleep, pollMs, timeoutMs });
    if (voice.status === 'ready') {
      log(`${v.name}: created as ${voice.id} (${voice.voice})`);
      summary.created += 1;
    }
    else {
      log(`${v.name}: ${voice.status}${voice.error ? `: ${voice.error}` : ''}`);
      summary.failed += 1;
    }
  }
  log(`created ${summary.created}, adopted ${summary.adopted}, released ${summary.released}, skipped ${summary.skipped}, failed ${summary.failed}`);
  return summary;
}

export async function main(argv = process.argv.slice(2), { fetchImpl = fetch, stdout = process.stdout, log = console.error, env = process.env, ...rest } = {}) {
  let opts;
  try {
    opts = parseArgs(argv, env);
  }
  catch (err) {
    log(`${err.message}\n\n${USAGE}`);
    return 2;
  }
  if (opts.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (!['export', 'import'].includes(opts.command) || !opts.api || !opts.key || (opts.command === 'import' && !opts.file)) {
    log(USAGE);
    return 2;
  }
  try {
    if (opts.command === 'export') {
      const data = await exportVoices({ api: opts.api, key: opts.key, fetchImpl });
      stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      log(`${data.voices.length} platform voice(s) exported`);
      return 0;
    }
    const data = JSON.parse(await readFile(opts.file, 'utf8'));
    const summary = await importVoices({
      data, api: opts.api, key: opts.key, adopt: opts.adopt, sourceKey: opts.sourceKey, only: opts.only, fetchImpl, log, ...rest,
    });
    return summary.failed ? 1 : 0;
  }
  catch (err) {
    log(err.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
