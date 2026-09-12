// Sign-up control for Google sign-ins started through the hand-off
// (lib/auth/handoff-signup.js and lib/auth/oauth-handoff.js). No DB needed:
// the end-to-end part runs a real better-auth instance on its memory adapter,
// with only Google's token endpoint and profile faked.
//
// What must hold:
//   - /api/oauth-handoff/start asks for sign-up only with ?signup=1;
//   - a hand-off sign-in that did not ask is refused before any user, account
//     or session row exists, and the browser goes to errorCallbackURL with
//     ?error=signup_disabled;
//   - an existing user still signs in, and sign-ins started any other way
//     (and email sign-up) are untouched.
import { jest } from '@jest/globals';
import { betterAuth } from 'better-auth';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { APIError, getOAuthState } from 'better-auth/api';
import {
  HANDOFF_SIGNUP_KEY,
  SIGNUP_DISABLED_CODE,
  createHandoffSignUpHook,
  refusesSignUp,
  signUpRequested,
} from '../lib/auth/handoff-signup.js';

const quietLogger = { info() { }, warn() { }, error() { } };

describe('handoff-signup helpers', () => {
  it('reads only signup=1 as a request for sign-up', () => {
    expect(signUpRequested({ signup: '1' })).toBe(true);
    for (const signup of [undefined, '', '0', 'true', 'yes', ['1', '1']]) {
      expect(signUpRequested({ signup })).toBe(false);
    }
    expect(signUpRequested(undefined)).toBe(false);
  });

  it('refuses only a state that says no', () => {
    expect(refusesSignUp({ [HANDOFF_SIGNUP_KEY]: false })).toBe(true);
    expect(refusesSignUp({ [HANDOFF_SIGNUP_KEY]: true })).toBe(false);
    expect(refusesSignUp({})).toBe(false);
    expect(refusesSignUp(null)).toBe(false);
    expect(refusesSignUp(undefined)).toBe(false);
  });

  it('lets the hook pass when there is no request state at all', async () => {
    const hook = createHandoffSignUpHook({
      getOAuthState: async () => { throw new Error('No request state found'); },
      APIError,
    });
    await expect(hook()).resolves.toBeUndefined();
  });
});

