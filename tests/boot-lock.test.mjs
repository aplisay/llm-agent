import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// Importing the wrapper sets the POSTGRES_* variables for the test database
// (before anything imports lib/database.js) and gives the peer processes the
// same target through the environment they inherit.
import { setupRealDatabase, teardownRealDatabase } from './setup/database-test-wrapper.js';

// The boot-time schema work runs in every server process, and processes start
// together on a scale-up or a rolling deploy. lib/boot-lock.js makes them run
// it one at a time. These tests use real second processes against the same
// database: one that holds the lock the way a booting server does, to show
// this process's boot waits for it; and several booting at once, to show they
// all come up.
describe('boot lock', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const holder = join(here, 'fixtures', 'hold-boot-lock.mjs');
  const booter = join(here, 'fixtures', 'boot-database.mjs');
  const childEnv = () => {
    const env = { ...process.env, NODE_ENV: 'test', LOGLEVEL: 'silent' };
    delete env.DB_FORCE_SYNC; // peers must not alter-sync the schema under the suite
    return env;
  };
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  test("this process's boot waits while another process holds the lock, then completes", async () => {
    // Another process takes the lock first.
    const held = spawn(process.execPath, [holder], { env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let err = '';
    held.stderr.on('data', (d) => { err += d; });
    await new Promise((resolve, reject) => {
      held.stdout.on('data', (d) => { if (String(d).includes('locked')) resolve(); });
      held.on('close', (code) => reject(new Error(`lock holder exited early (${code}): ${err}`)));
    });

    // Now boot here. The chain must not get past the lock while it is held.
    const started = setupRealDatabase();
    const outcome = await Promise.race([started.then(() => 'started'), sleep(2000).then(() => 'still waiting')]);
    expect(outcome).toBe('still waiting');

    // Release, and the boot goes through.
    held.stdin.write('go\n');
    const exit = new Promise((resolve) => { held.on('close', resolve); });
    await started;
    expect(await exit).toBe(0);
  }, 60000);

  test('several processes booting at once all come up', async () => {
    const runs = [1, 2, 3].map(() => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [booter], { env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 && out.includes('started')
        ? resolve(code)
        : reject(new Error(`boot exited ${code}: ${err || out}`))));
    }));
    await expect(Promise.all(runs)).resolves.toEqual([0, 0, 0]);
  }, 90000);
});
