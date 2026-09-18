/**
 * Better-Auth server instance (parallel to Firebase — Phase 0 WIP).
 *
 * This module exports a configured Better-Auth `auth` instance, or `null` when
 * `BETTER_AUTH_ENABLED !== 'true'`. It is gated so that when disabled the
 * `better-auth` package is never imported (the app behaves exactly as before).
 *
 * Design (see docs/better-auth-migration-plan.md):
 *  - Better-Auth's `user` model points at our EXISTING `users` table
 *    (`modelName: 'users'`), with its core fields mapped to our snake_case
 *    columns. Sequelize remains the DDL owner of `users`; Better-Auth owns only
 *    its satellite tables (`session`, `account`, `verification`), created via
 *    `npx @better-auth/cli migrate`.
 *  - Domain columns Better-Auth doesn't know about (role, organisation_id, …)
 *    are populated by Postgres column defaults set in lib/database.js, so a
 *    Better-Auth auto-signup yields a row shaped exactly like a Firebase one.
 *  - Transport is JWT/​session token carried as `Authorization: Bearer` via the
 *    `bearer` plugin — the closest analog to the Firebase ID token the SPA
 *    already sends; verification happens in middleware/auth.js.
 */
import logger from '../logger.js';

const {
  BETTER_AUTH_ENABLED,
  BETTER_AUTH_SECRET,
  BETTER_AUTH_URL,
  BETTER_AUTH_TRUSTED_ORIGINS,
  BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION,
  BETTER_AUTH_GOOGLE_CLIENT_ID,
  BETTER_AUTH_GOOGLE_CLIENT_SECRET,
  AUTH_EMAIL_PER_ADDRESS_HOURLY,
  AUTH_EMAIL_PER_ADDRESS_DAILY,
  AUTH_EMAIL_GLOBAL_HOURLY,
  POSTGRES_DB,
  POSTGRES_USER,
  POSTGRES_HOST,
  POSTGRES_PASSWORD,
  POSTGRES_PORT,
  POSTGRES_KEY,
  POSTGRES_CERT,
  POSTGRES_CA,
  POSTGRES_RO_SERVER_NAME,
} = process.env;

const enabled = BETTER_AUTH_ENABLED === 'true';

let auth = null;

