/**
 * Cross-language smoke test.
 *
 * Encrypts a known payload with the JS GcmEncryptStream, writes it to a
 * temp file, then shells out to the pipecat venv's Python to decrypt with
 * the sibling implementation. This proves the on-wire contract is bit-exact
 * between the two stacks — the whole point of the shared library.
 *
 * Skips automatically when the pipecat venv is not present (e.g. CI without
 * the Python toolchain installed). Local devs running the test get a real
 * end-to-end check; the unit tests in `recording-shared-lib.test.mjs` are
 * the always-on safety net.
 */
import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable, PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  GcmEncryptStream,
  GcmDecryptStream,
  deriveKey,
} from '../lib/recording/index.js';

function findPipecatPython() {
  const candidates = [
    process.env.PIPECAT_VENV_PYTHON,
    path.resolve(process.cwd(), 'agents/pipecat/.venv/bin/python'),
    // Repo-relative fallback for when tests run from a worktree.
    path.resolve(
      process.cwd(),
      '..',
      '..',
      '..',
      'agents/pipecat/.venv/bin/python',
    ),
  ].filter(Boolean);
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const PYTHON = findPipecatPython();
const describeOrSkip = PYTHON ? describe : describe.skip;

describeOrSkip('lib/recording — JS encrypt / Python decrypt (cross-language)', () => {
  test('payload encrypted in JS decrypts byte-identical in Python', async () => {
    const plaintext = Buffer.from(
      'cross-language wire-format contract — every byte must survive 🔐',
    );
    const key = deriveKey('shared-contract-key');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-xlang-'));
    const cipherPath = path.join(tmpDir, 'payload.bin');
    try {
      // JS side: encrypt + write to disk.
      const enc = new GcmEncryptStream(key);
      const sink = fs.createWriteStream(cipherPath);
      await pipeline(Readable.from([plaintext]), enc, sink);

      // Python side: read, decrypt, print plaintext on stdout.
      const pipecatRoot = path.resolve(process.cwd(), 'agents/pipecat');
      const cmd = [
        '-c',
        [
          'import os, sys',
          `sys.path.insert(0, ${JSON.stringify(pipecatRoot)})`,
          'from pipecat_aplisay.recording import GcmDecryptStream, derive_key',
          `key = derive_key('shared-contract-key')`,
          'dec = GcmDecryptStream(key)',
          'pieces = []',
          `with open(${JSON.stringify(cipherPath)}, 'rb') as f:`,
          '    while True:',
          '        chunk = f.read(7)',  // small chunks to exercise streaming
          '        if not chunk: break',
          '        out = dec.update(chunk)',
          '        if out: pieces.append(out)',
          'tail = dec.finalize()',
          'if tail: pieces.append(tail)',
          "sys.stdout.buffer.write(b''.join(pieces))",
        ].join('\n'),
      ];
      const result = spawnSync(PYTHON, cmd, { encoding: 'buffer' });
      expect(result.status).toBe(0);
      expect(Buffer.from(result.stdout).equals(plaintext)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('payload encrypted in Python decrypts byte-identical in JS', async () => {
    const plaintext = Buffer.from('python -> js direction also works');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recording-xlang-'));
    const cipherPath = path.join(tmpDir, 'payload.bin');
    try {
      const pipecatRoot = path.resolve(process.cwd(), 'agents/pipecat');
      const cmd = [
        '-c',
        [
          'import os, sys',
          `sys.path.insert(0, ${JSON.stringify(pipecatRoot)})`,
          'from pipecat_aplisay.recording import GcmEncryptStream, derive_key',
          `key = derive_key('shared-contract-key')`,
          'enc = GcmEncryptStream(key)',
          `payload = ${JSON.stringify(plaintext.toString('utf8'))}.encode('utf-8')`,
          'pieces = []',
          'half = len(payload) // 2',
          'for chunk in (payload[:half], payload[half:]):',
          '    out = enc.update(chunk)',
          '    if out: pieces.append(out)',
          'pieces.append(enc.finalize())',
          `with open(${JSON.stringify(cipherPath)}, 'wb') as f:`,
          `    f.write(b''.join(pieces))`,
        ].join('\n'),
      ];
      const result = spawnSync(PYTHON, cmd, { encoding: 'utf8' });
      expect(result.status).toBe(0);

      const key = deriveKey('shared-contract-key');
      const dec = new GcmDecryptStream(key);
      const sink = new PassThrough();
      const parts = [];
      sink.on('data', (c) => parts.push(c));
      await pipeline(fs.createReadStream(cipherPath), dec, sink);
      expect(Buffer.concat(parts).equals(plaintext)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
