import { randomUUID } from 'node:crypto';
import { User, Organisation } from '../../../lib/database.js';
import { auth } from '../../../lib/auth/index.js';
import { defaultRateHistoryEntry } from '../../../lib/rates.js';

/**
 * POST /api/users/signup — PUBLIC (skip-listed in middleware/auth.js).
 *
 * The single sign-up primitive: waitlist now, self-signup later. Either way the
 * new user is created `status='provisional'` and CANNOT perform API operations
 * until an admin activates it (the gate is in middleware/auth.js). A double
 * opt-in email challenge is sent; the row stays dormant until confirmed AND an
 * admin promotes it to `active`.
 *
 *  - no password  -> credential-less user (no `account` row => cannot log in).
 *  - with password -> credentialed user (can log in later) but still provisional.
 *
 * If an `organisation` name is supplied, a PROVISIONAL organisation is created and
 * the new user is linked to it (users.organisation_id).
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Create a PROVISIONAL organisation for a sign-up and return its id (or null when
// no name is supplied). Always a NEW org — never findOrCreate by name, which would
// let a sign-up attach itself to someone else's existing (real) organisation.
async function createProvisionalOrg(orgName, options = {}) {
  if (!orgName) return null;
  // Provisional orgs start on the platform default rate too, so a self-signup org
  // is costed from the moment it is activated (null = untracked, as before).
  const rateHistory = await defaultRateHistoryEntry();
  const org = await Organisation.create(
    { id: randomUUID(), name: orgName, status: 'provisional', ...(rateHistory ? { rateHistory } : {}) },
    options,
  );
  return org.id;
}

export default function (logger) {
  const signup = async (req, res) => {
    if (!auth) return res.status(503).json({ error: 'Sign-up is temporarily unavailable.' });

    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!email || email.length < 3 || email.length > 254 || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const password = req.body?.password ? String(req.body.password) : null;
    const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const name = rawName.slice(0, 200) || email.split('@')[0]; // fall back to the email local-part
    const orgName = (typeof req.body?.organisation === 'string' ? req.body.organisation.trim() : '').slice(0, 200);
    // The sender persona for the double opt-in email (lib/auth/email-brands.js).
    // Server-side auth.api calls carry no request of their own, so the hooks see
    // a persona only if we hand them one; unknown/absent falls to the operator's
    // default, so this can never select an unapproved sender.
    const brand = (typeof req.body?.brand === 'string' ? req.body.brand.trim() : '').slice(0, 64);
    const brandHeaders = brand ? new Headers({ 'x-email-brand': brand }) : undefined;
    const callbackURL = process.env.WAITLIST_CALLBACK_URL;
    if (!callbackURL) {
      logger.error('WAITLIST_CALLBACK_URL is unset; cannot build the confirmation link');
      return res.status(500).json({ error: "We couldn't process your sign-up. Please try again shortly." });
    }

    try {
      const existing = await User.findOne({ where: { email } });
      if (existing?.emailVerified) {
        return res.json({ ok: true, status: 'already', message: "You're already on the list." });
      }

      if (password && !existing) {
        // Self-signup WITH a password. Use core `signUpEmail` (NO admin plugin
        // required) to write the credential + `account` row. The row defaults to
        // status='provisional' (Postgres column default), so it still cannot
        // perform API ops until an admin activates it. `autoSignIn` creates a
        // session we don't use (the user is gated regardless). signUpEmail also
        // fires the verification email (emailVerification.sendOnSignUp), so we do
        // NOT send it again below. role defaults to 'owner' (PG/model default) and
        // status stays 'provisional', so the user is gated until an admin activates.
        // (NB: users-api-design.md named auth.api.createUser — switched to
        // signUpEmail to avoid enabling the admin() plugin.)
        await auth.api.signUpEmail({
          body: { email, password, name, callbackURL },
          ...(brandHeaders ? { headers: brandHeaders } : {}),
        });
        const organisationId = await createProvisionalOrg(orgName);
        await User.update(
          { signupMethod: 'self-signup', ...(organisationId ? { organisationId } : {}) },
          { where: { email } },
        );
        return res.json({ ok: true, status: 'pending', message: 'Check your inbox to confirm.' });
      }

      if (!existing) {
        // Credential-less waitlist row (no `account` => cannot log in). role
        // defaults to 'owner'; status 'provisional' gates the user until an admin
        // activates. The provisional org + user are created atomically.
        await User.sequelize.transaction(async (t) => {
          const organisationId = await createProvisionalOrg(orgName, { transaction: t });
          await User.upsert({
            id: randomUUID(),
            email,
            name,
            emailVerified: false,
            status: 'provisional',
            signupMethod: 'waitlist',
            ...(organisationId ? { organisationId } : {}),
          }, { transaction: t });
        });
      }

      // Double opt-in for the credential-less new row and any existing-unverified
      // re-submit. Enumeration-safe (no-ops for missing/verified user), so the row
      // MUST exist by here. No request headers => not session-scoped.
      try {
        await auth.api.sendVerificationEmail({
          body: { email, callbackURL },
          ...(brandHeaders ? { headers: brandHeaders } : {}),
        });
      } catch (err) {
        // The auth hooks 429 a re-submit once the address's send budget is
        // spent (lib/auth/send-budget.js) — earlier emails already went out, so
        // the neutral 'pending' answer below stays truthful. Anything else is a
        // real failure for the outer catch.
        if (err?.statusCode !== 429) throw err;
        logger.warn({ email }, 'signup verification email suppressed by send budget');
      }
      return res.json({ ok: true, status: 'pending', message: 'Check your inbox to confirm.' });
    } catch (err) {
      logger.error({ err: err?.message }, 'signup failed');
      return res.status(500).json({ error: "We couldn't process your sign-up. Please try again shortly." });
    }
  };

  signup.apiDoc = {
    summary: 'Public sign-up (waitlist / self-signup). Creates a PROVISIONAL user and fires an email challenge.',
    operationId: 'signup',
    tags: ['Users'],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              email: { type: 'string', format: 'email' },
              name: { type: 'string', maxLength: 200, description: "Optional display name. Falls back to the email's local-part." },
              organisation: { type: 'string', maxLength: 200, description: 'Optional. Creates a PROVISIONAL organisation and links the user to it.' },
              password: { type: 'string', minLength: 8, description: 'Optional. The user is provisional either way.' },
              brand: { type: 'string', maxLength: 64, description: 'Optional. Sender persona for the confirmation email, from the deployment\'s configured set. Unknown values fall back to its default.' },
            },
            required: ['email'],
          },
        },
      },
    },
    responses: {
      200: {
        description: 'Sign-up accepted (pending email confirmation) or already on the list.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                status: { type: 'string', enum: ['pending', 'already'] },
                message: { type: 'string' },
              },
            },
          },
        },
      },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { POST: signup };
}
