/**
 * Balance callbacks (Phase 5) — fire an org's configured `balanceLow` /
 * `balanceNegative` webhook when its spendable balance crosses a threshold, so
 * the frontend can react (auto top-up, or set `billingBlocked`). Modelled on the
 * HMAC-signed outbound call-hook (lib/call-hook.js) and sent through the same
 * never-throw `sendCallHook` transport.
 *
 * Config lives in `Organisation.billingConfig`:
 *   { callbackUrl, hashKey, balanceLowPennies }
 *
 * Firing is **edge-triggered** (only when a settle CROSSES the threshold,
 * previous ≥ threshold > next) and **best-effort at-most-once**: it compares the
 * in-memory pre-settle balance to the post-settle value, so under heavily
 * concurrent settles on one org it may rarely miss or duplicate — acceptable for a
 * notify-and-react signal (the frontend re-reads the balance). All money crosses
 * the 1e4 micro-pence↔pence scale.
 *
 * @module lib/balance-callback
 */
import { createHmac } from 'crypto';
import { sendCallHook } from './call-hook.js';
import defaultLogger from './logger.js';

const MICROS_PER_PENNY = 10000;

/** HMAC-SHA256 over hashKey|organisationId|event|balanceMicros (mirrors call-hook signing). */
export function signBalanceCallback({ hashKey, organisationId, event, balanceMicros }) {
  const canonical = `${hashKey}|${organisationId}|${event}|${balanceMicros}`;
  return createHmac('sha256', hashKey).update(canonical).digest('hex');
}

/**
 * Basic SSRF guard for an org-supplied callback URL: require http(s) and reject
 * obvious internal/loopback/link-local/private hosts. NOT bulletproof (no DNS
 * resolution / rebinding protection) — full hardening is a cross-cutting follow-up
 * that should also cover the existing call-hook. Better than an open POST.
 */
export function isSafeCallbackUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  // IPv4 private / loopback / link-local / metadata.
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || host === '169.254.169.254'
    || /^169\.254\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host === '0.0.0.0') return false;
  // IPv6 loopback / link-local / unique-local.
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) return false;
  return true;
}

/**
 * Fire balanceLow / balanceNegative callbacks for an org if a settle moved its
 * balance across a threshold. Never throws.
 *
 * @param {object} org     Organisation (uses id + billingConfig)
 * @param {number} previousMicros  balance BEFORE the settle (micro-pence)
 * @param {number} nextMicros      balance AFTER the settle (micro-pence)
 * @param {object} [opts]
 */
export async function maybeFireBalanceCallbacks(org, previousMicros, nextMicros, { log = defaultLogger, send = sendCallHook } = {}) {
  try {
    const cfg = org?.billingConfig;
    if (!cfg?.callbackUrl || !cfg?.hashKey) return;
    if (previousMicros == null || nextMicros == null || nextMicros >= previousMicros) return; // only on a decrease

    const events = [];
    if (previousMicros >= 0 && nextMicros < 0) events.push('balanceNegative');
    const lowMicros = cfg.balanceLowPennies != null ? Number(cfg.balanceLowPennies) * MICROS_PER_PENNY : null;
    if (lowMicros != null && previousMicros >= lowMicros && nextMicros < lowMicros) events.push('balanceLow');
    if (!events.length) return;

    if (!isSafeCallbackUrl(cfg.callbackUrl)) {
      log.warn({ organisationId: org.id, url: cfg.callbackUrl }, 'balance-callback: refusing unsafe callback URL');
      return;
    }

    for (const event of events) {
      const payload = {
        event,
        organisationId: org.id,
        balancePennies: Math.round(nextMicros / MICROS_PER_PENNY),
        thresholdPennies: event === 'balanceLow' ? Number(cfg.balanceLowPennies) : 0,
        at: new Date().toISOString(),
      };
      payload.hash = signBalanceCallback({ hashKey: cfg.hashKey, organisationId: org.id, event, balanceMicros: nextMicros });
      // eslint-disable-next-line no-await-in-loop
      await send({ callHook: { url: cfg.callbackUrl }, payload, logger: log });
    }
  } catch (err) {
    log.warn({ err, organisationId: org?.id }, 'balance-callback: failed to fire');
  }
}

export default maybeFireBalanceCallbacks;
