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
  const { Pool } = await import('pg');
  const { createEmailClient } = await import('@aplisay/email');

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

  auth = betterAuth({
    database: pool,
    baseURL: BETTER_AUTH_URL || `http://localhost:${process.env.WS_PORT || 4000}`,
    basePath: '/api/auth',
    secret: BETTER_AUTH_SECRET,
    trustedOrigins,

    // Rate limiting. better-auth ships sensible per-IP, per-path defaults
    // (/sign-in & /sign-up: 3 per 10s; password-reset & verification-email
    // sends: 3 per 60s) but ENABLES them only when NODE_ENV=production — so they
    // are off in staging/feature. Turn them on in every environment, and tighten
    // the email-sending endpoints to an hourly cap: each call hits
    // emailClient.send (real cost + inbox-bombing risk). Client IP is taken from
    // the leftmost X-Forwarded-For (Cloud Run) by better-auth's getIp.
    // NB: storage is in-memory, so caps are per process — the effective limit is
    // max × running instances under Cloud Run autoscaling. Switch storage to
    // 'database' (needs an auth migration) for a hard cluster-wide limit.
    rateLimit: {
      enabled: true,
      customRules: {
        '/forget-password': { window: 3600, max: 5 },
        '/request-password-reset': { window: 3600, max: 5 },
        '/send-verification-email': { window: 3600, max: 5 },
        // OTT hand-off (Google sign-in → polite-ai BFF session capture, see
        // lib/auth/oauth-handoff.js). verify is PUBLIC but called SERVER-side by
        // the polite-ai BFF, so per-IP here means per-BFF-egress-IP — i.e. a
        // PLATFORM-WIDE Google-sign-in ceiling, not per-user. Size it for burst
        // headroom; the real brute-force guard is the 32-char single-use token
        // with a 1-minute TTL, hashed at rest. generate is session-gated and
        // blocked for direct client calls (disableClientRequest) but capped anyway.
        '/one-time-token/verify': { window: 60, max: 120 },
        '/one-time-token/generate': { window: 60, max: 10 },
      },
    },

    // Mirror the Firebase methods: email/password + Google.
    emailAndPassword: {
      enabled: true,
      // Auto sign-in on signup so the SPA reproduces Firebase's auto-signup flow.
      autoSignIn: true,
      // Off by default for easy WIP testing; flip to mirror Firebase's verified-
      // email gate (the SPA AuthProvider already maps emailVerified -> status).
      requireEmailVerification: BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION === 'true',
      // WIP email transport: log the reset link. Enabling sendResetPassword also
      // turns on the Firebase->Better-Auth bridge for PASSWORD users: a migrating
      // Firebase row has no Better-Auth credential, and resetPassword *creates* a
      // `credential` account on that existing row when none exists — so setting a
      // password lands on the existing user (id + data preserved), never a dup.
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
          throw err;
        }
      },
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

    // Email verification doubles as the sign-up double opt-in (see
    // api/paths/users/signup.js). The default link lifetime (1h) is too short
    // for a "join the waitlist" email, so it is extended below. Plain-text only,
    // to avoid any tracking pixel.
    emailVerification: {
      sendOnSignUp: true,
      expiresIn: 60 * 60 * 24 * 7, // 7 days
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
          throw err;
        }
      },
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

  logger.info({ trustedOrigins, google: !!auth.options?.socialProviders?.google },
    'better-auth enabled');
}

export { auth };
export default auth;
