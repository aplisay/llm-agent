// Retention sweeps run by tools/agent-admin.js. Both are dry runs unless
// `execute` is set. This file must not import lib/database.js: the Ultravox
// sweep runs with no database connection.

const DAY_MS = 24 * 60 * 60 * 1000;
export const ULTRAVOX_BASE_URL = 'https://api.ultravox.ai/api/';

export function cutoffFromDays(days, now = Date.now()) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`--days must be a whole number of 1 or more (got ${days})`);
  }
  return new Date(now - n * DAY_MS);
}

function checkLimit(limit) {
  if (limit === undefined || limit === null) return undefined;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`--limit must be a whole number of 1 or more (got ${limit})`);
  }
  return limit;
}

/**
 * Delete invocation_logs rows created before `cutoff`, oldest first, in
 * batches. `sequelize` is a Sequelize instance (for example
 * `InvocationLog.sequelize`).
 */
export async function purgeInvocationLogs({
  sequelize, cutoff, execute = false, limit, batchSize = 1000, log = () => {},
}) {
  limit = checkLimit(limit);
  const [[summary]] = await sequelize.query(
    `SELECT count(*)::bigint AS count, min(created_at) AS oldest, max(created_at) AS newest,
            coalesce(sum(pg_column_size(log)), 0)::bigint AS bytes
       FROM invocation_logs WHERE created_at < :cutoff`,
    { replacements: { cutoff } },
  );
  const matched = Number(summary.count);
  const result = {
    dryRun: !execute,
    cutoff,
    matched,
    oldest: summary.oldest,
    newest: summary.newest,
    storedBytes: Number(summary.bytes),
    deleted: 0,
  };
  const target = limit ? Math.min(limit, matched) : matched;
  if (!execute) return result;

  while (result.deleted < target) {
    const size = Math.min(batchSize, target - result.deleted);
    const [[{ n }]] = await sequelize.query(
      `WITH gone AS (
         DELETE FROM invocation_logs WHERE id IN (
           SELECT id FROM invocation_logs WHERE created_at < :cutoff
            ORDER BY created_at LIMIT :size)
         RETURNING 1)
       SELECT count(*)::int AS n FROM gone`,
      { replacements: { cutoff, size } },
    );
    if (!n) break;
    result.deleted += n;
    log({ deleted: result.deleted, target }, 'invocation logs deleted');
  }
  return result;
}

const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelayMs(err, attempt) {
  const header = Number(err?.response?.headers?.['retry-after']);
  if (Number.isFinite(header) && header > 0) return Math.min(header, 60) * 1000;
  return Math.min(1000 * 2 ** attempt, 30000);
}

function retryable(err) {
  const status = err?.response?.status;
  return !status || status === 429 || status >= 500;
}

async function withRetry(fn, { attempts = 5, sleep }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt + 1 >= attempts || !retryable(err)) throw err;
      await sleep(retryDelayMs(err, attempt));
    }
  }
}

/**
 * Delete Ultravox calls created before `cutoff`. `http` is an axios instance
 * with baseURL ULTRAVOX_BASE_URL and the X-API-Key header set.
 *
 * Every call is listed before any is deleted, because the docs do not say
 * whether a list cursor survives deletes. Calls with no `ended` time are never
 * deleted.
 */
export async function purgeUltravoxCalls({
  http, cutoff, execute = false, limit, concurrency = 4, pageSize = 100,
  log = () => {}, sleep = sleepMs,
}) {
  limit = checkLimit(limit);
  const origin = new URL(ULTRAVOX_BASE_URL).origin;
  const listed = [];
  let total;
  let url = 'calls';
  let params = { toDate: cutoff.toISOString(), pageSize };
  for (let page = 1; url; page++) {
    const { data } = await withRetry(() => http.get(url, params ? { params } : undefined), { sleep });
    if (total === undefined) total = data?.total;
    for (const c of data?.results || []) {
      listed.push({ callId: c.callId, created: c.created, ended: c.ended });
    }
    url = data?.next || null;
    params = null;
    // `next` is an absolute URL and the request carries our API key.
    if (url && new URL(url).origin !== origin) {
      throw new Error(`Ultravox paging URL is not on ${origin}: ${url}`);
    }
    if (page % 20 === 0) log({ page, listed: listed.length, total }, 'listing Ultravox calls');
  }

  // Check `created` here too: if Ultravox ignored toDate, recent calls would
  // otherwise be deleted.
  const recent = listed.filter((c) => !(new Date(c.created) < cutoff));
  const old = listed.filter((c) => new Date(c.created) < cutoff);
  const notEnded = old.filter((c) => !c.ended);
  const eligible = old
    .filter((c) => c.ended)
    .sort((a, b) => new Date(a.created) - new Date(b.created));
  const chosen = limit ? eligible.slice(0, limit) : eligible;

  const result = {
    dryRun: !execute,
    cutoff,
    total,
    listed: listed.length,
    skippedRecent: recent.length,
    skippedNotEnded: notEnded.length,
    eligible: eligible.length,
    oldest: eligible[0]?.created,
    newest: eligible[eligible.length - 1]?.created,
    sample: chosen.slice(0, 5),
    deleted: 0,
    alreadyGone: 0,
    failed: 0,
    failures: [],
  };
  if (!execute) return result;

  let next = 0;
  let consecutiveFailures = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && next < chosen.length) {
      const call = chosen[next++];
      try {
        await withRetry(() => http.delete(`calls/${call.callId}`), { sleep });
        result.deleted++;
        consecutiveFailures = 0;
      } catch (err) {
        if (err?.response?.status === 404) {
          result.alreadyGone++;
          continue;
        }
        result.failed++;
        result.failures.push({ callId: call.callId, status: err?.response?.status, message: err?.message });
        if (++consecutiveFailures >= 10) stopped = true;
      }
      const done = result.deleted + result.alreadyGone + result.failed;
      if (done % 500 === 0) log({ done, of: chosen.length, deleted: result.deleted }, 'deleting Ultravox calls');
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  result.stoppedEarly = stopped;
  if (result.failures.length > 20) result.failures = result.failures.slice(0, 20);
  return result;
}
