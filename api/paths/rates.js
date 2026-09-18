import { RateCard } from '../../lib/database.js';
import { requirePermission } from '../../lib/auth/permissions.js';
import { validateRateLines, getDefaultRateName } from '../../lib/rates.js';

/**
 * /api/rates (collection) — the named, date-ranged pricing rate cards that value
 * usage at transaction end (Phase 2/3 billing). Global platform config, NOT
 * org-scoped: gated purely on the `rate` resource (superAdmin). The per-name
 * immutable-once-referenced invariant is enforced in the model. Same-name cards
 * may overlap: the latest start covering the billing instant wins.
 *   GET   list cards (optional ?name= filter), newest interval last.
 *   POST  create a card (supersede an existing name with a later startDate).
 */
export default function (logger) {
  const list = async (req, res) => {
    if (!requirePermission(res, 'rate', 'read')) return;
    try {
      const where = req.query?.name ? { name: req.query.name } : {};
      const [rates, defaultRateName] = await Promise.all([
        RateCard.findAll({ where, order: [['name', 'ASC'], ['startDate', 'ASC']] }),
        getDefaultRateName(),
      ]);
      // `defaultRateName` is the platform default (the name a new org starts on);
      // included here so the dashboard can badge the default in the list without a
      // second round-trip. See GET /api/rates/default for the single-value read.
      return res.send({ rates, defaultRateName });
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
      200: { description: 'Rate cards + the platform `defaultRateName` (the name a new org is assigned at creation; null when unset).' },
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
      // Two DIFFERENT conflicts, and conflating them sends the operator hunting
      // for the wrong thing — so they say different things.
      //
      // Unique (name, start_date): a real duplicate. The only case
      // resolveRateCard's ORDER BY start_date DESC cannot resolve, so it stays
      // rejected however the schema is versioned.
      if (err?.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).send({ message: `A rate card for "${name}" already starts at that instant; give the superseding card a different startDate.` });
      }
      // Exclusion: overlapping PERIODS, which schema v59 stopped rejecting. Only
      // a database still carrying rate_cards_name_period_excl can raise this, so
      // it is a deployment state, not a fault in the request — say so, because
      // the card being created is perfectly valid and will import unchanged once
      // the upgrade has run.
      if (err?.name === 'SequelizeExclusionConstraintError') {
        return res.status(409).send({
          message: `This database still enforces the pre-v59 rate-card overlap constraint, so "${name}" cannot start while an existing card of that name is still open. Run the schema upgrade to v59 (which drops rate_cards_name_period_excl), or end-date the existing card first.`,
        });
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
      409: { description: 'A card for this name already starts at that instant' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: list, POST: create };
}
