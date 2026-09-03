/**
 * The LiveKit worker reaches shared `lib/` code through `agents/livekit/agent-lib/`. Single files
 * there may be symlinks: the image build (`agents/livekit/Dockerfile`) does `COPY lib/* ./agent-lib/`,
 * which lands a real file over each of them. A shared DIRECTORY cannot be a symlink, though: that COPY
 * flattens a directory's contents into `agent-lib/` and leaves the directory symlink dangling, GNU
 * `cp -rp` in the tsup `onSuccess` step copies it into `dist/` still dangling, and the worker then
 * crash-loops at module load (`ERR_MODULE_NOT_FOUND …/dist/agent-lib/<dir>/index.js`) — exactly what
 * took out the staging runner on 2026-09-03 with `agent-lib/fallback-message`. macOS `cp` follows the
 * link, so a local build never shows it. Shared directories are therefore committed as real copies
 * (the `recording/` precedent) and this test keeps them byte-identical to their `lib/` source.
 */
import { describe, expect, test } from '@jest/globals';
import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const LIB = new URL('../lib/', import.meta.url).pathname;
const LIVEKIT = new URL('../agents/livekit/', import.meta.url).pathname;
const AGENT_LIB = join(LIVEKIT, 'agent-lib');

/** Every `agent-lib/<dir>/…` directory the worker's own sources import (TypeScript under agents/livekit). */
function importedAgentLibDirectories() {
  const dirs = new Set();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'agent-lib') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(entry.name)) {
        for (const m of readFileSync(path, 'utf8').matchAll(/agent-lib\/([A-Za-z0-9_.-]+)\//g)) dirs.add(m[1]);
      }
    }
  };
  walk(LIVEKIT);
  return [...dirs].sort();
}

const imported = importedAgentLibDirectories();

describe('agents/livekit/agent-lib shared directories the worker imports', () => {
  test('the known ones are still imported (guards the test itself)', () => {
    expect(imported).toEqual(expect.arrayContaining(['recording', 'fallback-message']));
  });

  test.each(imported)('agent-lib/%s is a real directory, not a symlink (the image build cannot follow one)', (name) => {
    expect(lstatSync(join(AGENT_LIB, name)).isSymbolicLink()).toBe(false);
    expect(statSync(join(AGENT_LIB, name)).isDirectory()).toBe(true);
  });

  test.each(imported)('agent-lib/%s is a byte-identical copy of lib/%s (code files)', (name) => {
    const codeFiles = (dir) =>
      readdirSync(dir)
        .filter((f) => /\.(js|d\.ts)$/.test(f))
        .sort();
    const source = codeFiles(join(LIB, name));
    const copy = codeFiles(join(AGENT_LIB, name));
    expect(copy).toEqual(source);
    for (const file of source) {
      expect(readFileSync(join(AGENT_LIB, name, file), 'utf8')).toBe(readFileSync(join(LIB, name, file), 'utf8'));
    }
  });
});
