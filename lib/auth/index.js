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
  const { bearer } = await import('better-auth/plugins');
  const { Pool } = await import('pg');

  if (!BETTER_AUTH_SECRET) {
    logger.error('BETTER_AUTH_ENABLED=true but BETTER_AUTH_SECRET is unset');
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
    : ['http://localhost:3000', 'http://localhost:3001', 'http://localhost:3030']);

  auth = betterAuth({
    database: pool,
    baseURL: BETTER_AUTH_URL || `http://localhost:${process.env.WS_PORT || 4000}`,
    basePath: '/api/auth',
    secret: BETTER_AUTH_SECRET,
    trustedOrigins,

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
        logger.info({ email: user?.email, url },
          'better-auth: password reset link (WIP stub — wire a real email sender)');
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

    // WIP email transport: log the verification URL. Replace with a real sender
    // (the future user-management server owns strong-ID verification).
    emailVerification: {
      sendOnSignUp: true,
      sendVerificationEmail: async ({ user, url }) => {
        logger.info({ email: user?.email, url },
          'better-auth: email verification link (WIP stub — wire a real email sender)');
      },
    },

    // Carry the session token as Authorization: Bearer, like the Firebase flow.
    plugins: [bearer()],
  });

  logger.info({ trustedOrigins, google: !!auth.options?.socialProviders?.google },
    'better-auth enabled');
}

export { auth };
export default auth;
