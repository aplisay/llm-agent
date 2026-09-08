import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
  setupRealDatabase,
  teardownRealDatabase,
  Organisation,
  User,
  Agent,
  Instance,
  Call,
} from './setup/database-test-wrapper.js';

// Agent.create validates the model against the roster, which needs the key.
process.env.ANTHROPIC_API_KEY ||= 'test-key';

// A call's per-organisation number (`calls.index`) is MAX + 1 at create time.
// Two calls starting at once, in one process or in several, used to compute
// the same number: nothing ordered the creates, and the column has no unique
// constraint to refuse the second. The hook now takes a per-organisation
// advisory lock for the transaction, so concurrent creates queue behind each
// other's commit. This test creates calls for one organisation from THIS
// process and from two other real processes at the same time, and expects the
// numbers to come out unique and gap-free.
describe('call index under concurrent creates', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const writer = join(here, 'fixtures', 'call-index-writer.mjs');
  const PER_WRITER = 12;

  let orgId;
  let userId;
  let instanceId;

  beforeAll(async () => {
    await setupRealDatabase();
    orgId = randomUUID();
    userId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Call Index Org' });
    await User.create({
      id: userId, name: 'Call Index User', email: `calls-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '',
      role: 'owner', organisationId: orgId,
    });
    // Calls belong to a listener; afterCreate reads its streamLog flag.
    const agent = await Agent.create({
      name: 'Call index agent', type: 'text', modelName: 'text:anthropic/claude-sonnet-5',
      prompt: 'You are a test agent.', userId, organisationId: orgId,
    });
    const instance = await Instance.create({ agentId: agent.id, type: 'pipecat', key: 'k', userId, organisationId: orgId });
    instanceId = instance.id;
  }, 60000);

  afterAll(async () => {
    await Call.destroy({ where: { organisationId: orgId } });
    await Instance.destroy({ where: { organisationId: orgId } });
    await Agent.destroy({ where: { organisationId: orgId } });
    await User.destroy({ where: { id: userId } });
    await Organisation.destroy({ where: { id: orgId } });
    await teardownRealDatabase();
  }, 60000);

  function writeFromAnotherProcess(count) {
    const env = { ...process.env, NODE_ENV: 'test', LOGLEVEL: 'silent' };
    delete env.DB_FORCE_SYNC; // never alter-sync the schema under a running suite
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [writer, JSON.stringify({ organisationId: orgId, userId, instanceId, count })], {
        env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(`call writer exited ${code}: ${err || out}`));
        try {
          resolve(JSON.parse(out.trim().split('\n').pop()).indexes);
        } catch {
          reject(new Error(`call writer output was not JSON: ${out}\n${err}`));
        }
      });
    });
  }

  test('calls created at once from three processes get unique, gap-free numbers', async () => {
    const [here1, other1, other2] = await Promise.all([
      Promise.all(Array.from({ length: PER_WRITER }, () => Call.create({
        organisationId: orgId, userId, instanceId, platform: 'test', calledId: '441000000000', callerId: '441000000001',
      }))).then((calls) => calls.map((c) => c.index)),
      writeFromAnotherProcess(PER_WRITER),
      writeFromAnotherProcess(PER_WRITER),
    ]);
    const all = [...here1, ...other1, ...other2].sort((a, b) => a - b);
    expect(all).toHaveLength(3 * PER_WRITER);
    expect(all).toEqual(Array.from({ length: 3 * PER_WRITER }, (_, i) => i + 1));
    // And the rows say the same.
    const rows = await Call.findAll({ where: { organisationId: orgId }, attributes: ['index'], raw: true });
    expect(rows.map((r) => r.index).sort((a, b) => a - b)).toEqual(all);
  }, 90000);

  test('a create that fails rolls back and leaves no lock behind for the next one', async () => {
    // A row the database refuses (no such instance): the hook has already
    // taken the organisation's lock by then. With the transaction managed by
    // Call.create the failure rolls it back, and the next create for the
    // organisation must not wait on anything.
    const missingInstance = randomUUID();
    await expect(Call.create({
      organisationId: orgId, userId, instanceId: missingInstance, platform: 'test', calledId: '4410', callerId: '4411',
    })).rejects.toThrow();
    const t0 = Date.now();
    const next = await Call.create({ organisationId: orgId, userId, instanceId, platform: 'test', calledId: '4410', callerId: '4411' });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(next.index).toBe(3 * PER_WRITER + 1);
  }, 30000);

  test('numbers for other organisations are unaffected by the lock', async () => {
    const otherOrg = randomUUID();
    await Organisation.create({ id: otherOrg, name: 'Other Org' });
    try {
      const [a, b] = await Promise.all([
        Call.create({ organisationId: otherOrg, userId, instanceId, platform: 'test', calledId: '4410', callerId: '4411' }),
        Call.create({ organisationId: otherOrg, userId, instanceId, platform: 'test', calledId: '4410', callerId: '4411' }),
      ]);
      expect([a.index, b.index].sort()).toEqual([1, 2]);
    } finally {
      await Call.destroy({ where: { organisationId: otherOrg } });
      await Organisation.destroy({ where: { id: otherOrg } });
    }
  });
});
