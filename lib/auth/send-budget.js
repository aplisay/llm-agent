/**
 * Check address/global budgets before account lookup to avoid enumeration; create storage lazily and fail open on
 * storage errors. See PR #199.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CLEANUP_EVERY = 1000;

const CREATE_SQL = `
  CREATE TABLE IF NOT EXISTS auth_send_limits (
    key          text PRIMARY KEY,
    window_start bigint  NOT NULL,
    count        integer NOT NULL
  )`;

// Atomic bump-and-read: reset the window if it has expired, else increment.
// Always increments (an over-cap request still counts), so `count <= cap` is
// the allow test and a hammered bucket stays closed for a full window from its
// first request.
const BUMP_SQL = `
  INSERT INTO auth_send_limits (key, window_start, count) VALUES ($1, $2, 1)
  ON CONFLICT (key) DO UPDATE SET
    count        = CASE WHEN auth_send_limits.window_start <= $3 THEN 1 ELSE auth_send_limits.count + 1 END,
    window_start = CASE WHEN auth_send_limits.window_start <= $3 THEN $2 ELSE auth_send_limits.window_start END
  RETURNING count`;

export function createSendBudget({ pool, logger, caps }) {
  const { addressHourly, addressDaily, globalHourly } = caps;
  let ensured = null;
  let calls = 0;

  function ensure() {
    if (!ensured) {
      ensured = pool.query(CREATE_SQL).catch((err) => {
        ensured = null; // retry on the next consume
        throw err;
      });
    }
    return ensured;
  }

  async function bump(key, windowMs, now) {
    const { rows } = await pool.query(BUMP_SQL, [key, now, now - windowMs]);
    return rows[0].count;
  }

  /**
   * Spend one unit of budget for a send request. Returns
   * `{ allowed: boolean, scope?: 'address-hour'|'address-day'|'global-hour' }`.
   * Never throws.
   */
  async function consume({ kind, email }) {
    const now = Date.now();
    const addr = String(email).trim().toLowerCase();
    try {
      await ensure();
      if ((++calls % CLEANUP_EVERY) === 0) {
        // Opportunistic sweep of long-dead windows; failure is irrelevant.
        pool.query('DELETE FROM auth_send_limits WHERE window_start < $1', [now - 7 * DAY_MS])
          .catch(() => { });
      }
      if (await bump(`h:${kind}:${addr}`, HOUR_MS, now) > addressHourly) {
        return { allowed: false, scope: 'address-hour' };
      }
      if (await bump(`d:${kind}:${addr}`, DAY_MS, now) > addressDaily) {
        return { allowed: false, scope: 'address-day' };
      }
      // Global last, so per-address abuse can't spend the platform's budget.
      if (await bump('g:sends', HOUR_MS, now) > globalHourly) {
        return { allowed: false, scope: 'global-hour' };
      }
      return { allowed: true };
    } catch (err) {
      logger.error({ err: err?.message }, 'send-budget check failed — failing OPEN (send allowed)');
      return { allowed: true, degraded: true };
    }
  }

  return { consume };
}

export default createSendBudget;
