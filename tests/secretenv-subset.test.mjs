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

  test('a prefix is two characters or more and ends in an underscore', () => {
    for (const short of ['P*', 'PO*', 'P_*', 'POSTGRES*', 'POSTGRES_**', 'PO*S']) {
      const refused = run([file, `CREDENTIALS_KEY,${short}`]);
      expect([short, refused.status, refused.stdout]).toEqual([short, 1, '']);
      expect(refused.stderr).toMatch(/ends in _\*/);
    }
    expect(run([file, 'PBX_*']).stderr).toContain('bundled (1): PBX_REGISTRAR_DOMAIN');
  });

  test('the key and the bundle themselves are never bundled', () => {
    const withPair = path.join(dir, 'with-pair.env');
    fs.writeFileSync(withPair, `${ENV_FILE}SECRETENV_KEY=made-up-old-key\nSECRETENV_BUNDLE=made-up-old-bundle\n`);
    const made = run([withPair, 'SECRETENV_*,CREDENTIALS_KEY']);
    expect(made.status).toBe(0);
    expect(made.stderr).toContain('bundled (1): CREDENTIALS_KEY');
    const named = run([withPair, 'CREDENTIALS_KEY,SECRETENV_KEY']);
    expect([named.status, named.stdout]).toEqual([1, '']);
    expect(named.stderr).toMatch(/never bundled: SECRETENV_KEY/);
  });
});

/**
 * deploy/bundle-secretenv.sh --only and deploy/k8s/provisioning/publish-settings.sh.
 * Dry runs only, on a made-up file. `kubectl` and `gcloud` are stand-ins that
 * write down what they were asked, so no real tool can be reached.
 */
