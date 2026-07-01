import { Tariff } from '../../../../lib/database.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { normaliseDestination, matchTariffPrefix, computeDestinationCost } from '../../../../lib/tariffs.js';

/**
 * POST /api/tariffs/{tariffId}/quote — price ONE hypothetical call against this tariff
 * using the REAL cost engine (normalise → longest-prefix match → peak/off-peak +
 * rounding + minimum). Lets a superAdmin sanity-check an imported deck whose rows are
 * otherwise occult. Gated on the `tariff` resource (read).
 *
 * body: { number, at?: ISO-datetime (defaults now), durationSeconds?: number (default 60) }
 */
export default function (logger) {
  const post = async (req, res) => {
    if (!requirePermission(res, 'tariff', 'read')) return;
    const tariff = await Tariff.findByPk(req.params.tariffId);
    if (!tariff) return res.status(404).send({ message: `Tariff ${req.params.tariffId} not found` });

    const { number, at, durationSeconds = 60 } = req.body || {};
    if (!number) return res.status(400).send({ message: 'number is required' });

    const normalised = normaliseDestination(number, { defaultCountry: tariff.defaultCountry });
    if (!normalised) {
      return res.send({ matched: false, reason: 'not a chargeable / normalisable number', number, normalised: null });
    }
    const prefixRow = await matchTariffPrefix(tariff.id, normalised);
    if (!prefixRow) {
      return res.send({ matched: false, reason: 'no prefix in this tariff matches', number, normalised });
    }
    const billedAt = at ? new Date(at) : new Date();
    const c = computeDestinationCost(tariff, prefixRow, { billedAt, durationMs: (Number(durationSeconds) || 0) * 1000 });
    return res.send({
      matched: true,
      number,
      normalised,
      billedAt: billedAt.toISOString(),
      timezone: tariff.timezone,
      defaultCountry: tariff.defaultCountry,
      prefix: prefixRow.prefix,
      label: prefixRow.label ?? null,
      peak: c.peak,
      connectMicros: c.connectMicros,
      peakPerMinuteMicros: Number(prefixRow.peakPerMinuteMicros) || 0,
      offPeakPerMinuteMicros: Number(prefixRow.offPeakPerMinuteMicros) || 0,
      minimumMicros: Number(prefixRow.minimumMicros) || 0,
      perMinuteMicros: c.perMinuteMicros,
      callStartMicros: c.callStartMicros,
      roundingSeconds: c.roundingSeconds,
      billedSeconds: c.billedSeconds,
      minutes: c.minutes,
      costMicros: c.costMicros,
    });
  };
  post.apiDoc = {
    summary: 'Quote one hypothetical call against a tariff (super admin).',
    operationId: 'quoteTariff',
    tags: ['Tariffs'],
    parameters: [{ in: 'path', name: 'tariffId', required: true, schema: { type: 'string' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['number'],
            properties: {
              number: { type: 'string', description: 'Dialled destination (any format).' },
              at: { type: 'string', format: 'date-time', description: 'Call start (for peak/off-peak); defaults to now.' },
              durationSeconds: { type: 'number', default: 60 },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The matched prefix + full cost breakdown (or matched:false with a reason).' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { POST: post };
}
