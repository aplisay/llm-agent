/**
 * OAuth → BFF session hand-off (Google sign-in for polite-ai).
 *
 * polite-ai holds the better-auth session in a first-party httpOnly cookie on
 * ITS domain (BFF pattern); Google OAuth terminates here (better-auth's
 * /api/auth/callback/google) and sets the session cookie on OUR domain — a
 * different registrable domain, so polite-ai can never see it. This route
 * bridges the two: better-auth's OAuth callbackURL points here, the browser
 * arrives carrying the just-created better-auth session cookie, and we mint a
 * one-time token (oneTimeToken plugin: 1-min TTL, single-use, hashed at rest)
 * bound to that session. polite-ai exchanges it server-to-server via
 * POST /api/auth/one-time-token/verify for the same session's bearer token.
 *
 * SECURITY:
 *  - The token is delivered in the BODY of an auto-submitting POST form, never
 *    in a URL — keeps it out of Location headers, browser history, and Cloud
 *    Run access logs. (Consequence for polite-ai: its nonce cookie must be
 *    SameSite=None in production, since Lax cookies don't ride cross-site
 *    POSTs.)
 *  - The egress destination is EXACT: reconstructed server-side from
 *    POLITE_SITE_URL (fallback: WAITLIST_CALLBACK_URL's origin) plus a fixed
 *    path. Deliberately NOT validated against BETTER_AUTH_TRUSTED_ORIGINS —
 *    that list also carries the playground origin, and a token minted here is
 *    a full session credential; it must only ever be sent to the polite-ai
 *    callback. No `to`/redirect parameter is accepted at all.
 *  - `nonce` is polite-ai's CSRF double-submit value (round-tripped through
 *    better-auth's state → this query param → the form body, and compared
 *    against polite-ai's httpOnly cookie). It is validated to a strict charset
 *    before being echoed into HTML.
 *  - Failures never strand the browser on this domain: they redirect to the
 *    polite-ai login page with a coarse error code.
 */
import { auth } from './index.js';
import { fromNodeHeaders } from 'better-auth/node';

const CALLBACK_PATH = '/auth/google/callback';
const NONCE_RE = /^[A-Za-z0-9_-]{16,128}$/;

/** polite-ai's public origin: POLITE_SITE_URL, else WAITLIST_CALLBACK_URL's origin. */
function politeOrigin() {
  const src = process.env.POLITE_SITE_URL || process.env.WAITLIST_CALLBACK_URL;
  try {
    return src ? new URL(src).origin : null;
  } catch {
    return null;
  }
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export default function mountOauthHandoff(server, logger, { limiter } = {}) {
  if (!auth) return;
  const origin = politeOrigin();
  if (!origin) {
    logger.error(
      'oauth-handoff NOT mounted: neither POLITE_SITE_URL nor WAITLIST_CALLBACK_URL is set, so the hand-off destination is unknown',
    );
    return;
  }
  const action = `${origin}${CALLBACK_PATH}`;
  const loginError = (code) => `${origin}/login?error=${code}`;

  /**
   * FIRST hop — GET /api/oauth-handoff/start?nonce=…
   *
   * The browser must navigate THROUGH this origin to initiate: better-auth's
   * OAuth callback double-submit-checks a signed `state` cookie it sets on the
   * sign-in/social response (dist/state.mjs "State not persisted correctly").
   * If polite-ai's SERVER called sign-in/social (BFF style), that Set-Cookie
   * would die with the server's fetch and every callback would fail
   * state_mismatch. Here the sign-in/social happens server-side via auth.api
   * but on THIS origin during a top-level navigation, so the returned state
   * cookie is forwarded to the browser first-party, then the browser is 302'd
   * on to Google.
   */
  const startHandler = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');

    const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
    if (!NONCE_RE.test(nonce)) {
      logger.warn({ path: req.originalUrl }, 'oauth-handoff/start: missing/malformed nonce');
      return res.redirect(302, loginError('oauth_retry'));
    }

    try {
      const { headers, response } = await auth.api.signInSocial({
        body: {
          provider: 'google',
          // Relative → resolves against our own baseURL at the callback 302;
          // trusted by the origin check as a relative path. Second hop below.
          callbackURL: `/api/oauth-handoff?nonce=${nonce}`,
          errorCallbackURL: `${origin}${CALLBACK_PATH}`,
          disableRedirect: true,
        },
        returnHeaders: true,
      });
      const url = response?.url;
      if (!url) throw new Error('no authorize URL (Google provider configured?)');
      // Forward better-auth's cookies (the signed state cookie) to the browser.
      for (const cookie of headers?.getSetCookie?.() ?? []) res.append('Set-Cookie', cookie);
      return res.redirect(302, url);
    } catch (err) {
      logger.warn({ err: err?.message, status: err?.status }, 'oauth-handoff/start: sign-in/social failed');
      return res.redirect(302, loginError('oauth_retry'));
    }
  };

  /** SECOND hop — better-auth's post-callback redirect lands here (see below). */
  const handler = async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('Referrer-Policy', 'no-referrer');

    const nonce = typeof req.query.nonce === 'string' ? req.query.nonce : '';
    if (!NONCE_RE.test(nonce)) {
      logger.warn({ path: req.originalUrl }, 'oauth-handoff: missing/malformed nonce');
      return res.redirect(302, loginError('oauth_retry'));
    }

    let token;
    try {
      // Session comes from the better-auth cookie the browser carries (set
      // moments ago by the OAuth callback on this same origin). No session →
      // better-auth throws UNAUTHORIZED. disableClientRequest does not apply
      // to server-side api calls, so only this route can mint tokens.
      ({ token } = await auth.api.generateOneTimeToken({ headers: fromNodeHeaders(req.headers) }));
    } catch (err) {
      logger.warn({ err: err?.message, status: err?.status }, 'oauth-handoff: no session / generate failed');
      return res.redirect(302, loginError('oauth_retry'));
    }

    // Auto-submitting POST form: token travels in the request BODY to the fixed
    // polite-ai callback — never in a URL. <noscript> keeps a manual fallback.
    res.status(200).type('html').send(
      `<!doctype html>
<html><head><meta charset="utf-8"><title>Signing you in…</title><meta name="robots" content="noindex"></head>
<body onload="document.forms[0].submit()">
<form method="POST" action="${escapeHtml(action)}">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<input type="hidden" name="nonce" value="${escapeHtml(nonce)}">
<noscript><button type="submit">Continue to polite.ai</button></noscript>
</form>
</body></html>`,
    );
  };

  if (limiter) {
    server.get('/api/oauth-handoff/start', limiter, startHandler);
    server.get('/api/oauth-handoff', limiter, handler);
  } else {
    server.get('/api/oauth-handoff/start', startHandler);
    server.get('/api/oauth-handoff', handler);
  }
  logger.info({ destination: action }, 'mounted oauth-handoff at /api/oauth-handoff (+/start)');
}
