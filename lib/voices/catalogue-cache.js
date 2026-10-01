import defaultLogger from '../logger.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const DEFAULT_DEADLINE_MS = 30 * 1000;
const DEFAULT_RETRY_MS = 30 * 1000;

/**
 * A vendor voice catalogue, loaded once and refreshed in the background: a stale one is served
 * while one refresh runs, and every load has a deadline that does not rely on the loader
 * honouring an abort. On staging (2026-10-01) a load that never settled held every voice list
 * for ten minutes. A failed refresh keeps the last good catalogue for `retryMs` before retrying.
 *
 * @param {object} p
 * @param {string} p.name vendor, for logs
 * @param {() => Promise<any>} p.load fetches and maps the catalogue
 * @param {number} [p.ttlMs]
 * @param {number} [p.deadlineMs]
 * @param {number} [p.retryMs]
 * @param {() => number} [p.now]
 */
export function catalogueCache({
  name,
  load,
  ttlMs = DEFAULT_TTL_MS,
  deadlineMs = DEFAULT_DEADLINE_MS,
  retryMs = DEFAULT_RETRY_MS,
  now = Date.now,
}) {
  let value;
  let loadedAt = 0;
  let failedAt;
  let inflight;

  const refresh = (logger) => {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no answer after ${deadlineMs} ms`)), deadlineMs);
    });
    inflight = Promise.race([Promise.resolve().then(load), deadline])
      .then((loaded) => {
        value = loaded;
        loadedAt = now();
        failedAt = undefined;
        return value;
      })
      .catch((err) => {
        failedAt = now();
        logger.error({ vendor: name, error: err?.message, keptStale: value !== undefined }, 'voice catalogue fetch failed');
        if (value === undefined) throw err;
        return value;
      })
      .finally(() => {
        clearTimeout(timer);
        inflight = undefined;
      });
    return inflight;
  };

  return {
    /** The catalogue; waits only when none has loaded yet. Throws if that first load fails. */
    async get({ logger = defaultLogger } = {}) {
      const t = now();
      const fresh = value !== undefined && t - loadedAt < ttlMs;
      if (fresh) return value;
      const backingOff = failedAt !== undefined && t - failedAt < retryMs;
      if (value !== undefined) {
        if (!inflight && !backingOff) refresh(logger).catch(() => {});
        return value;
      }
      return inflight || refresh(logger);
    },
    /** Forget everything (tests). */
    reset() {
      value = undefined;
      loadedAt = 0;
      failedAt = undefined;
      inflight = undefined;
    },
  };
}

/** `promise`, or `onTimeout()` after `ms`; the promise carries on and can still fill its cache. */
export function withinMs(promise, ms, onTimeout) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(onTimeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
