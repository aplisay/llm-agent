/**
 * The outbound-email hooks for better-auth (password reset + verification),
 * factored out of index.js so their contract is testable in isolation.
 *
 * CONTRACT 1 — a send failure is logged and SWALLOWED, never rethrown.
 * better-auth runs `sendResetPassword` through `runInBackgroundOrAwait` (which
 * swallows), but AWAITS `sendVerificationEmail` bare on
 * `/send-verification-email` (better-auth dist/api/routes/email-verification.mjs
 * line 31) — no `advanced.backgroundTasks.handler` can change that — and there
 * the hook is reached ONLY for a registered-and-unverified address. A rethrow
 * there becomes better-call's bare 500 — so during any smtp2go outage the status
 * code says exactly "this address is registered and unverified": an account-
 * enumeration oracle on the very handler better-auth gives a 500ms constant-time
 * floor to hide the same distinction on the timing channel (polite-ai-website PR
 * #197 findings). Swallowing on BOTH paths keeps every response account-blind; a
 * mail outage is an OPERATOR signal, carried by the `… email send FAILED` error
 * logs below — alert on those, they are the only signal left by design.
 *
 * CONTRACT 2 — a hook NEVER blocks the request for longer than
 * SEND_DEADLINE_MS. Because of that bare await, swallowing errors is not
 * enough: an smtp2go that HANGS rather than errors stalls the sending branch
 * until the ingress gives up (504) while the no-op branch still returns 200 in
 * ~500ms — the same enumeration oracle, on the latency/status channel
 * (issue #208). So the send is raced against a deadline set BELOW better-auth's
 * constant-time floor: whatever the provider does, both branches return inside
 * that floor and are indistinguishable. On timeout the send simply continues
 * detached, still logging its own outcome through the same swallow. Do NOT
 * convert these into a bare unawaited dispatch — awaiting the *bounded* race is
 * what keeps success/failure logging (and the tests) deterministic.
 *
 * CONTRACT 3 — the SENDER and the COPY belong to the caller, not to this repo.
 * Both hooks read the persona named on the originating request
 * (`x-email-brand`) and compose from the operator's brand table
 * (email-brands.js), so no product's wording is compiled in here. Resolution is
 * a map lookup, costing nothing against the deadline above, and a forged header
 * can only select another operator-approved persona. With no table configured
 * the product-neutral built-ins are sent from the client's own default address,
 * exactly as before personas existed.
 */
import { composeMessage, resolveBrand } from './email-brands.js';

const BRAND_HEADER = 'x-email-brand';

// Below better-auth's MINIMUM_MS = 500 constant-time floor on
// /send-verification-email, so a slow or hanging send can never push the
// sending branch past the floor that exists to hide it.
const SEND_DEADLINE_MS = 250;

// Resolve on whichever comes first: the (already-swallowing) send, or the
// deadline; the loser continues in the background either way. The timer is
// deliberately NOT unref'd — an unref'd one lets an otherwise-idle event loop
// exit while a hung send leaves the race unsettled forever; 250ms of extra
// liveness is a cheaper price than a request that never resolves.
function bounded(sendPromise) {
  return Promise.race([
    sendPromise,
    new Promise((resolve) => { setTimeout(resolve, SEND_DEADLINE_MS); }),
  ]);
}

export function createSendHooks({ emailClient, logger, brands }) {
  const send = async (message, kind) => {
    try {
      const info = await emailClient.send(message);
      logger.info({ to: message.to, transport: emailClient.provider, id: info?.id }, `${kind} email sent`);
    } catch (err) {
      logger.error({ err: err?.message, to: message.to, transport: emailClient.provider }, `${kind} email send FAILED`);
    }
  };

  // The persona the caller asked for, or the operator's default. Never throws
  // and never rejects a key: an unknown one lands where an absent one does.
  const compose = ({ kind, user, url, request }) => composeMessage({
    brand: resolveBrand(brands, request?.headers?.get(BRAND_HEADER)),
    kind,
    to: user.email,
    url,
    name: user.name,
  });

  return {
    // Enabling sendResetPassword also turns on the Firebase->Better-Auth bridge
    // for PASSWORD users: a migrating Firebase row has no Better-Auth credential,
    // and resetPassword *creates* a `credential` account on that existing row
    // when none exists — so setting a password lands on the existing user
    // (id + data preserved), never a dup.
    //
    // better-auth passes the originating request as the second argument here
    // too (dist/api/routes/password.mjs), which is what carries the persona.
    sendResetPassword: ({ user, url }, request) => bounded(send(
      compose({ kind: 'reset-password', user, url, request }),
      'reset-password',
    )),

    sendVerificationEmail: ({ user, url }, request) => {
      // Invite-completion signups (polite-ai onboarding) already proved address
      // ownership via the emailed invite link — skip the redundant double opt-in
      // mail. Spoofing the header only suppresses the sender's own email; the
      // account is provisional-gated regardless.
      if (request?.headers?.get('x-onboarding-invite') === 'complete') {
        logger.info({ to: user.email }, 'verification email suppressed (invite-completion signup)');
        return Promise.resolve();
      }
      return bounded(send(
        compose({ kind: 'verification', user, url, request }),
        'verification',
      ));
    },
  };
}

export default createSendHooks;
