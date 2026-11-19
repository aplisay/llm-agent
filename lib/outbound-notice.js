/**
 * The notice an organisation's front end gets the first time on a day that an
 * outbound limit refuses a call (lib/outbound-policy.js). It goes to the
 * callback the organisation already has for its balance (`billingConfig`), is
 * signed the same way, and the front end writes the email to the admins in its
 * own words. Never throws.
 *
 * @module lib/outbound-notice
 */
import { createHmac } from 'crypto';
import { sendCallHook } from './call-hook.js';
import { isSafeCallbackUrl } from './balance-callback.js';
import defaultLogger from './logger.js';

export const OUTBOUND_LIMIT_EVENT = 'outboundLimitReached';

/** HMAC-SHA256 over hashKey|organisationId|event|code|day. */
export function signOutboundNotice({ hashKey, organisationId, code, day }) {
  const canonical = `${hashKey}|${organisationId}|${OUTBOUND_LIMIT_EVENT}|${code}|${day}`;
  return createHmac('sha256', hashKey).update(canonical).digest('hex');
}

/**
 * @param {object} organisation  uses `id` and `billingConfig`
 * @param {{ code: string, reason: string, limit?: string, value?: number, day: string, at: Date }} refusal
 * @returns {Promise<boolean|null>} true when sent, false when the send failed and
 *   may be tried again, null when there is nowhere to send it
 */
export async function sendOutboundNotice(organisation, { code, reason, limit, value, day, at }, { log = defaultLogger, send = sendCallHook } = {}) {
  try {
    log.warn({ organisationId: organisation?.id, code, limit, value }, 'organisation reached an outbound limit for the first time today');
    const cfg = organisation?.billingConfig;
    if (!cfg?.callbackUrl || !cfg?.hashKey) return null;
    if (!isSafeCallbackUrl(cfg.callbackUrl)) {
      log.warn({ organisationId: organisation.id }, 'outbound notice: refusing unsafe callback URL');
      return null;
    }
    const payload = {
      event: OUTBOUND_LIMIT_EVENT,
      organisationId: organisation.id,
      code,
      limit: limit ?? null,
      value: value ?? null,
      reason,
      day,
      at: at.toISOString(),
      hash: signOutboundNotice({ hashKey: cfg.hashKey, organisationId: organisation.id, code, day }),
    };
    return (await send({ callHook: { url: cfg.callbackUrl }, payload, logger: log })) === true;
  } catch (err) {
    log.warn({ err: err?.message, organisationId: organisation?.id }, 'outbound notice: failed to send');
    return false;
  }
}
