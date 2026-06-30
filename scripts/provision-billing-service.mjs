/**
 * Provision the least-privilege billing-service identity for the polite-ai Stripe
 * → balance/credit seam (Phase 4). Creates (idempotently) a synthetic user with
 * role `billingService` (which grants ONLY organisation:credit) and an AuthKey,
 * then prints the bearer token to put in polite-ai's LLM_AGENT_BILLING_TOKEN.
 *
 *   NODE_PATH=./node_modules node scripts/provision-billing-service.mjs
 *
 * Optional env: BILLING_EMAIL (default stripe-billing-service@aplisay.internal),
 * BILLING_KEY (default a fresh random token). Re-running rotates/keeps the key.
 *
 * SECURITY: this mints a credential. Run it against the target environment's DB
 * (the same POSTGRES_* the app uses), capture the printed token into the secret
 * store, and do NOT commit the token.
 */
import { randomBytes, randomUUID } from 'crypto';
import { User, AuthKey, databaseStarted } from '../lib/database.js';

const EMAIL = process.env.BILLING_EMAIL || 'stripe-billing-service@aplisay.internal';
const KEY = process.env.BILLING_KEY || `bsvc_${randomBytes(24).toString('hex')}`;

async function main() {
  await databaseStarted;

  let user = await User.findOne({ where: { email: EMAIL } });
  if (!user) {
    user = await User.create(
      {
        id: randomUUID(),
        name: 'Stripe Billing Service',
        email: EMAIL,
        emailVerified: true,
        phone: '',
        phoneVerified: false,
        picture: '',
        role: 'billingService',
        status: 'active',
        organisationId: null,
      },
      { validate: false },
    );
    console.log(`created billingService user ${user.id} (${EMAIL})`);
  } else {
    if (user.role !== 'billingService' || user.status !== 'active') {
      await user.update({ role: 'billingService', status: 'active' });
    }
    console.log(`reusing billingService user ${user.id} (${EMAIL})`);
  }

  // roleRestriction='billingService' pins the key to organisation:credit even if
  // the user's role is ever changed (defence in depth). expires far out.
  await AuthKey.upsert({
    key: KEY,
    userId: user.id,
    roleRestriction: 'billingService',
    expires: new Date('2099-01-01T00:00:00Z'),
  });

  console.log('\n--- set this in polite-ai env (do NOT commit) ---');
  console.log(`LLM_AGENT_BILLING_TOKEN=${KEY}`);
  process.exit(0);
}

main().catch((e) => {
  console.error('provisioning failed:', e?.message || e);
  process.exit(1);
});
