import {
  setupRealDatabase,
  teardownRealDatabase,
  databaseStarted,
  Call,
  InvocationLog,
  Organisation,
  User,
} from './setup/database-test-wrapper.js';
import { randomUUID } from 'crypto';
import {
  cutoffFromDays,
  purgeInvocationLogs,
  purgeUltravoxCalls,
} from '../lib/retention.js';

const NOW = Date.parse('2026-11-23T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (n) => new Date(NOW - n * DAY).toISOString();

describe('cutoffFromDays', () => {
  test('subtracts whole days', () => {
    expect(cutoffFromDays(30, NOW).toISOString()).toBe(daysAgo(30));
  });

  test.each([0, -1, 1.5, 'x', undefined, null])('rejects %p', (days) => {
    expect(() => cutoffFromDays(days, NOW)).toThrow(/--days/);
  });
});

describe('purgeUltravoxCalls', () => {
  const BASE = 'https://api.ultravox.ai/api/';
  const cutoff = new Date(daysAgo(30));
  const noSleep = async () => {};

  // A fake axios instance. `pages` is what successive GETs return. `onDelete`
  // decides each DELETE: return nothing for 204, or throw.
  function fakeHttp(pages, onDelete = () => {}) {
    const gets = [];
    const deletes = [];
    let page = 0;
    return {
      gets,
      deletes,
      get: async (url, config) => {
        gets.push({ url, params: config?.params });
        return { data: pages[page++] };
      },
      delete: async (url) => {
        deletes.push(url);
        return onDelete(url, deletes.length);
      },
    };
  }

  const httpError = (status, headers = {}) => Object.assign(new Error(`HTTP ${status}`), { response: { status, headers } });

  const call = (callId, createdDaysAgo, ended = true) => ({
    callId,
    created: daysAgo(createdDaysAgo),
    ended: ended ? daysAgo(createdDaysAgo - 0.01) : null,
  });

  test('dry run lists every page, filters, and deletes nothing', async () => {
    const http = fakeHttp([
      { total: 4, results: [call('a', 40), call('b', 35, false)], next: `${BASE}calls?cursor=2` },
      { total: 4, results: [call('c', 50), call('recent', 2)], next: null },
    ]);
    const result = await purgeUltravoxCalls({ http, cutoff, sleep: noSleep });

    expect(http.gets).toEqual([
      { url: 'calls', params: { toDate: cutoff.toISOString(), pageSize: 100 } },
      { url: `${BASE}calls?cursor=2`, params: undefined },
    ]);
    expect(http.deletes).toEqual([]);
    expect(result).toMatchObject({
      dryRun: true,
      total: 4,
      listed: 4,
      skippedRecent: 1,
      skippedNotEnded: 1,
      eligible: 2,
      oldest: daysAgo(50),
      newest: daysAgo(40),
      deleted: 0,
    });
    expect(result.sample.map((c) => c.callId)).toEqual(['c', 'a']);
  });

  test('execute deletes the oldest first, up to the limit', async () => {
    const http = fakeHttp([{ results: [call('a', 40), call('b', 60), call('c', 50)], next: null }]);
    const result = await purgeUltravoxCalls({ http, cutoff, execute: true, limit: 2, concurrency: 1, sleep: noSleep });
    expect(http.deletes).toEqual(['calls/b', 'calls/c']);
    expect(result).toMatchObject({ dryRun: false, eligible: 3, deleted: 2, failed: 0 });
  });

  test('never deletes a call created after the cutoff, even if the API ignores toDate', async () => {
    const http = fakeHttp([{ results: [call('recent', 1), call('edge', 30), call('old', 31)], next: null }]);
    const result = await purgeUltravoxCalls({ http, cutoff, execute: true, sleep: noSleep });
    expect(http.deletes).toEqual(['calls/old']);
    expect(result.skippedRecent).toBe(2);
  });

  test('counts 404 as already gone and retries 429 after Retry-After', async () => {
    const sleeps = [];
    let triesOfA = 0;
    const http = fakeHttp(
      [{ results: [call('a', 40), call('b', 41)], next: null }],
      (url) => {
        if (url === 'calls/b') throw httpError(404);
        if (url === 'calls/a' && ++triesOfA === 1) throw httpError(429, { 'retry-after': '2' });
      },
    );
    const result = await purgeUltravoxCalls({
      http, cutoff, execute: true, concurrency: 1, sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(result).toMatchObject({ deleted: 1, alreadyGone: 1, failed: 0 });
    expect(sleeps).toEqual([2000]);
  });

  test('stops after 10 failures in a row', async () => {
    const results = Array.from({ length: 15 }, (_, i) => call(`c${i}`, 40 + i));
    const http = fakeHttp([{ results, next: null }], () => { throw httpError(403); });
    const result = await purgeUltravoxCalls({ http, cutoff, execute: true, concurrency: 1, sleep: noSleep });
    expect(result).toMatchObject({ deleted: 0, failed: 10, stoppedEarly: true });
    expect(http.deletes).toHaveLength(10);
  });

  test('refuses to follow a paging URL on another host', async () => {
    const http = fakeHttp([{ results: [], next: 'https://evil.example/calls?cursor=2' }]);
    await expect(purgeUltravoxCalls({ http, cutoff, sleep: noSleep })).rejects.toThrow(/not on https:\/\/api.ultravox.ai/);
    expect(http.gets).toHaveLength(1);
  });

  test('rejects a bad limit', async () => {
    const http = fakeHttp([]);
    await expect(purgeUltravoxCalls({ http, cutoff, limit: 0 })).rejects.toThrow(/--limit/);
  });
});

describe('purgeInvocationLogs', () => {
  let sequelize;
  let orgId;
  let userId;
  let callId;
  let idx = 1;

  beforeAll(async () => {
    await setupRealDatabase();
    await databaseStarted;
    sequelize = InvocationLog.sequelize;
    orgId = randomUUID();
    await Organisation.create({ id: orgId, name: `Retention Org ${orgId.slice(0, 8)}` });
    userId = randomUUID();
    await User.upsert({
      id: userId, name: 'Retention Tester', email: `retention-${userId}@example.com`,
      emailVerified: true, phone: '0000', phoneVerified: false, picture: '', role: 'owner',
    });
    const c = await Call.create({
      organisationId: orgId, userId, index: idx++, calledId: '+442080996945', callerId: '+443300889471',
      status: 'ended normally', platform: 'test', live: false,
      startedAt: new Date('2026-01-01T00:00:00Z'), endedAt: new Date('2026-01-01T00:01:00Z'),
    }, { hooks: false });
    callId = c.id;
  }, 30000);

  afterAll(async () => {
    await teardownRealDatabase();
  }, 60000);

  beforeEach(async () => {
    await InvocationLog.destroy({ where: { callId } });
  });

  const mkLog = async (createdDaysAgo) => {
    const row = await InvocationLog.create({
      callId, organisationId: orgId, userId, subsystem: 'livekit-agent', log: { encoding: 'none', data: 'x' },
    });
    await sequelize.query('UPDATE invocation_logs SET created_at = :at WHERE id = :id', {
      replacements: { at: daysAgo(createdDaysAgo), id: row.id },
    });
    return row.id;
  };

  const remaining = async () => (await InvocationLog.findAll({ where: { callId }, order: [['id', 'ASC']] })).map((r) => r.id);
  const cutoff = new Date(daysAgo(30));

  test('dry run counts old rows and deletes nothing', async () => {
    await mkLog(40);
    await mkLog(31);
    const keep = await mkLog(5);
    const result = await purgeInvocationLogs({ sequelize, cutoff });
    expect(result).toMatchObject({ dryRun: true, matched: 2, deleted: 0 });
    expect(result.storedBytes).toBeGreaterThan(0);
    expect(new Date(result.oldest).toISOString()).toBe(daysAgo(40));
    expect(await remaining()).toHaveLength(3);
    expect(await remaining()).toContain(keep);
  });

  test('execute deletes only rows before the cutoff, in batches', async () => {
    await mkLog(40);
    await mkLog(35);
    await mkLog(31);
    const keep = await mkLog(29);
    const logs = [];
    const result = await purgeInvocationLogs({
      sequelize, cutoff, execute: true, batchSize: 2, log: (d) => logs.push(d),
    });
    expect(result).toMatchObject({ dryRun: false, matched: 3, deleted: 3 });
    expect(logs.map((d) => d.deleted)).toEqual([2, 3]);
    expect(await remaining()).toEqual([keep]);
  });

  test('limit deletes the oldest first', async () => {
    const oldest = await mkLog(60);
    const second = await mkLog(50);
    const third = await mkLog(40);
    const result = await purgeInvocationLogs({ sequelize, cutoff, execute: true, limit: 1 });
    expect(result).toMatchObject({ matched: 3, deleted: 1 });
    const left = await remaining();
    expect(left).not.toContain(oldest);
    expect(left).toEqual(expect.arrayContaining([second, third]));
  });
});
