import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// The boot contract: NOTHING index.mjs imports statically may need the
// environment, because `dotenv.config()` runs in index.mjs's BODY and every
// static import is evaluated before that. In the containers `dotenv.config()`
// is what decodes SECRETENV_BUNDLE, so until it runs the environment really is
// empty — an import that reads process.env at module scope sees nothing.
//
// lib/database.js is the one that bites: it builds its Sequelize instance and
// pg-listen connection string from POSTGRES_* at module evaluation, so
// importing it early exits the process with `TypeError: Invalid URL` before it
// can listen. That is not hypothetical — it shipped, and llm-agent failed to
// start from 61645b7 until it was fixed. lib/ws-handler.js documents the same
// trap and imports text-chat lazily to avoid it.
//
// Every module that needs the environment must therefore be imported
// DYNAMICALLY, after dotenv.config().

/** The specifiers index.mjs imports statically, in source order. */
function staticImportsOfIndex() {
  const src = readFileSync(join(repoRoot, 'index.mjs'), 'utf8');
  // Only top-level `import ... from '...'` lines; `await import()` is exactly
  // what this test is checking people use instead, so it must not match.
  return [...src.matchAll(/^import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
}

/**
 * Import one specifier in a child process with a scrubbed environment, the way
 * the container starts. Returns null on success, or the failure output.
 */
function importWithEmptyEnv(specifier) {
  try {
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(specifier)})`],
      {
        cwd: repoRoot,
        // PATH and HOME only: enough for node to run and resolve modules,
        // nothing that a module could mistake for configuration.
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 60000,
      },
    );
    return null;
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}`.split('\n').filter(Boolean).slice(0, 6).join('\n');
  }
}

describe('boot import order', () => {
  const specifiers = staticImportsOfIndex().filter((s) => s.startsWith('.'));

  it('index.mjs statically imports something local (the test is wired up)', () => {
    expect(specifiers.length).toBeGreaterThan(3);
  });

  it.each(specifiers)('%s survives being imported with an empty environment', (specifier) => {
    const failure = importWithEmptyEnv(specifier);
    if (failure) {
      // Thrown rather than asserted so the remedy travels with the failure —
      // the next person to hit this needs to know what to do, not just that a
      // value was not null.
      throw new Error(
        `index.mjs imports ${specifier} statically, so it is evaluated BEFORE `
        + 'dotenv.config() and must not need the environment. Import it dynamically '
        + 'after dotenv.config() instead (see the startChatSessionReaper import at '
        + `the bottom of index.mjs).\n\n${failure}`,
      );
    }
    expect(failure).toBeNull();
  }, 70000);

  // Pins the reason the rule exists. If lib/database.js ever stops connecting
  // at import, this test starts failing and the whole precaution can be
  // reconsidered — which is a better outcome than it silently going stale.
  it('lib/database.js does need the environment at import (the reason for the rule)', () => {
    expect(importWithEmptyEnv('./lib/database.js')).not.toBeNull();
  }, 70000);
});
