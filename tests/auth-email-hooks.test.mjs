// Send hooks (lib/auth/email-hooks.js). The load-bearing contract: a send
// failure is logged and SWALLOWED — a rethrow from sendVerificationEmail
// becomes better-call's bare 500, which fires only for registered-and-
// unverified addresses (an enumeration oracle during any mail outage).
import { createSendHooks } from '../lib/auth/email-hooks.js';

function harness({ sendFails = false } = {}) {
  const sent = [];
  const logs = { info: [], error: [] };
  const emailClient = {
    provider: 'test',
    send: async (msg) => {
      if (sendFails) throw new Error('smtp2go down');
      sent.push(msg);
      return { id: 'msg-1' };
    },
  };
  const logger = {
    info: (...a) => logs.info.push(a),
    error: (...a) => logs.error.push(a),
  };
  return { hooks: createSendHooks({ emailClient, logger }), sent, logs };
}

const user = { email: 'someone@example.com' };

describe('sendResetPassword', () => {
  it('sends and logs on success', async () => {
    const { hooks, sent, logs } = harness();
    await hooks.sendResetPassword({ user, url: 'https://x/reset?token=t' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(user.email);
    expect(sent[0].text).toContain('https://x/reset?token=t');
    expect(logs.error).toHaveLength(0);
  });

  it('RESOLVES (never rejects) when the send fails, logging the failure', async () => {
    const { hooks, logs } = harness({ sendFails: true });
    await expect(hooks.sendResetPassword({ user, url: 'https://x/r' })).resolves.toBeUndefined();
    expect(logs.error).toHaveLength(1);
    expect(logs.error[0][1]).toBe('reset-password email send FAILED');
  });
});

describe('sendVerificationEmail', () => {
  it('sends and logs on success', async () => {
    const { hooks, sent } = harness();
    await hooks.sendVerificationEmail({ user, url: 'https://x/verify?token=t' }, undefined);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('https://x/verify?token=t');
  });

  it('RESOLVES (never rejects) when the send fails, logging the failure', async () => {
    const { hooks, logs } = harness({ sendFails: true });
    await expect(
      hooks.sendVerificationEmail({ user, url: 'https://x/v' }, undefined),
    ).resolves.toBeUndefined();
    expect(logs.error).toHaveLength(1);
    expect(logs.error[0][1]).toBe('verification email send FAILED');
  });

  it('suppresses the email for invite-completion signups', async () => {
    const { hooks, sent, logs } = harness();
    const request = { headers: new Headers({ 'x-onboarding-invite': 'complete' }) };
    await hooks.sendVerificationEmail({ user, url: 'https://x/v' }, request);
    expect(sent).toHaveLength(0);
    expect(logs.info.some(([, msg]) => String(msg).includes('suppressed'))).toBe(true);
  });
});
