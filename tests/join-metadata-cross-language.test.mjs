/**
 * Cross-language contract test for sealed WebRTC join metadata.
 *
 * The API seals a join's options.metadata into the Pipecat join token with
 * lib/join-metadata.js; the Pipecat worker opens it with
 * agents/pipecat/pipecat_aplisay/join_metadata.py. If the key derivation or the
 * wire format drifts, the worker cannot open the value, logs an error and the
 * call goes on without its metadata, so the mismatch would show only as tools
 * missing a metadata value.
 *
 * Skips automatically when the pipecat venv is absent (e.g. CI without the
 * Python toolchain); pipecat-join-metadata.test.mjs is the always-on safety net
 * for the JS half.
 */
import { afterAll, describe, expect, jest, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SECRET = 'test-pipecat-join-secret-0123456789';
const INSTANCE_ID = 'dc5e7c37-e644-45d3-80ec-12292dc1ea70';
const ENV = { PIPECAT_JOIN_SECRET: SECRET, PIPECAT_PUBLIC_URL: 'https://pipecat.test' };
const savedEnv = Object.fromEntries(Object.keys(ENV).map((name) => [name, process.env[name]]));
Object.assign(process.env, ENV);

// The handler module reads PIPECAT_* when it loads. These stand-ins keep the
// load from fetching voice lists or opening the database.
jest.unstable_mockModule('../lib/handlers/handler.js', () => ({
  default: class Handler {
    constructor({ instance, logger }) {
      Object.assign(this, { instance, logger });
    }
  },
}));
jest.unstable_mockModule('../lib/handlers/ultravox.js', () => ({ default: { voices: Promise.resolve({}) } }));
jest.unstable_mockModule('../lib/models/xai.js', () => ({ default: { voices: Promise.resolve({}) } }));
jest.unstable_mockModule('../lib/models/pipecat.js', () => ({ default: class PipecatModel {} }));
jest.unstable_mockModule('../lib/database.js', () => ({ Call: {} }));
jest.unstable_mockModule('../lib/concurrency/agent-concurrency-limits.js', () => ({
  AgentConcurrencyLimitExceededError: class extends Error {},
}));

const { default: Pipecat } = await import('../lib/handlers/pipecat.js');
const { JOIN_METADATA_KEY_INFO, sealJoinMetadata } = await import('../lib/join-metadata.js');

function findPipecatPython() {
  const candidates = [
    process.env.PIPECAT_VENV_PYTHON,
    path.resolve(process.cwd(), 'agents/pipecat/.venv/bin/python'),
    // Repo-relative fallback for when tests run from a worktree.
    path.resolve(process.cwd(), '..', '..', 'agents/pipecat/.venv/bin/python'),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const PYTHON = findPipecatPython();
const describeOrSkip = PYTHON ? describe : describe.skip;
const PIPECAT_ROOT = path.resolve(process.cwd(), 'agents/pipecat');

// Shapes most likely to diverge between the two JSON codecs: non-ASCII,
// astral-plane codepoints, nesting, numbers, booleans and null.
const METADATA = {
  simplyai: { agent_key: 'ak-123' },
  crm: { tier: 'gold', score: 42.5, active: true, notes: null },
  name: 'Désolé — rappelez plus tard 🙂',
  tags: ['a', 'b'],
};

const logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Run a Python snippet that reads `input.json` and prints one JSON line. */
function runPython(lines, input) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'join-metadata-xlang-'));
  const inputPath = path.join(tmpDir, 'input.json');
  try {
    fs.writeFileSync(inputPath, JSON.stringify(input));
    const script = [
      'import json, sys',
      `sys.path.insert(0, ${JSON.stringify(PIPECAT_ROOT)})`,
      `data = json.load(open(${JSON.stringify(inputPath)}))`,
      ...lines,
    ].join('\n');
    const result = spawnSync(PYTHON, ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PIPECAT_JOIN_SECRET: SECRET },
    });
    if (result.status !== 0) {
      throw new Error(`python failed: ${result.stderr || result.stdout}`);
    }
    return JSON.parse(result.stdout.trim().split('\n').pop());
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

afterAll(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describeOrSkip('sealed join metadata: JS / Python cross-language contract', () => {
  test('the worker opens the metadata in a join token the API minted', async () => {
    const handler = new Pipecat({ instance: { id: INSTANCE_ID }, logger });
    const { pipecat } = await handler.join({ options: { metadata: METADATA } });
    const token = new URL(pipecat.offerUrl).searchParams.get('token');
    const opened = runPython(
      [
        'from pipecat_aplisay.auth import verify_join_token',
        'from pipecat_aplisay.join_metadata import open_join_metadata',
        'payload = verify_join_token(data["token"])',
        'print(json.dumps(open_join_metadata(payload.sealed_call_metadata, data["secret"])))',
      ],
      { token, secret: SECRET },
    );
    expect(opened).toEqual(METADATA);
  });

  test('the worker does not open a value sealed with the LiveKit label', () => {
    const outcome = runPython(
      [
        'from pipecat_aplisay.join_metadata import open_join_metadata',
        'try:',
        '    open_join_metadata(data["sealed"], data["secret"])',
        '    print(json.dumps("opened"))',
        'except Exception as e:',
        '    print(json.dumps(type(e).__name__))',
      ],
      { sealed: sealJoinMetadata(METADATA, SECRET, JOIN_METADATA_KEY_INFO.livekit), secret: SECRET },
    );
    expect(outcome).toBe('InvalidTag');
  });
});
