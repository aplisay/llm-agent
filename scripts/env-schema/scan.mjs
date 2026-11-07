/**
 * Find the environment variable names that each component's code reads.
 * Used by tests/env-schema.test.mjs to check that config/env.schema.json
 * lists every one. It reads source text, so a name built at run time (for
 * example `${prefix}_KEY`) is not seen.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Source roots per component, relative to the repo root. */
export const COMPONENT_SOURCES = {
  api: { roots: ['index.mjs', 'lib', 'api', 'middleware'], exts: ['.js', '.mjs'] },
  livekit: { roots: ['agents/livekit/realtime.ts', 'agents/livekit/lib', 'agents/livekit/plugins'], exts: ['.ts'] },
  pipecat: { roots: ['agents/pipecat/pipecat_aplisay'], exts: ['.py'] },
  sipbridge: { roots: ['agents/pipecat/sipbridge/cmd', 'agents/pipecat/sipbridge/internal'], exts: ['.go'] },
};

const NAME = '[A-Z][A-Z0-9_]*[A-Z0-9]';

const PATTERNS = [
  // process.env.X, process.env?.X, env.X (an env object passed in)
  new RegExp(`\\b(?:process\\.env|env)\\??\\.(${NAME})\\b`, 'g'),
  // process.env['X'], os.environ["X"], os.environ.get("X"), os.environ.setdefault("X", ...)
  new RegExp(`\\b(?:process\\.env|environ)(?:\\.get|\\.setdefault|\\.pop)?\\s*[\\[(]\\s*['"](${NAME})['"]`, 'g'),
  // os.getenv("X"), os.Getenv("X"), os.LookupEnv("X"), envInt("X"), _require_env("X") and similar helpers
  new RegExp(`\\b\\w*(?:env|Env|ENV)\\w*\\s*\\(\\s*['"](${NAME})['"]`, 'g'),
  // "X" in os.environ
  new RegExp(`['"](${NAME})['"]\\s+(?:not\\s+)?in\\s+os\\.environ`, 'g'),
];

// const { A, B: alias, C = 'x' } = process.env;
const DESTRUCTURE = /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*process\.env\b/g;

function listFiles(root, exts) {
  const full = path.join(repoRoot, root);
  if (!fs.existsSync(full)) return [];
  const stat = fs.statSync(full);
  if (stat.isFile()) return [full];
  const out = [];
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'tests', 'test', '__pycache__', '.venv'].includes(entry.name)) continue;
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(child, exts));
    else if (exts.includes(path.extname(entry.name)) && !/[._]test\.|_test\.go$|^test_/.test(entry.name)) {
      out.push(path.join(repoRoot, child));
    }
  }
  return out;
}

/** Names read in one source text. */
export function namesInSource(text) {
  const names = new Set();
  for (const pattern of PATTERNS) {
    for (const match of text.matchAll(pattern)) names.add(match[1]);
  }
  for (const match of text.matchAll(DESTRUCTURE)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/[:=\s]/)[0];
      if (new RegExp(`^${NAME}$`).test(name)) names.add(name);
    }
  }
  return names;
}

/** Map of component name to a Map of variable name to the files that read it. */
export function scanComponents(components = Object.keys(COMPONENT_SOURCES)) {
  const result = {};
  for (const component of components) {
    const { roots, exts } = COMPONENT_SOURCES[component];
    const found = new Map();
    for (const root of roots) {
      for (const file of listFiles(root, exts)) {
        for (const name of namesInSource(fs.readFileSync(file, 'utf8'))) {
          if (!found.has(name)) found.set(name, []);
          found.get(name).push(path.relative(repoRoot, file));
        }
      }
    }
    result[component] = found;
  }
  return result;
}
