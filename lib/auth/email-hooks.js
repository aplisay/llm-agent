/**
 * Log and absorb send failures, and bound awaits below the auth timing floor to avoid account enumeration. See issue
 * #208. Sender personas come only from the operator-approved brand table; see PR #222.
 */
import { composeMessage, resolveBrand } from './email-brands.js';

const BRAND_HEADER = 'x-email-brand';

// Below better-auth's MINIMUM_MS = 500 constant-time floor on
// /send-verification-email, so a slow or hanging send can never push the
// sending branch past the floor that exists to hide it.
const SEND_DEADLINE_MS = 250;

// Keep the deadline timer referenced so a hung send still settles the race when the event loop is otherwise idle. See
// PR #210.
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