if (enabled) {
  const { betterAuth } = await import('better-auth');
  const { bearer, oneTimeToken } = await import('better-auth/plugins');
  const { createAuthMiddleware, APIError, getOAuthState } = await import('better-auth/api');
  const { Pool } = await import('pg');
  const { createEmailClient } = await import('@aplisay/email');
  const { createSendBudget } = await import('./send-budget.js');
  const { createSendHooks } = await import('./email-hooks.js');
  const { loadBrands } = await import('./email-brands.js');
  const { createHandoffSignUpHook } = await import('./handoff-signup.js');

  if (!BETTER_AUTH_SECRET) {
    logger.error('BETTER_AUTH_ENABLED=true but BETTER_AUTH_SECRET is unset — refusing to boot with broken token signing');
    throw new Error('BETTER_AUTH_SECRET is required when BETTER_AUTH_ENABLED=true');
  }

  // Real outbound email for the verification / password-reset hooks. Reads
  // EMAIL_SEND_* env; logs to the console when unset (dev/preview).
  const emailClient = createEmailClient();
  // Surface the resolved transport at boot. The console provider only PRINTS the
  // email — it never delivers — so warn loudly. NB: nodemon (-e js,mjs,json,yaml)
  // does NOT watch .env, so EMAIL_SEND_* changes need a full restart to take effect.
  if (emailClient.provider === 'console') {
    logger.warn(
      { EMAIL_SEND_TYPE: process.env.EMAIL_SEND_TYPE || '(unset)' },
      'Email transport = CONSOLE: verification/reset emails are LOGGED, not delivered. '
      + 'Set EMAIL_SEND_TYPE=smtp2go + EMAIL_SEND_KEY and fully restart (nodemon does not watch .env).',
    );
  } else {
    logger.info(
      { transport: emailClient.provider, from: process.env.EMAIL_FROM_ADDRESS },
      'Email transport ready',
    );
  }

  // Sender personas (EMAIL_BRANDS_FILE / EMAIL_BRANDS). The caller names one per
  // request via `x-email-brand`; see email-brands.js. Logged at boot because a
  // misconfigured table is deliberately non-fatal — the only other symptom is an
  // email that goes out in the wrong voice.
  const brands = loadBrands(process.env, { logger });
  logger.info(
    { brands: Object.keys(brands.brands), default: brands.defaultKey },
    Object.keys(brands.brands).length
      ? 'Email sender personas loaded'
      : 'No email sender personas configured — auth emails use the default sender and built-in copy',
  );

  const sendHooks = createSendHooks({ emailClient, logger, brands });

  // Its own pool to the same database (Better-Auth uses the Kysely adapter; it
  // cannot share Sequelize's pool). Mirrors the SSL config in lib/database.js.
  const pool = new Pool({
    database: POSTGRES_DB,
    user: POSTGRES_USER,
    password: POSTGRES_PASSWORD,
    host: POSTGRES_HOST,
    port: POSTGRES_PORT,
    ...(POSTGRES_CA && {
      ssl: {
        ca: POSTGRES_CA,
        key: POSTGRES_KEY,
        cert: POSTGRES_CERT,
        servername: POSTGRES_RO_SERVER_NAME,
      },
    }),
  });

  const trustedOrigins = (BETTER_AUTH_TRUSTED_ORIGINS
    ? BETTER_AUTH_TRUSTED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
    : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3030', 'http://localhost:5173']);

  // Budgets for the endpoints that cause outbound email. Enforced pre-lookup in
  // hooks.before (below), keyed on the SUBMITTED address + a global breaker, so
  // rejection can never reveal whether an account exists. Counters live on the
  // auth pool (table auto-created; no migration to forget).
  const posNum = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : dflt);
  const sendBudget = createSendBudget({
    pool,
    logger,
    caps: {
      addressHourly: posNum(AUTH_EMAIL_PER_ADDRESS_HOURLY, 3),
      addressDaily: posNum(AUTH_EMAIL_PER_ADDRESS_DAILY, 10),
      globalHourly: posNum(AUTH_EMAIL_GLOBAL_HOURLY, 250),
    },
  });

  auth = betterAuth({
    database: pool,
    baseURL: BETTER_AUTH_URL || `http://localhost:${process.env.WS_PORT || 4000}`,
    basePath: '/api/auth',
    secret: BETTER_AUTH_SECRET,
    trustedOrigins,

    // Keep IP limits enabled in every environment; address and global budgets are database-backed across processes.
    // Moving IP limits to database storage also requires an auth migration; see PR #199.
    rateLimit: {
      enabled: true,
      customRules: {
        '/forget-password': { window: 3600, max: 10 },
        '/request-password-reset': { window: 3600, max: 10 },
        '/send-verification-email': { window: 3600, max: 10 },
        // OTT hand-off (Google sign-in → polite-ai BFF session capture, see
        // lib/auth/oauth-handoff.js). verify is PUBLIC but called SERVER-side by
        // the polite-ai BFF; once the BFF forwards end-user IPs (x-client-ip)
        // these buckets become per-user too — until then per-BFF-egress-IP.
        // Size for burst headroom; the real brute-force guard is the 32-char
        // single-use token with a 1-minute TTL, hashed at rest. generate is
        // session-gated and blocked for direct client calls
        // (disableClientRequest) but capped anyway.
        '/one-time-token/verify': { window: 60, max: 120 },
        '/one-time-token/generate': { window: 60, max: 10 },
      },
    },

    // Trust x-client-ip only after the proxy gate; detach mail tasks so SMTP latency cannot reveal account existence.
    // The directly awaited verification hook also needs its own deadline; see issue #208 and PR #259.
    advanced: {
      ipAddress: { ipAddressHeaders: ['x-client-ip', 'x-forwarded-for'] },
      backgroundTasks: {
        handler: (promise) => {
          promise.catch((err) => {
            logger.error({ err: err?.message }, 'better-auth background task failed');
          });
        },
      },
    },

    // Pre-lookup send budgets (layers 2-3 above). Runs for every dispatch of
    // the three email endpoints — HTTP and server-side auth.api calls alike —
    // BEFORE any user lookup, on the SUBMITTED address only, with identical
    // work whether or not an account exists: a 429 here is uniform and
    // therefore not an account-enumeration oracle. Malformed bodies fall
    // through to the endpoint's own validation.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const kind = { '/request-password-reset': 'reset', '/forget-password': 'reset', '/send-verification-email': 'verify' }[ctx.path];
        const email = typeof ctx.body?.email === 'string' ? ctx.body.email : null;
        if (!kind || !email) return;
        const verdict = await sendBudget.consume({ kind, email });
        if (!verdict.allowed) {
          // Global-scope trips are the platform email circuit-breaker — the
          // error log is the pager signal. Address-scope trips are routine.
          logger[verdict.scope === 'global-hour' ? 'error' : 'warn'](
            { kind, scope: verdict.scope, to: email },
            'email send budget exhausted — request rejected 429',
          );
          throw new APIError('TOO_MANY_REQUESTS', {
            message: 'Too many email requests. Please wait a while before trying again.',
          });
        }
      }),
    },

    // Mirror the Firebase methods: email/password + Google.
    emailAndPassword: {
      enabled: true,
      // Auto sign-in on signup so the SPA reproduces Firebase's auto-signup flow.
      autoSignIn: true,
      // Off by default for easy WIP testing; flip to mirror Firebase's verified-
      // email gate (the SPA AuthProvider already maps emailVerified -> status).
      requireEmailVerification: BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION === 'true',
      // Send hooks live in email-hooks.js. CONTRACT: they log-and-swallow send
      // failures (never rethrow) so no response status can depend on whether an
      // address is registered — see that module for the full rationale.
      sendResetPassword: sendHooks.sendResetPassword,
    },
    socialProviders: (BETTER_AUTH_GOOGLE_CLIENT_ID && BETTER_AUTH_GOOGLE_CLIENT_SECRET)
      ? {
          google: {
            clientId: BETTER_AUTH_GOOGLE_CLIENT_ID,
            clientSecret: BETTER_AUTH_GOOGLE_CLIENT_SECRET,
          },
        }
      : undefined,

    // Use our existing `users` table as the single source of truth. Only the
    // core identity fields are declared here (mapped to our snake_case columns);
    // every other column is owned by Sequelize and defaulted at the DB layer.
    user: {
      modelName: 'users',
      fields: {
        emailVerified: 'email_verified',
        image: 'picture',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },

    // Firebase -> Better-Auth identity bridge for SOCIAL sign-in: when a Google
    // sign-in's email matches an existing (Firebase-era) `users` row, link to it
    // instead of creating a new row — preserving the user's id and all FK'd data.
    // Better-Auth links only when the local row's email is verified
    // (requireLocalEmailVerified, default true) and otherwise *refuses* rather
    // than duplicating. Google emails arrive verified, so this is the automatic
    // path for migrating Google users.
    account: {
      accountLinking: {
        enabled: true,
        trustedProviders: ['google'],
      },
    },

    // A Google sign-in started through the hand-off (lib/auth/oauth-handoff.js)
    // creates an account only when the client that started it asked for one
    // (?signup=1 on the start URL). The refusal happens here, before the user
    // row is written. Every other sign-in path is unchanged. See
    // lib/auth/handoff-signup.js.
    databaseHooks: {
      user: {
        create: {
          before: createHandoffSignUpHook({ getOAuthState, APIError }),
        },
      },
    },

    // Email verification doubles as the sign-up double opt-in (see
    // api/paths/users/signup.js). The default link lifetime (1h) is too short
    // for a "join the waitlist" email, so it is extended below. Plain-text only,
    // to avoid any tracking pixel.
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      // better-auth awaits this hook directly; its own deadline and error handling prevent account enumeration. See issue
      // #208.
      sendVerificationEmail: sendHooks.sendVerificationEmail,
    },

    // Carry the session token as Authorization: Bearer, like the Firebase flow.
    //
    // oneTimeToken: bridges the Google OAuth session to the polite-ai BFF
    // (different registrable domain, so no shared cookie). The OAuth callback
    // 302s the browser to /api/oauth-handoff (lib/auth/oauth-handoff.js), which
    // server-side-generates a token bound to the just-created session; polite-ai
    // exchanges it via POST /one-time-token/verify (server-to-server) for the
    // same session's bearer token. Hardened: 1-minute TTL, hashed at rest (a
    // verification-table leak yields no usable tokens), and generate is blocked
    // for direct client requests — only server-side auth.api calls can mint.
    plugins: [bearer(), oneTimeToken({ expiresIn: 1, storeToken: 'hashed', disableClientRequest: true })],
  });

  logger.info({ trustedOrigins: '[REDACTED]', google: !!auth.options?.socialProviders?.google },
    'better-auth enabled');
}

export { auth };
export default auth;
