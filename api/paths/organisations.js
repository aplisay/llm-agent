import { Organisation } from '../../lib/database.js';
import { requireAdmin } from '../../lib/admin-gate.js';

/**
 * /api/organisations (collection) — ADMIN-gated.
 *   GET list organisations as `{ organisations: [{id, name}] }`.
 *
 * Used by the SPA Users admin tab to populate the org-filter list. No
 * pagination — the org set is bounded and small.
 */
export default function (logger) {
  const list = async (req, res) => {
    if (!requireAdmin(res.locals.user)) return res.status(403).json({ message: 'Admin only' });
    try {
      const rows = await Organisation.findAll({
        attributes: ['id', 'name'],
        order: [['name', 'ASC']],
      });
      return res.send({ organisations: rows });
    } catch (err) {
      logger.error({ err: err?.message }, 'listing organisations');
      return res.status(500).send({ message: 'Failed to list organisations' });
    }
  };
  list.apiDoc = {
    summary: 'List organisations (admin).',
    operationId: 'listOrganisations',
    tags: ['Organisations'],
    responses: {
      200: {
        description: '`{ organisations }`',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                organisations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                    },
                  },
                },
              },
              required: ['organisations'],
            },
          },
        },
      },
      default: {
        description: 'An error occurred',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  };

  return { GET: list };
}
