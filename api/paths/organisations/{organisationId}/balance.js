import { Organisation } from '../../../../lib/database.js';
import { requirePermission, can } from '../../../../lib/auth/permissions.js';
import { microsToPennies } from '../../../../lib/rates.js';

/**
 * /api/organisations/{id}/balance — read the org's spendable balance.
 *
 * Gated on `usage:read` (every org member has it) so the frontend can poll the
 * balance; own-org only unless the caller holds `usage:readAll` (support/super).
 * Internal storage is micro-pence; the API edge speaks **pennies**. `balancePennies`
 * is null when the balance is untracked (postpaid / unlimited).
 */
export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'usage', 'read')) return;
    const org = await Organisation.findByPk(req.params.organisationId);
    const ownOrg = org && org.id === res.locals.user?.organisationId;
    if (!org || (!ownOrg && !can(res.locals.user, 'usage', 'readAll'))) {
      return res.status(404).send({ message: `Organisation ${req.params.organisationId} not found` });
    }
    return res.send({
      balancePennies: microsToPennies(org.balance),
      tracked: org.balance != null,
      currency: 'gbp',
    });
  };
  get.apiDoc = {
    summary: 'Read an organisation’s spendable balance (pennies).',
    operationId: 'getOrganisationBalance',
    tags: ['Organisations', 'Billing'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Balance (pennies; null = untracked)' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get };
}
