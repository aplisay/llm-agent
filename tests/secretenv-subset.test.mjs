/**
 * deploy/secretenv-subset.cjs: a settings bundle with only the named
 * variables of an env file. Every value here is made up. The bundle is read
 * back by the real secretenv package, the way a server reads it at start.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pick } = require('../deploy/secretenv-subset.cjs');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const HELPER = path.join(ROOT, 'deploy', 'secretenv-subset.cjs');

const PEM = '-----BEGIN MADE UP KEY-----\nAAAA+bbb/CCC=\nDDDD\n-----END MADE UP KEY-----';
const ENV_FILE = [
  'POSTGRES_HOST=db.test.example',
  'POSTGRES_PORT=5432',
  "POSTGRES_PASSWORD='p@ss=w#rd \"quoted\" $x'",
  `POSTGRES_KEY="${PEM}"`,
  `POSTGRES_CA="${PEM.replace(/\n/g, '\\n')}"`,
  'CREDENTIALS_KEY=made-up-credentials-key',
  'PBX_REGISTRAR_DOMAIN=sip.test.example',
  'OPENAI_API_KEY=made-up-provider-key',
  'NODE_ENV=development',
  'DB_FORCE_SYNC=true',
  '',
].join('\n');
const KEY = 'made-up-bundle-key';
const NAMES = 'POSTGRES_*,CREDENTIALS_KEY,PBX_REGISTRAR_DOMAIN,PBX_RELEASE';

describe('a settings bundle of named variables', () => {
  let dir;
  let file;
  const run = (args, env = { SECRETENV_KEY: KEY }) => spawnSync(process.execPath, [HELPER, ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });
  // What a server sees after it decrypts the bundle at start, in a directory with no .env file.
  const readBack = (bundle, names) => {
    const script = `require(${JSON.stringify(path.join(ROOT, 'node_modules', 'dotenv'))}).config();`
      + `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map((n) => [n, process.env[n] ?? null]))));`;
    const child = spawnSync(process.execPath, ['-e', script], { cwd: dir, env: { PATH: process.env.PATH, SECRETENV_KEY: KEY, SECRETENV_BUNDLE: bundle }, encoding: 'utf8' });
    return JSON.parse(child.stdout);
  };

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secretenv-subset-'));
    file = path.join(dir, 'made-up.env');
    fs.writeFileSync(file, ENV_FILE);
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('pick takes exact names and prefixes, and nothing else', () => {
    const all = { POSTGRES_HOST: 'a', POSTGRES_KEY: 'b', POSTGRESQL: 'c', CREDENTIALS_KEY: 'd', CREDENTIALS_KEY_OLD: 'e', OTHER: 'f' };
    expect(pick(all, ['POSTGRES_*', 'CREDENTIALS_KEY'])).toEqual({ POSTGRES_HOST: 'a', POSTGRES_KEY: 'b', CREDENTIALS_KEY: 'd' });
  });

  test('the server reads back the named variables as the file has them, and none of the others', () => {
    const made = run([file, NAMES]);
    expect(made.status).toBe(0);
    const bundle = /^SECRETENV_BUNDLE=(\S+)\n$/.exec(made.stdout)[1];
    const seen = readBack(bundle, ['POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_PASSWORD', 'POSTGRES_KEY', 'POSTGRES_CA', 'CREDENTIALS_KEY', 'PBX_REGISTRAR_DOMAIN', 'OPENAI_API_KEY', 'NODE_ENV', 'DB_FORCE_SYNC', 'PBX_RELEASE']);
    expect(seen).toEqual({
      POSTGRES_HOST: 'db.test.example',
      POSTGRES_PORT: '5432',
      POSTGRES_PASSWORD: 'p@ss=w#rd "quoted" $x',
      POSTGRES_KEY: PEM,
      POSTGRES_CA: PEM,
      CREDENTIALS_KEY: 'made-up-credentials-key',
      PBX_REGISTRAR_DOMAIN: 'sip.test.example',
      OPENAI_API_KEY: null,
      NODE_ENV: null,
      DB_FORCE_SYNC: null,
      PBX_RELEASE: null,
    });
  });

  test('it lists names, and never a value', () => {
    const made = run([file, NAMES]);
    expect(made.stderr).toContain('bundled (7): CREDENTIALS_KEY, PBX_REGISTRAR_DOMAIN, POSTGRES_CA, POSTGRES_HOST, POSTGRES_KEY, POSTGRES_PASSWORD, POSTGRES_PORT');
    expect(made.stderr).toContain('not in the file, so not bundled: PBX_RELEASE');
    for (const value of ['db.test.example', 'p@ss', 'MADE UP KEY', 'made-up-credentials-key', 'made-up-provider-key', KEY]) {
      expect(made.stderr).not.toContain(value);
      expect(made.stdout).not.toContain(value);
    }
  });

  test('it refuses when nothing matches, a name is not a name, or there is no key', () => {
    const nothing = run([file, 'NOT_THERE,ALSO_NOT_*']);
    expect(nothing.status).toBe(1);
    expect(nothing.stdout).toBe('');
    expect(run([file, 'POSTGRES_*,bad name']).status).toBe(1);
    expect(run([file, 'POSTGRES_*,*']).status).toBe(1);
    const noKey = run([file, NAMES], {});
    expect(noKey.status).toBe(1);
    expect(noKey.stdout).toBe('');
  });
});
