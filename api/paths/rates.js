import { RateCard } from '../../lib/database.js';
import { requirePermission } from '../../lib/auth/permissions.js';
import { validateRateLines } from '../../lib/rates.js';

/**
 * /api/rates (collection) — the named, date-ranged pricing rate cards that value
 * usage at transaction end (Phase 2/3 billing). Global platform config, NOT
 * org-scoped: gated purely on the `rate` resource (superAdmin). The per-name
 * non-overlap + immutable-once-referenced invariants are enforced in the model.
 *   GET   list cards (optional ?name= filter), newest interval last.
 *   POST  create a card (supersede an existing name with a later startDate).
 */
export default function (logger) {
  const list = async (req, res) => {
    if (!requirePermission(res, 'rate', 'read')) return;
    try {
      const where = req.query?.name ? { name: req.query.name } : {};
      const rates = await RateCard.findAll({ where, order: [['name', 'ASC'], ['startDate', 'ASC']] });
      return res.send({ rates });
    } catch (err) {
      req.log.error(err, 'listing rate cards');
      return res.status(500).send({ error: err.message });
    }
  };
  list.apiDoc = {
    summary: 'List pricing rate cards (super admin).',
    operationId: 'listRates',
    tags: ['Rates'],
    parameters: [{ in: 'query', name: 'name', required: false, schema: { type: 'string' }, description: 'Filter to one rate name (its full interval history).' }],
    responses: {
      200: { description: 'Rate cards' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const create = async (req, res) => {
    if (!requirePermission(res, 'rate', 'create')) return;
    const { name, startDate, endDate = null, currency = 'gbp', detail = { lines: [] }, description = null } = req.body || {};
    if (!name || !startDate) return res.status(400).send({ message: 'name and startDate are required' });
    const lineErr = validateRateLines(detail);
    if (lineErr) return res.status(400).send({ message: lineErr });
    try {
      const card = await RateCard.create({
        name, startDate, endDate, currency, detail, description,
        createdBy: res.locals.user?.id ?? null,
      });
      return res.status(201).send(card);
    } catch (err) {
      // Per-name overlap (EXCLUDE gist) or duplicate (name,startDate) -> 409 conflict.
      if (err?.name === 'SequelizeExclusionConstraintError' || err?.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).send({ message: `A rate card for "${name}" already covers that period; supersede with a later startDate.` });
      }
      req.log.error(err, 'creating rate card');
      return res.status(400).send({ message: err?.message || 'Failed to create rate card' });
    }
  };
  create.apiDoc = {
    summary: 'Create a pricing rate card (super admin).',
    operationId: 'createRate',
    tags: ['Rates'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name', 'startDate'],
            properties: {
              name: { type: 'string', description: 'Rate name an org rateHistory points at, e.g. customer-rate-1.' },
              startDate: { type: 'string', format: 'date-time' },
              endDate: { type: 'string', format: 'date-time', nullable: true, description: 'null = open until a later same-name card supersedes.' },
              currency: { type: 'string', default: 'gbp' },
              detail: {
                type: 'object',
                description: 'Additive per-dimension rate lines: { lines: [{ dim, match, unit, priceMicros }] }.',
              },
              description: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'Created rate card' },
      400: { description: 'Invalid', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Overlaps an existing card for this name' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: list, POST: create };
}
