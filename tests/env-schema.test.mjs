import fs from 'node:fs';
import path from 'node:path';
import { scanComponents, namesInSource, repoRoot } from '../scripts/env-schema/scan.mjs';
import { loadSchema, generatedFiles } from '../scripts/env-schema/generate.mjs';

const schema = loadSchema();
const byName = new Map(schema.variables.map((v) => [v.name, v]));

describe('config/env.schema.json', () => {
  test('names are unique and every group exists', () => {
    expect(byName.size).toBe(schema.variables.length);
    const groups = new Set(schema.groups.map((g) => g.id));
    for (const v of schema.variables) {
      expect({ name: v.name, group: groups.has(v.group) }).toEqual({ name: v.name, group: true });
      expect(v.description.length).toBeGreaterThan(0);
    }
  });

  // Coverage: the API server, the LiveKit worker, the Pipecat worker (Python)
  // and sipbridge (Go). Names built at run time are not seen by the scan.
  test.each(['api', 'livekit', 'pipecat', 'sipbridge'])('lists every variable the %s code reads', (component) => {
    const found = scanComponents([component])[component];
    expect(found.size).toBeGreaterThan(0);
    const problems = [];
    for (const [name, files] of found) {
      const v = byName.get(name);
      if (!v) problems.push(`${name} (read in ${files[0]}) is not in the schema`);
      else if (!v.components.includes(component)) problems.push(`${name} (read in ${files[0]}) does not list ${component}`);
    }
    expect(problems).toEqual([]);
  });

  test('no template value is a placeholder', () => {
    for (const v of schema.variables) {
      expect({ name: v.name, placeholder: /^</.test(v.example ?? '') }).toEqual({ name: v.name, placeholder: false });
    }
  });

  test('the generated files are up to date (run yarn env:generate)', () => {
    for (const [file, content] of Object.entries(generatedFiles(schema))) {
      expect({ file, upToDate: fs.readFileSync(path.join(repoRoot, file), 'utf8') === content })
        .toEqual({ file, upToDate: true });
    }
  });

  test('the template keeps user sign-up and email off', () => {
    const template = fs.readFileSync(path.join(repoRoot, 'environment-example'), 'utf8');
    expect(template).not.toMatch(/^BETTER_AUTH_ENABLED=/m);
    expect(template).not.toMatch(/^EMAIL_SEND_TYPE=/m);
    expect(template).not.toMatch(/^[A-Z0-9_]+=<.*>/m);
  });
});

describe('scan', () => {
  test('finds the forms the code uses', () => {
    const names = namesInSource(`
      const { ALPHA, BETA: b, GAMMA = 'x' } = process.env;
      process.env.DELTA; process.env['EPSILON']; env.ZETA;
      os.environ.get("ETA"); os.getenv('THETA'); os.environ["IOTA"]
      envInt("KAPPA", 1); _require_env("LAMBDA"); os.Getenv("MU")
    `);
    expect([...names].sort()).toEqual(
      ['ALPHA', 'BETA', 'DELTA', 'EPSILON', 'ETA', 'GAMMA', 'IOTA', 'KAPPA', 'LAMBDA', 'MU', 'THETA', 'ZETA'],
    );
  });
});
