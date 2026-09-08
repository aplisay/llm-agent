import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'crypto';
import {
  setupRealDatabase,
  teardownRealDatabase,
  Organisation,
  User,
  Agent,
  Instance,
  Call,
  TransactionLog,
} from './setup/database-test-wrapper.js';

// Live call progress has to cross processes.
//
// The `/progress/<instanceId>` socket (Handler.handleUpdates) subscribes with
// TransactionLog.on, a Postgres LISTEN, and every transaction log write is
// relayed to it with NOTIFY from the afterCreate hook. The relay itself has
// always been cross-process. The gate in front of it was not: whether to
// notify was read from a per-process object that only Call.afterCreate wrote,
// so only the process that created the Call row ever notified. The livekit and
// pipecat workers create a call with one HTTP request and write every log with
// another, and with more than one server process those land on different
// processes, so the live transcript went dark for exactly the calls somebody
// was watching.
//
// These tests write the logs from a genuinely separate node process (the
// fixture in tests/fixtures/progress-log-writer.mjs) against the same
// database, and read them here on the LISTEN this process holds. A
// single-process stand-in would pass with the old code.
describe('transaction log progress notify across processes', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const writer = join(here, 'fixtures', 'progress-log-writer.mjs');

  let orgId;
  let userId;
  let agentId;
  let streaming; // { instanceId, callId } — Instance.streamLog true
  let silent;    // { instanceId, callId } — Instance.streamLog false
  let heard;     // payloads for the streaming instance
  let heardSilent;

  beforeAll(async () => {
    await setupRealDatabase();
    orgId = randomUUID();
    userId = randomUUID();
    await Organisation.create({ id: orgId, name: 'Progress Org' });
    await User.create({
      id: userId, name: 'Progress User', email: `progress-${userId}@example.com`,
      emailVerified: true, phone: '', phoneVerified: false, picture: '',
      role: 'owner', organisationId: orgId,
    });
    const agent = await Agent.create({
      name: 'Progress agent',
      description: 't',
      modelName: 'livekit:ultravox/ultravox-v0.7',
      prompt: 'You are a test agent.',
      options: { tts: { language: 'any', voice: 'Ciara' } },
      functions: {},
      keys: [],
      userId,
      organisationId: orgId,
    });
    agentId = agent.id;
    streaming = await createCall({ streamLog: true });
    silent = await createCall({ streamLog: false });

    // Subscribe exactly as the progress socket does.
    heard = [];
    heardSilent = [];
    await TransactionLog.on(streaming.instanceId, (payload) => heard.push(payload));
    await TransactionLog.on(silent.instanceId, (payload) => heardSilent.push(payload));
  }, 60000);

  afterAll(async () => {
    // Whatever beforeAll managed, the database must be closed at the end or
    // jest sits on the open LISTEN connection and never exits.
    try {
      if (streaming) await TransactionLog.on(streaming.instanceId, null);
      if (silent) await TransactionLog.on(silent.instanceId, null);
      await TransactionLog.destroy({ where: { organisationId: orgId } });
      await Call.destroy({ where: { organisationId: orgId } });
      await Instance.destroy({ where: { organisationId: orgId } });
      await Agent.destroy({ where: { organisationId: orgId } });
      await User.destroy({ where: { id: userId } });
      await Organisation.destroy({ where: { id: orgId } });
    }
    finally {
      await teardownRealDatabase();
    }
  }, 60000);

  // The Call row is created in THIS process, as it is on whichever server
  // process takes the worker's POST /agent-db/call. Hooks on: afterCreate is
  // what warms the creating process's memo, the one path the old code had.
  async function createCall({ streamLog }) {
    const instance = await Instance.create({
      agentId, type: 'pipecat', key: 'k', userId, organisationId: orgId, streamLog,
    });
    const call = await Call.create({
      id: randomUUID(), userId, organisationId: orgId, instanceId: instance.id, agentId,
      platform: 'pipecat', modelName: 'livekit:ultravox/ultravox-v0.7',
    });
    return { instanceId: instance.id, callId: call.id };
  }

  function logFor(target, type, data) {
    return { userId, organisationId: orgId, callId: target.callId, type, data, isFinal: true };
  }

  // A second server process: same database, empty memo, no knowledge of who
  // created the Call.
  function writeFromAnotherProcess(logs) {
    const env = { ...process.env, NODE_ENV: 'test', LOGLEVEL: 'silent' };
    // The writer must not alter-sync the schema under a running suite.
    delete env.DB_FORCE_SYNC;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [writer, JSON.stringify({ logs })], {
        env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d; });
      child.stderr.on('data', (d) => { err += d; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0
        ? resolve(out)
        : reject(new Error(`log writer exited ${code}: ${err || out}`))));
    });
  }

  async function waitFor(pred, what, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pred()) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 50); });
    }
    throw new Error(`timed out waiting for ${what}`);
  }

  test('a log written by the process that created the call is relayed (the path that always worked)', async () => {
    await TransactionLog.create(logFor(streaming, 'agent', 'said here, in the creating process'));
    await waitFor(() => heard.some((p) => p.agent === 'said here, in the creating process'), 'same-process notify');
    const payload = heard.find((p) => p.agent === 'said here, in the creating process');
    expect(payload.callId).toBe(streaming.callId);
    expect(payload.isFinal).toBe(true);
  });

  test('a log written by ANOTHER process is relayed to the subscriber here', async () => {
    await writeFromAnotherProcess([logFor(streaming, 'user', 'said in a different process')]);
    await waitFor(() => heard.some((p) => p.user === 'said in a different process'), 'cross-process notify');
    const payload = heard.find((p) => p.user === 'said in a different process');
    expect(payload.callId).toBe(streaming.callId);
  }, 60000);

  test('a call whose instance does not stream stays silent, from any process', async () => {
    // Both writes go through one writer in this order. Notifications arrive on
    // one connection in commit order, so once the marker for the streaming
    // call is here, anything wrongly sent for the silent call is here too.
    await writeFromAnotherProcess([
      logFor(silent, 'agent', 'nobody is watching this call'),
      logFor(streaming, 'agent', 'marker after the silent write'),
    ]);
    await waitFor(() => heard.some((p) => p.agent === 'marker after the silent write'), 'marker notify');
    expect(heardSilent).toEqual([]);
    // And the silent write itself landed: silence is the gate, not a lost row.
    const rows = await TransactionLog.findAll({ where: { callId: silent.callId } });
    expect(rows.map((r) => r.type)).toEqual(['agent']);
  }, 60000);
});