describe('hand-off start: who may sign up', () => {
  let mountOauthHandoff;
  beforeAll(async () => {
    // Keep lib/auth/index.js inert: this test brings its own auth instance.
    process.env.BETTER_AUTH_ENABLED = 'false';
    process.env.POLITE_SITE_URL = 'https://client.example';
    ({ default: mountOauthHandoff } = await import('../lib/auth/oauth-handoff.js'));
  });

  function response() {
    const out = { cookies: [] };
    out.set = () => out;
    out.append = (_name, value) => { out.cookies.push(value); return out; };
    out.redirect = (code, url) => { out.code = code; out.location = url; return out; };
    return out;
  }

  async function start(query) {
    const signInSocial = jest.fn(async () => ({
      headers: new Headers(),
      response: { url: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' },
    }));
    const routes = {};
    const server = { get: (path, ...handlers) => { routes[path] = handlers.at(-1); } };
    mountOauthHandoff(server, quietLogger, { auth: { api: { signInSocial } } });
    const res = response();
    await routes['/api/oauth-handoff/start']({ query: { nonce: 'n'.repeat(32), ...query }, originalUrl: '/start' }, res);
    return { body: signInSocial.mock.calls[0]?.[0]?.body, res };
  }

  it('asks for no sign-up by default', async () => {
    const { body, res } = await start({});
    expect(body.additionalData).toEqual({ [HANDOFF_SIGNUP_KEY]: false });
    expect(res.code).toBe(302);
    expect(res.location).toMatch(/^https:\/\/accounts\.google\.com\//);
  });

  it('asks for sign-up with signup=1', async () => {
    const { body } = await start({ signup: '1' });
    expect(body.additionalData).toEqual({ [HANDOFF_SIGNUP_KEY]: true });
  });

  it('treats any other signup value as no', async () => {
    const { body } = await start({ signup: 'true' });
    expect(body.additionalData).toEqual({ [HANDOFF_SIGNUP_KEY]: false });
  });
});

describe('better-auth end to end: the Google callback', () => {
  const realFetch = globalThis.fetch;
  let profileEmail = 'new@example.com';

  beforeAll(() => {
    // Google's token endpoint is the only network call the callback makes; the
    // profile comes from the getUserInfo override below.
    globalThis.fetch = async (input, init) => {
      // better-fetch hands over a URL object, not a string.
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(
          JSON.stringify({ access_token: 'access', expires_in: 3600, token_type: 'Bearer', scope: 'openid email profile' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return realFetch(input, init);
    };
  });
  afterAll(() => { globalThis.fetch = realFetch; });

  function makeAuth() {
    const db = { user: [], session: [], account: [], verification: [] };
    const auth = betterAuth({
      baseURL: 'http://localhost:4000',
      basePath: '/api/auth',
      secret: 'handoff-signup-test-secret-0123456789abcdef',
      database: memoryAdapter(db),
      trustedOrigins: ['https://client.example'],
      logger: { disabled: true },
      emailAndPassword: { enabled: true },
      socialProviders: {
        google: {
          clientId: 'client-id',
          clientSecret: 'client-secret',
          getUserInfo: async () => ({
            user: { id: `sub-${profileEmail}`, email: profileEmail, name: 'Test Person', emailVerified: true },
            data: { sub: `sub-${profileEmail}`, email: profileEmail, email_verified: true, name: 'Test Person' },
          }),
        },
      },
      account: { accountLinking: { enabled: true, trustedProviders: ['google'] } },
      databaseHooks: {
        user: { create: { before: createHandoffSignUpHook({ getOAuthState, APIError }) } },
      },
    });
    return { auth, db };
  }

  async function signInWithGoogle(auth, email, additionalData) {
    profileEmail = email;
    const { headers, response } = await auth.api.signInSocial({
      body: {
        provider: 'google',
        callbackURL: '/after',
        errorCallbackURL: 'https://client.example/cb',
        disableRedirect: true,
        ...(additionalData ? { additionalData } : {}),
      },
      returnHeaders: true,
    });
    const state = new URL(response.url).searchParams.get('state');
    const cookie = headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const res = await auth.handler(new Request(
      `http://localhost:4000/api/auth/callback/google?code=code-1&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    ));
    return { status: res.status, location: res.headers.get('location') };
  }

  it('refuses a new account when the hand-off did not ask for sign-up', async () => {
    const { auth, db } = makeAuth();
    const out = await signInWithGoogle(auth, 'new@example.com', { [HANDOFF_SIGNUP_KEY]: false });
    expect(out.status).toBe(302);
    const where = new URL(out.location);
    expect(where.origin + where.pathname).toBe('https://client.example/cb');
    expect(where.searchParams.get('error')).toBe(SIGNUP_DISABLED_CODE);
    expect(db.user).toHaveLength(0);
    expect(db.account).toHaveLength(0);
    expect(db.session).toHaveLength(0);
  });

  it('creates the account when the hand-off asked for sign-up', async () => {
    const { auth, db } = makeAuth();
    const out = await signInWithGoogle(auth, 'invited@example.com', { [HANDOFF_SIGNUP_KEY]: true });
    expect(out.status).toBe(302);
    expect(out.location).toMatch(/\/after$/);
    expect(db.user.map((u) => u.email)).toEqual(['invited@example.com']);
  });

  it('still signs in an existing user when sign-up was not asked for', async () => {
    const { auth, db } = makeAuth();
    const now = new Date();
    db.user.push({ id: 'existing-user', email: 'known@example.com', emailVerified: true, name: 'Known', createdAt: now, updatedAt: now });
    const out = await signInWithGoogle(auth, 'known@example.com', { [HANDOFF_SIGNUP_KEY]: false });
    expect(out.location).toMatch(/\/after$/);
    expect(db.user).toHaveLength(1);
    expect(db.account.map((a) => a.userId)).toEqual(['existing-user']);
  });

  it('leaves a sign-in started any other way alone', async () => {
    const { auth, db } = makeAuth();
    const out = await signInWithGoogle(auth, 'direct@example.com');
    expect(out.location).toMatch(/\/after$/);
    expect(db.user.map((u) => u.email)).toEqual(['direct@example.com']);
  });

  it('leaves email sign-up alone', async () => {
    const { auth, db } = makeAuth();
    await auth.api.signUpEmail({ body: { email: 'mail@example.com', password: 'a-long-password-1', name: 'Mail' } });
    expect(db.user.map((u) => u.email)).toEqual(['mail@example.com']);
  });
});