describe('the bundle script with --only', () => {
  const SCRIPT = path.join(ROOT, 'deploy', 'bundle-secretenv.sh');
  const PUBLISH = path.join(ROOT, 'deploy', 'k8s', 'provisioning', 'publish-settings.sh');
  const VALUES = ['db.test.example', 'p@ss', 'MADE UP KEY', 'made-up-credentials-key', 'made-up-provider-key', 'made-up-old-key', 'made-up-admin'];
  let dir;
  let file;
  let asked;
  let env;
  const colour = /\u001b\[[0-9;]*m/g;
  const run = (script, args) => {
    fs.writeFileSync(asked, '');
    const done = spawnSync('bash', [script, '--env=staging', '--dry-run', `--file=${file}`, ...args], { env, encoding: 'utf8' });
    return {
      status: done.status,
      out: done.stdout.replace(colour, ''),
      err: done.stderr.replace(colour, ''),
      asked: fs.readFileSync(asked, 'utf8').trim().split('\n').filter(Boolean),
    };
  };
  const noValue = (result) => {
    for (const value of VALUES) expect(`${result.out}${result.err}`).not.toContain(value);
  };
  // The only thing a dry run asks a tool: which cluster the environment is bound to.
  const readOnly = (result) => expect(result.asked.every((line) => line === 'kubectl config get-contexts -o name')).toBe(true);

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-only-'));
    file = path.join(dir, 'made-up.env');
    // Two more database names than a service needs, and a key line.
    fs.writeFileSync(file, `${ENV_FILE}POSTGRES_POOL_MAX=20\nPOSTGRES_ADMIN_PASSWORD=made-up-admin\nSECRETENV_KEY=made-up-old-key\n`);
    asked = path.join(dir, 'asked.log');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    for (const tool of ['kubectl', 'gcloud']) {
      fs.writeFileSync(path.join(bin, tool), [
        '#!/bin/sh',
        `echo "${tool} $*" >> "${asked}"`,
        `[ "${tool} $*" = "kubectl config get-contexts -o name" ] && echo made-up-ams3-cluster`,
        'exit 0',
        '',
      ].join('\n'), { mode: 0o755 });
    }
    env = { PATH: [bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'), HOME: dir };
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test('refuses the Kubernetes target with no Secret name of its own', () => {
    const refused = run(SCRIPT, ['--target=k8s', '--only=POSTGRES_*']);
    expect(refused.status).toBe(2);
    expect(refused.err).toMatch(/--only needs --k8s-secret=<name>/);
    expect(refused.out).toBe('');
    expect(refused.asked).toEqual([]);
  });

  test('refuses the default Secret name, however it is given', () => {
    for (const args of [['--k8s-secret=llm-agent-secretenv'], ['--k8s-secret', 'llm-agent-secretenv'], ['--k8s-secret=']]) {
      const refused = run(SCRIPT, ['--target=k8s', '--only=POSTGRES_*', ...args]);
      expect(refused.status).toBe(2);
      expect(refused.err).toMatch(/--only (does not write to llm-agent-secretenv|needs --k8s-secret=<name>)/);
      expect(refused.out).toBe('');
      expect(refused.asked).toEqual([]);
    }
  });

  test('refuses Secret Manager, as the default target and by name', () => {
    for (const args of [[], ['--target=gcp'], ['--backend=gcp', '--k8s-secret=made-up-secretenv']]) {
      const refused = run(SCRIPT, ['--only=POSTGRES_*', ...args]);
      expect(refused.status).toBe(2);
      expect(refused.err).toMatch(/--only works with --target=k8s only/);
      expect(refused.out).toBe('');
      expect(refused.asked).toEqual([]);
    }
  });

  test('refuses an empty list', () => {
    const refused = run(SCRIPT, ['--target=k8s', '--k8s-secret=made-up-secretenv', '--only=']);
    expect(refused.status).toBe(2);
    expect(refused.err).toMatch(/--only needs a list of names/);
    expect(refused.asked).toEqual([]);
  });

  test('with a Secret name of its own, plans that Secret and lists the names', () => {
    const planned = run(SCRIPT, ['--target=k8s', '--only=POSTGRES_*,CREDENTIALS_KEY', '--k8s-secret=made-up-secretenv', '--k8s-namespace=made-up']);
    expect(planned.status).toBe(0);
    expect(planned.out).toMatch(/Secret:\s+made-up-secretenv in namespace made-up/);
    expect(planned.out).toMatch(/Only:\s+POSTGRES_\*,CREDENTIALS_KEY/);
    expect(planned.out).toMatch(/DRY RUN \(no writes\)/);
    // A prefix takes every name that starts so.
    expect(planned.err).toContain('bundled (8): CREDENTIALS_KEY, POSTGRES_ADMIN_PASSWORD, POSTGRES_CA, POSTGRES_HOST, POSTGRES_KEY, POSTGRES_PASSWORD, POSTGRES_POOL_MAX, POSTGRES_PORT');
    // The file holds a SECRETENV_KEY line. With --only it is not bundled, so there is no warning about it.
    expect(planned.err).not.toMatch(/will be encrypted into the new bundle/);
    readOnly(planned);
    noValue(planned);
  });

  test('without --only the default names are planned as before, with the warning about a key line', () => {
    const k8s = run(SCRIPT, ['--target=k8s']);
    expect(k8s.status).toBe(0);
    expect(k8s.out).toMatch(/Secret:\s+llm-agent-secretenv in namespace llm-agent/);
    expect(k8s.out).not.toMatch(/Only:/);
    expect(k8s.err).toMatch(/SECRETENV_KEY\/_BUNDLE line; it will be encrypted into the new bundle/);
    readOnly(k8s);
    noValue(k8s);
    const gcp = run(SCRIPT, []);
    expect(gcp.status).toBe(0);
    expect(gcp.out).toMatch(/Secrets:\s+SECRETENV_STAGING_KEY \+ SECRETENV_STAGING_BUNDLE/);
    expect(gcp.asked).toEqual([]);
    noValue(gcp);
  });

  test('publish-settings.sh plans the service\'s own Secret in the target\'s namespace', () => {
    const planned = run(PUBLISH, []);
    expect(planned.status).toBe(0);
    expect(planned.out).toMatch(/Secret:\s+provisioning-secretenv in namespace b2bua/);
    // Every setting by its exact name: no prefix, so a database name the service does not read stays out.
    const only = /Only:\s+(\S+)/.exec(planned.out)[1].split(',');
    expect(only).toEqual([
      'POSTGRES_HOST', 'POSTGRES_PORT', 'POSTGRES_USER', 'POSTGRES_PASSWORD', 'POSTGRES_DB',
      'POSTGRES_CA', 'POSTGRES_CERT', 'POSTGRES_KEY', 'POSTGRES_RO_SERVER_NAME',
      'CREDENTIALS_KEY', 'PBX_REGISTRAR_DOMAIN', 'REGSERVER_REGISTRAR', 'PBX_RELEASE',
    ]);
    expect(planned.err).toContain('bundled (7): CREDENTIALS_KEY, PBX_REGISTRAR_DOMAIN, POSTGRES_CA, POSTGRES_HOST, POSTGRES_KEY, POSTGRES_PASSWORD, POSTGRES_PORT');
    expect(planned.err).toContain('not in the file, so not bundled: POSTGRES_USER, POSTGRES_DB, POSTGRES_CERT, POSTGRES_RO_SERVER_NAME, REGSERVER_REGISTRAR, PBX_RELEASE');
    expect(planned.err).not.toMatch(/POSTGRES_POOL_MAX|POSTGRES_ADMIN_PASSWORD/);
    readOnly(planned);
    noValue(planned);
    for (const option of ['--k8s-secret=other', '--k8s-namespace=other', '--only=POSTGRES_*', '--target=gcp']) {
      const refused = run(PUBLISH, [option]);
      expect([option, refused.status]).toEqual([option, 2]);
      expect(refused.err).toMatch(/This script sets/);
      expect(refused.asked).toEqual([]);
    }
  });
});
