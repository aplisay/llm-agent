import { Organisation } from '../../../../lib/database.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { targetInScope } from '../../../../lib/auth/admin-scope.js';
import { validateRateHistory } from '../../../../lib/rates.js';

/**
 * /api/organisations/{id}/rate-history — the org's billing rate-name timeline
 * ([{ name, startDate }]); the row's cost resolves the entry whose startDate is
 * the greatest ≤ the usage `billedAt`.
 *   GET  read (organisation:read; own org unless cross-tenant).
 *   PUT  assign the full timeline (organisation:setRate — super only). Validated:
 *        sorted, no duplicate startDates, every name has a covering rate card.
 */
export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'read')) return;
    const org = await Organisation.findByPk(req.params.organisationId);
    if (!org || !targetInScope(res.locals.user, 'organisation', org)) {
      return res.status(404).send({ message: `Organisation ${req.params.organisationId} not found` });
    }
    return res.send({ rateHistory: org.rateHistory || [] });
  };
  get.apiDoc = {
    summary: 'Read an organisation’s rate-name history.',
    operationId: 'getOrganisationRateHistory',
    tags: ['Organisations', 'Rates'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Rate history' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const put = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'setRate')) return; // super only
    const org = await Organisation.findByPk(req.params.organisationId);
    if (!org) return res.status(404).send({ message: `Organisation ${req.params.organisationId} not found` });
    const history = req.body?.rateHistory ?? null;
    const err = await validateRateHistory(history);
    if (err) return res.status(400).send({ message: err });
    try {
      org.rateHistory = history;
      await org.save();
      return res.send({ rateHistory: org.rateHistory });
    } catch (e) {
      req.log.error(e, 'assigning rate history');
      return res.status(400).send({ message: e?.message || 'Failed to set rate history' });
    }
  };
  put.apiDoc = {
    summary: 'Assign an organisation’s rate-name history (super admin).',
    operationId: 'setOrganisationRateHistory',
    tags: ['Organisations', 'Rates'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              rateHistory: {
                type: 'array',
                nullable: true,
                description: 'Sorted [{ name, startDate }]; null = untracked. Each name must have a covering card.',
                items: { type: 'object', properties: { name: { type: 'string' }, startDate: { type: 'string', format: 'date-time' } } },
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated rate history' },
      400: { description: 'Invalid', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PUT: put };
}
