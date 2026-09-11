/**
 * Whether a Google sign-in started through the hand-off may create an account.
 *
 * The hand-off start (lib/auth/oauth-handoff.js) is how a client system sends a
 * browser to Google. That client decides whether the sign-in may create a new
 * account: `?signup=1` on the start URL allows it. Without it, a Google account
 * with no user here is refused before any row is written, and better-auth sends
 * the browser to the errorCallbackURL with `?error=signup_disabled`, the same
 * code its own `disableSignUp` option uses.
 *
 * The choice rides the OAuth state as `additionalData` and is read back by a
 * user `create.before` database hook (lib/auth/index.js). better-auth treats
 * additionalData as caller-supplied, and that is fine here: the flag can only
 * REFUSE, only in the flow that carries it, and a caller that leaves it out
 * gets the implicit sign-up every direct sign-in/social caller already has.
 * Sign-ins started any other way are not affected.
 */

/** OAuth-state key the hand-off start sets (in additionalData). */
export const HANDOFF_SIGNUP_KEY = 'handoffSignUp';

/** Error code the browser is sent back with; the same as better-auth's own. */
export const SIGNUP_DISABLED_CODE = 'signup_disabled';

/** True when the hand-off start was asked to allow sign-up (`?signup=1`). */
export function signUpRequested(query) {
  return query?.signup === '1';
}

/** True when this OAuth state belongs to a hand-off sign-in that may not create an account. */
export function refusesSignUp(state) {
  return state != null && state[HANDOFF_SIGNUP_KEY] === false;
}

/**
 * The user `create.before` database hook. `getOAuthState` and `APIError` come
 * from better-auth/api; they are passed in so tests can drive the hook.
 *
 * It throws rather than returning false. better-auth turns a false into a
 * generic "unable to create user", but it rethrows an APIError, and its OAuth
 * callback sends an APIError's `code` to the errorCallbackURL.
 */
export function createHandoffSignUpHook({ getOAuthState, APIError }) {
  return async function refuseHandoffSignUp() {
    let state = null;
    try {
      state = await getOAuthState();
    } catch {
      // No request state: this is not an OAuth request, so there is nothing to refuse.
      state = null;
    }
    if (refusesSignUp(state)) {
      throw new APIError('FORBIDDEN', {
        code: SIGNUP_DISABLED_CODE,
        message: 'Sign-up is not allowed for this sign-in',
      });
    }
  };
}
