import { requirePermission } from '../../../lib/auth/permissions.js';
import { resolveEffectiveRateCard, BILLING_INCREMENT_SECONDS } from '../../../lib/rates.js';

/**
 * GET /api/me/rates — the rate card currently IN FORCE for the caller's OWN
 * organisation, so a customer can see the prices their usage is valued at.
 *
 * Deliberately self-scoped, in the path as well as in the code: the org is taken
 * from `res.locals.user` and an org id is never accepted from the caller, so
 * there is no shape of this request that reads another tenant's pricing.
 *
 * Gated on `usage:read` — the capability that already means "may see what this
 * organisation is being charged" (every `owner`/`member` holds it). NOT on
 * `rate:read`: that is the superAdmin PLATFORM-CONFIG capability over the global
 * card catalogue (GET /api/rates lists every customer's pricing), and widening it
 * to customers would expose all of it.
 *
 * Resolution goes through {@link resolveEffectiveRateCard}, which is the same
 * selection `costUsageRow` uses — per-user override first, then the org's, then
 * the covering card version. Quoting from anything else would eventually show a
 * customer a different card from the one their bill is computed on.
 *
 * `rated: false` is a REAL, current state, not an error, and is reported as a 200
 * with a reason: an org with no rate card is metered but never charged
 * (`cost_status='no_rate'`), and rendering that as an empty card would read as
 * "free". Internal ids and `createdBy` are never returned.
 */
export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'usage', 'read')) return;
    const user = res.locals.user;
    if (!user) return res.status(401).send({ message: 'Not authenticated' });
    try {
      const at = new Date();
      const { rateName, card } = await resolveEffectiveRateCard({
        organisationId: user.organisationId ?? null,
        userId: user.id ?? null,
        at,
      });

      if (!rateName) {
        return res.send({
          rated: false,
          reason: 'This organisation has no rate assigned, so its usage is metered but not charged.',
          name: null, currency: null, startDate: null, lines: [],
          billingIncrementSeconds: BILLING_INCREMENT_SECONDS,
          at: at.toISOString(),
        });
      }
      if (!card) {
        return res.send({
          rated: false,
          reason: `No version of rate card "${rateName}" is in force, so usage is metered but not charged.`,
          name: rateName, currency: null, startDate: null, lines: [],
          billingIncrementSeconds: BILLING_INCREMENT_SECONDS,
          at: at.toISOString(),
        });
      }

      const startDate = card.startDate instanceof Date ? card.startDate.toISOString() : card.startDate;
      return res.send({
        rated: true,
        name: card.name,
        description: card.description ?? null,
        currency: card.currency || 'gbp',
        startDate,
        // The card's additive per-dimension lines, verbatim minus the row's
        // identity: a call's price is the SUM of every dimension that matches it
        // (audio-path + model + tts/stt + destination), so a single "per-minute
        // rate" does not exist and must not be synthesised here.
        lines: Array.isArray(card.detail?.lines) ? card.detail.lines : [],
        // Time-metered lines priced per minute bill the duration rounded UP to
        // this increment, which is what makes a short call cost more per minute
        // than its wall-clock length suggests.
        billingIncrementSeconds: BILLING_INCREMENT_SECONDS,
        at: at.toISOString(),
      });
    } catch (err) {
      req.log.error(err, 'reading own rate card');
      return res.status(500).send({ error: err.message });
    }
  };
  get.apiDoc = {
    summary: "The rate card in force for the caller's own organisation.",
    operationId: 'getMyRates',
    tags: ['Rates'],
    responses: {
      200: {
        description:
          'The rate card in force now. `rated: false` (with a `reason`) is a real state — an unrated organisation is metered but never charged.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                rated: { type: 'boolean' },
                reason: { type: 'string', nullable: true, description: 'Why no card is in force (only when `rated` is false).' },
                name: { type: 'string', nullable: true },
                description: { type: 'string', nullable: true },
                currency: { type: 'string', nullable: true },
                startDate: { type: 'string', format: 'date-time', nullable: true },
                lines: {
                  type: 'array',
                  description: 'Additive per-dimension lines: a usage row is priced by EVERY dimension that matches it, summed.',
                  items: {
                    type: 'object',
                    properties: {
                      dim: { type: 'string', enum: ['audio-path', 'model', 'tts', 'stt', 'destination'] },
                      match: { type: 'object' },
                      unit: { type: 'string' },
                      priceMicros: { type: 'number', description: 'Micro-pence (1e-6 GBP) per `unit`.' },
                      tariff: { type: 'string', description: 'Destination lines only: the named prefix tariff that prices outbound carrier legs.' },
                    },
                  },
                },
                billingIncrementSeconds: { type: 'integer' },
                at: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      403: { description: 'Requires usage:read', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get };
}
