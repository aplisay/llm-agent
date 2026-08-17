import { Organisation, OrganisationKey } from '../../../../lib/database.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { targetInScope } from '../../../../lib/auth/admin-scope.js';
import { listProviders } from '../../../../lib/utils/provider-keys.js';

/**
 * /api/organisations/{organisationId}/provider-keys — the org's BYOK provider
 * API keys (docs/byok.md).
 *   GET  list stored keys as { provider, hint, updatedAt } plus the provider
 *        registry catalogue for UIs. Values are WRITE-ONLY and never returned;
 *        the listing reads only the separately-stored hint, never `value`.
 *
 * Gated on `organisation:providerKeys` (owner/orgAdmin: own org; superAdmin:
 * any org) then targetInScope — out-of-scope targets 404 so existence isn't
 * leaked across tenants.
 */
export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'providerKeys')) return;
    const org = await Organisation.findByPk(req.params.organisationId);
    if (!org || !targetInScope(res.locals.user, 'organisation', org)) {
      return res.status(404).send({ message: `Organisation ${req.params.organisationId} not found` });
    }
    const rows = await OrganisationKey.findAll({
      where: { organisationId: org.id },
      attributes: ['provider', 'hint', 'updatedAt'],
      order: [['provider', 'ASC']],
    });
    return res.send({
      items: rows.map((row) => ({ provider: row.provider, hint: row.hint ?? null, updatedAt: row.updatedAt })),
      providers: listProviders(),
    });
  };
  get.apiDoc = {
    summary: 'List an organisation’s BYOK provider keys (hints only — values are never returned).',
    operationId: 'listOrganisationProviderKeys',
    tags: ['Organisations'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    responses: {
      200: {
        description: 'Stored keys (masked) plus the provider registry catalogue',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      provider: { type: 'string', description: 'Canonical provider slug' },
                      hint: { type: 'string', nullable: true, description: 'Last 4 characters of the stored key' },
                      updatedAt: { type: 'string', format: 'date-time' },
                    },
                  },
                },
                providers: {
                  type: 'array',
                  description: 'The provider registry (for key-management UIs)',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      label: { type: 'string' },
                      dimensions: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
      },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get };
}
