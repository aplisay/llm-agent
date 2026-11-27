/**
 * tools/agent-admin.js against the test database: each command that takes
 * --userId or --email finds the user by that option, run as the command line
 * tool in a process of its own.
 */
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  setupRealDatabase, teardownRealDatabase, databaseStarted,
  Organisation, User, AuthKey, Call,
} from './setup/database-test-wrapper.js';

const TOOL = fileURLToPath(new URL('../tools/agent-admin.js', import.meta.url));

describe('tools/agent-admin.js', () => {
  const stamp = `${Date.now()}`.slice(-6);
  const orgId = randomUUID();
  let dir;
  let envFile;

  // An empty env file, so the tool reads only the test database settings it
  // inherits and never a .env in the working directory.
  const run = (...args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TOOL, '--path', envFile, ...args], {
      env: { ...process.env, DB_FORCE_SYNC: 'false', NODE_ENV: 'test', LOGLEVEL: 'fatal' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => resolve({ code, stdout }));
  });

  const user = async (name) => User.create({
    id: `aat-${name}-${stamp}-${randomUUID().slice(0, 8)}`,
    organisationId: orgId,
    name,
    email: `${name}-${stamp}@admin-tool.example.com`,
    role: 'owner',
  });

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    dir = mkdtempSync(join(tmpdir(), 'agent-admin-'));
    envFile = join(dir, 'empty.env');
    writeFileSync(envFile, '');
    await Organisation.create({ id: orgId, name: `Admin tool ${stamp}` });
  });

  afterAll(async () => {
    await Call.destroy({ where: { organisationId: orgId } });
    await User.destroy({ where: { organisationId: orgId } });
    await Organisation.destroy({ where: { id: orgId } });
    rmSync(dir, { recursive: true, force: true });
    await teardownRealDatabase();
  }, 60000);

  describe('add-authkey', () => {
    test('--userId gives the key to the user with that id', async () => {
      const ada = await user('ada');
      await user('bob');
      const key = `aat-key-${randomUUID()}`;
      const { code } = await run('add-authkey', '--userId', ada.id, '--key', key);
      expect(code).toBe(0);
      const row = await AuthKey.findOne({ where: { key } });
      expect(row.userId).toBe(ada.id);
    }, 60000);

    test('--email gives the key to the user with that email', async () => {
      const cy = await user('cy');
      const key = `aat-key-${randomUUID()}`;
      const { code } = await run('add-authkey', '--email', cy.email, '--key', key);
      expect(code).toBe(0);
      expect((await AuthKey.findOne({ where: { key } })).userId).toBe(cy.id);
    }, 60000);

    test('without --key it makes a key of its own', async () => {
      const di = await user('di');
      const { code } = await run('add-authkey', '--userId', di.id);
      expect(code).toBe(0);
      const rows = await AuthKey.findAll({ where: { userId: di.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0].key).toMatch(/^[A-Za-z0-9+/]{64}$/);
    }, 60000);

    test('with neither --userId nor --email it fails and makes no key', async () => {
      const before = await AuthKey.count();
      const { code } = await run('add-authkey', '--key', `aat-key-${randomUUID()}`);
      expect(code).toBe(1);
      expect(await AuthKey.count()).toBe(before);
    }, 60000);

    test('a --userId that matches nobody fails and makes no key', async () => {
      const key = `aat-key-${randomUUID()}`;
      const { code } = await run('add-authkey', '--userId', `aat-nobody-${stamp}`, '--key', key);
      expect(code).toBe(1);
      expect(await AuthKey.findOne({ where: { key } })).toBeNull();
    }, 60000);
  });

  describe('delete-user', () => {
    test('--userId deletes only the user with that id', async () => {
      const [ed, flo] = [await user('ed'), await user('flo')];
      const { code } = await run('delete-user', '--userId', ed.id);
      expect(code).toBe(0);
      expect(await User.findByPk(ed.id)).toBeNull();
      expect(await User.findByPk(flo.id)).not.toBeNull();
    }, 60000);

    test('--email deletes the user with that email', async () => {
      const gus = await user('gus');
      const { code } = await run('delete-user', '--email', gus.email);
      expect(code).toBe(0);
      expect(await User.findByPk(gus.id)).toBeNull();
    }, 60000);

    test('with neither option, or with both, it fails and deletes nobody', async () => {
      const hal = await user('hal');
      expect((await run('delete-user')).code).toBe(1);
      expect((await run('delete-user', '--userId', hal.id, '--email', hal.email)).code).toBe(1);
      expect(await User.findByPk(hal.id)).not.toBeNull();
    }, 60000);
  });

  describe('usage', () => {
    const at = (iso) => new Date(iso);
    const call = (owner) => Call.create({
      id: randomUUID(),
      userId: owner.id,
      organisationId: orgId,
      callerId: '+442079460810',
      calledId: '+442079460811',
      startedAt: at('2001-02-03T10:00:00Z'),
      endedAt: at('2001-02-03T10:01:00Z'),
      duration: 60_000,
    });
    const period = ['--start', '2001-02-01T00:00:00Z', '--end', '2001-02-28T23:59:59Z', '--detail'];

    test('--userId and --email list only that user\'s calls', async () => {
      const [ivy, jo] = [await user('ivy'), await user('jo')];
      const [ivyCall, joCall] = [await call(ivy), await call(jo)];

      const byId = await run('usage', '--userId', ivy.id, ...period);
      expect(byId.code).toBe(0);
      expect(byId.stdout).toContain(ivyCall.id);
      expect(byId.stdout).not.toContain(joCall.id);

      const byEmail = await run('usage', '--email', jo.email, ...period);
      expect(byEmail.code).toBe(0);
      expect(byEmail.stdout).toContain(joCall.id);
      expect(byEmail.stdout).not.toContain(ivyCall.id);
    }, 60000);
  });
});
