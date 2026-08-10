/**
 * The outbound-email hooks for better-auth (password reset + verification),
 * factored out of index.js so their contract is testable in isolation.
 *
 * CONTRACT: a send failure is logged and SWALLOWED — never rethrown. better-auth
 * runs both hooks through `runInBackgroundOrAwait`, which only really runs them
 * in the background when `advanced.backgroundTasks.handler` is configured (it is
 * — see index.js); without it the send is AWAITED inline, and on
 * `/send-verification-email` the hook is reached ONLY for a
 * registered-and-unverified address. A rethrow there would become better-call's
 * bare 500 — so during any smtp2go outage the
 * status code says exactly "this address is registered and unverified": an
 * account-enumeration oracle on the very handler better-auth gives a 500ms
 * constant-time floor to hide the same distinction on the timing channel
 * (polite-ai-website PR #197 findings). Swallowing on BOTH paths keeps every
 * response account-blind; a mail outage is an OPERATOR signal, carried by the
 * `… email send FAILED` error logs below — alert on those, they are the only
 * signal left by design.
 */

export function createSendHooks({ emailClient, logger }) {
  return {
    // Enabling sendResetPassword also turns on the Firebase->Better-Auth bridge
    // for PASSWORD users: a migrating Firebase row has no Better-Auth credential,
    // and resetPassword *creates* a `credential` account on that existing row
    // when none exists — so setting a password lands on the existing user
    // (id + data preserved), never a dup.
    sendResetPassword: async ({ user, url }) => {
      try {
        const info = await emailClient.send({
          to: user.email,
          subject: 'Set your polite.ai password',
          text: [
            'Open this link to set your polite.ai password:',
            '',
            url,
            '',
            "If you didn't request this, you can safely ignore this email.",
          ].join('\n'),
        });
        logger.info({ to: user.email, transport: emailClient.provider, id: info?.id }, 'reset-password email sent');
      } catch (err) {
        logger.error({ err: err?.message, to: user.email, transport: emailClient.provider }, 'reset-password email send FAILED');
      }
    },

    sendVerificationEmail: async ({ user, url }, request) => {
      // Invite-completion signups (polite-ai onboarding) already proved address
      // ownership via the emailed invite link — skip the redundant double opt-in
      // mail. Spoofing the header only suppresses the sender's own email; the
      // account is provisional-gated regardless.
      if (request?.headers?.get('x-onboarding-invite') === 'complete') {
        logger.info({ to: user.email }, 'verification email suppressed (invite-completion signup)');
        return;
      }
      try {
        const info = await emailClient.send({
          to: user.email,
          subject: 'Confirm your polite.ai subscription',
          text: [
            'Thanks for registering your interest in polite.ai.',
            '',
            'Please confirm your subscription by opening this link:',
            url,
            '',
            "If you didn't request this, you can safely ignore this email.",
            '',
            '— polite.ai · Communication, reimagined.',
          ].join('\n'),
        });
        logger.info({ to: user.email, transport: emailClient.provider, id: info?.id }, 'verification email sent');
      } catch (err) {
        logger.error({ err: err?.message, to: user.email, transport: emailClient.provider }, 'verification email send FAILED');
      }
    },
  };
}

export default createSendHooks;
