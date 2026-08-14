// Send hooks (lib/auth/email-hooks.js). The load-bearing contract: a send
// failure is logged and SWALLOWED — a rethrow from sendVerificationEmail
// becomes better-call's bare 500, which fires only for registered-and-
// unverified addresses (an enumeration oracle during any mail outage).
import { createSendHooks } from '../lib/auth/email-hooks.js';
import { loadBrands } from '../lib/auth/email-brands.js';

function harness({ sendFails = false, brands } = {}) {
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
  return { hooks: createSendHooks({ emailClient, logger, brands }), sent, logs };
}

const user = { email: 'someone@example.com' };

const BRANDS = loadBrands({
  EMAIL_BRANDS: JSON.stringify({
    default: 'aplisay',
    brands: {
      aplisay: { from: 'hello@aplisay.com' },
      'polite-ai': {
        from: 'hello@polite.ai',
        fromName: 'polite.ai',
        productName: 'polite.ai',
        tagline: 'Communication, reimagined.',
      },
    },
  }),
}, { logger: { info: () => {}, error: () => {} } });

const branded = (key) => ({ headers: new Headers({ 'x-email-brand': key }) });

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

// The persona named on the request decides sender AND wording. Both hooks read
// it from the request better-auth hands them — the reset one gets `ctx.request`
// from dist/api/routes/password.mjs, the verification one already used it for
// x-onboarding-invite.
describe('sender personas (x-email-brand)', () => {
  it('sends verification in the requested persona', async () => {
    const { hooks, sent } = harness({ brands: BRANDS });
    await hooks.sendVerificationEmail({ user, url: 'https://x/v' }, branded('polite-ai'));
    expect(sent[0].from).toEqual({ email: 'hello@polite.ai', name: 'polite.ai' });
    expect(sent[0].subject).toBe('Confirm your polite.ai email address');
  });

  it('sends reset-password in the requested persona', async () => {
    const { hooks, sent } = harness({ brands: BRANDS });
    await hooks.sendResetPassword({ user, url: 'https://x/r' }, branded('polite-ai'));
    expect(sent[0].from).toEqual({ email: 'hello@polite.ai', name: 'polite.ai' });
    expect(sent[0].subject).toBe('Set your polite.ai password');
  });

  it('falls back to the default persona when the header is absent or forged', async () => {
    const { hooks, sent } = harness({ brands: BRANDS });
    await hooks.sendVerificationEmail({ user, url: 'https://x/v' }, undefined);
    await hooks.sendVerificationEmail({ user, url: 'https://x/v' }, branded('evil@attacker.example'));
    expect(sent.map((m) => m.from.email)).toEqual(['hello@aplisay.com', 'hello@aplisay.com']);
  });

  it('omits `from` with no personas configured, leaving the client default sender', async () => {
    const { hooks, sent } = harness();
    await hooks.sendVerificationEmail({ user, url: 'https://x/v' }, branded('polite-ai'));
    expect(sent[0].from).toBeUndefined();
    expect(sent[0].subject).toBe('Confirm your email address');
  });
});
