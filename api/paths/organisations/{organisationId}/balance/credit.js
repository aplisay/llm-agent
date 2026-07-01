import { Organisation, BalanceCredit, Sequelize } from '../../../../../lib/database.js';
import { requirePermission } from '../../../../../lib/auth/permissions.js';
import { penniesToMicros, microsToPennies } from '../../../../../lib/rates.js';

/**
 * POST /api/organisations/{id}/balance/credit — idempotently top up the org's
 * balance (the Stripe → llm-agent credit seam; polite-ai's webhook calls this).
 *
 * `idempotencyKey` (= Stripe PaymentIntent.id) is UNIQUE-constrained via the
 * BalanceCredit ledger, so a Stripe retry is safe — the same payment credits
 * `Organisation.balance` exactly once. On a duplicate key the call is an idempotent
 * success (returns the current balance). On any OTHER failure it returns **500** so
 * Stripe retries (the unique key makes that retry safe). The credit + balance bump
 * are one transaction; the first credit transitions a null (untracked) balance to a
 * tracked numeric one. Gated on `organisation:credit` — held by superAdmin and by
 * the least-privilege `billingService` role (the polite-ai Stripe-webhook seam
 * authenticates with a synthetic service user's AuthKey). The API edge speaks
 * **pennies**.
 */
export default function (logger) {
  const post = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'credit')) return;
    const { organisationId } = req.params;
    const { idempotencyKey, amountPennies, currency = 'gbp' } = req.body || {};
    if (!idempotencyKey) return res.status(400).send({ message: 'idempotencyKey is required' });
    const amountMicros = penniesToMicros(amountPennies);
    if (!Number.isInteger(amountMicros) || amountMicros <= 0) {
      return res.status(400).send({ message: 'amountPennies must be a positive number' });
    }

    const org = await Organisation.findByPk(organisationId);
    if (!org) return res.status(404).send({ message: `Organisation ${organisationId} not found` });

    try {
      await Organisation.sequelize.transaction(async (transaction) => {
        // The UNIQUE idempotency_key insert is the idempotency gate; the balance
        // bump uses COALESCE so a first credit transitions null -> tracked.
        await BalanceCredit.create({ organisationId, idempotencyKey, amountMicros, currency }, { transaction });
        await Organisation.update(
          { balance: Sequelize.literal(`COALESCE(balance, 0) + ${amountMicros}`) },
          { where: { id: organisationId }, transaction },
        );
      });
    } catch (err) {
      if (err?.name === 'SequelizeUniqueConstraintError') {
        const current = await Organisation.findByPk(organisationId);
        return res.send({ balancePennies: microsToPennies(current.balance), idempotent: true });
      }
      req.log.error(err, 'crediting organisation balance');
      // 500 -> Stripe retries; the unique key makes the retry safe.
      return res.status(500).send({ error: 'credit failed' });
    }

    const updated = await Organisation.findByPk(organisationId);
    return res.send({ balancePennies: microsToPennies(updated.balance), credited: microsToPennies(amountMicros) });
  };
  post.apiDoc = {
    summary: 'Idempotently credit an organisation’s balance (Stripe top-up seam).',
    operationId: 'creditOrganisationBalance',
    tags: ['Organisations', 'Billing'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['idempotencyKey', 'amountPennies'],
            properties: {
              idempotencyKey: { type: 'string', description: 'Stripe PaymentIntent.id (unique; makes retries safe).' },
              amountPennies: { type: 'number', description: 'Amount to credit, in pennies.' },
              currency: { type: 'string', default: 'gbp' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Credited (or idempotent replay); returns the new balance in pennies.' },
      400: { description: 'Invalid', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      500: { description: 'Credit failed — caller should retry (idempotent).', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { POST: post };
}
