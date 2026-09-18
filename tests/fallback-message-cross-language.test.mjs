/**
 * Cross-language contract test for the fallback-message cache.
 *
 * Both runtimes read and write the *same* GCS objects, so two things must agree
 * exactly or the cache silently splits in two — each stack re-synthesising what
 * the other already paid for, with no error to notice:
 *
 *   1. the cache key derived from a given message, and
 *   2. the WAV encoding of a given PCM buffer.
 *
 * These are cheap to get subtly wrong (JSON separator spacing, non-ASCII
 * escaping, RIFF field widths), which is exactly why they are pinned here
 * rather than left to inspection. See lib/fallback-message/CONTRACT.md.
 *
 * Skips automatically when the pipecat venv is absent (e.g. CI without the
 * Python toolchain); `fallback-message-shared-lib.test.mjs` is the always-on
 * safety net for the JS half.
 */
import { describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  decodeWav,
  encodeWav,
  fallbackMessageKey,
  resolveFallbackMessage,
} from '../lib/fallback-message/index.js';

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

/**
 * Message shapes chosen to exercise the encodings most likely to diverge, plus
 * the realtime-agent inheritance rule — a disagreement there would split the
 * cache just as silently as a hashing difference.
 *
 * Each case is `[message, agentOptions, inheritAgentTts]`.
 */
const CASES = [
  [{ text: 'Sorry, we are busy.' }, {}, true],
  // Non-ASCII: Python's json defaults to \u-escaping where JS does not.
  [
    { text: 'Désolé, nous sommes occupés — rappelez plus tard.', vendor: 'elevenlabs', voice: 'Rachel' },
    {},
    true,
  ],
  // Astral-plane codepoint (surrogate pair in JS, single codepoint in Python).
  [{ text: 'busy 🙂' }, { tts: { vendor: 'deepgram/aura-2', voice: 'thalia', language: 'en-US' } }, true],
  // Minimal form (text only) plus inheritance from agent options.
  [{ text: 'text only, inherits the agent voice' }, { tts: { voice: 'Dominus' } }, true],
  // Empty-vs-absent fields must hash the same way on both sides.
  [{ text: 'no voice configured' }, {}, true],
  // Realtime agent: the model's own voice must be dropped on both sides, and
  // the surviving language must still be hashed identically.
  [
    { text: 'realtime, no override' },
    { tts: { vendor: 'ultravox', voice: 'Svetlana', language: 'en-GB' } },
    false,
  ],
  // Realtime agent with an explicit TTS — the configuration that makes the
  // feature usable at all for a speech-to-speech model.
  [
    { text: 'realtime, elevenlabs override', vendor: 'elevenlabs', voice: 'Rachel' },
    { tts: { vendor: 'ultravox', voice: 'Svetlana', language: 'en-GB' } },
    false,
  ],
];

function runPython(script) {
  const result = spawnSync(PYTHON, ['-c', script], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`python failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

describeOrSkip('lib/fallback-message — JS / Python cross-language contract', () => {
  test('both runtimes derive the same cache key for every message shape', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-msg-xlang-'));
    const casesPath = path.join(tmpDir, 'cases.json');
    try {
      fs.writeFileSync(casesPath, JSON.stringify(CASES));
      const pythonKeys = JSON.parse(
        runPython(
          [
            'import json, sys',
            `sys.path.insert(0, ${JSON.stringify(PIPECAT_ROOT)})`,
            'from pipecat_aplisay.fallback_message import resolve_fallback_message, fallback_message_key',
            `cases = json.load(open(${JSON.stringify(casesPath)}))`,
            'print(json.dumps([fallback_message_key(resolve_fallback_message(m, o, inherit_agent_tts=i)) for m, o, i in cases]))',
          ].join('\n'),
        ).split('\n').pop(),
      );
      const jsKeys = CASES.map(([m, o, i]) =>
        fallbackMessageKey(resolveFallbackMessage(m, o, { inheritAgentTts: i })),
      );
      expect(pythonKeys).toEqual(jsKeys);
      // Guard against the degenerate pass where both sides return the same
      // constant for everything.
      expect(new Set(jsKeys).size).toBe(CASES.length);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('a WAV written in Python decodes in JS, and re-encodes byte-identically', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-msg-wav-'));
    const wavPath = path.join(tmpDir, 'fixture.wav');
    try {
      runPython(
        [
          'import sys',
          `sys.path.insert(0, ${JSON.stringify(PIPECAT_ROOT)})`,
          'from pipecat_aplisay.fallback_message import encode_wav',
          "pcm = b'\\xd2\\x04' + bytes(316) + b'\\xbf\\xef'",
          `open(${JSON.stringify(wavPath)}, 'wb').write(encode_wav(pcm, 24000))`,
        ].join('\n'),
      );
      const raw = fs.readFileSync(wavPath);
      const decoded = decodeWav(raw);
      expect(decoded.sampleRate).toBe(24000);
      expect(decoded.pcm.length).toBe(320);
      // Byte-identical re-encode proves the header layout matches, not merely
      // that each side can read its own output.
      expect(encodeWav(decoded.pcm, decoded.sampleRate).equals(raw)).toBe(true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('a WAV written in JS decodes in Python with the same samples and rate', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fallback-msg-wav-js-'));
    const wavPath = path.join(tmpDir, 'fixture.wav');
    try {
      const pcm = Buffer.alloc(480);
      pcm.writeInt16LE(999, 0);
      pcm.writeInt16LE(-999, 478);
      fs.writeFileSync(wavPath, encodeWav(pcm, 16000));
      const out = runPython(
        [
          'import sys',
          `sys.path.insert(0, ${JSON.stringify(PIPECAT_ROOT)})`,
          'from pipecat_aplisay.fallback_message import decode_wav',
          `d = decode_wav(open(${JSON.stringify(wavPath)}, 'rb').read())`,
          'print(d.sample_rate, len(d.pcm), int.from_bytes(d.pcm[0:2], "little", signed=True))',
        ].join('\n'),
      ).split('\n').pop();
      expect(out).toBe('16000 480 999');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
