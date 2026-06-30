import { requirePermission } from '../../lib/auth/permissions.js';
import handlers from '../../lib/handlers/index.js';
import { buildRateComponents } from '../../lib/rate-components.js';

/**
 * GET /api/rate-components — the env-independent priceable-component catalogue the
 * rate-card editor uses to pre-create correct lines (audio-path by handler×media,
 * model per-model token-or-minute, TTS/STT per engine). Gated on the `rate`
 * resource (super admin). Built from in-tree constants; never drops a component
 * for want of a credential.
 */
export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'rate', 'read')) return;
    try {
      const { implementations, models } = await handlers();
      return res.send({ components: buildRateComponents({ implementations, models }) });
    } catch (err) {
      req.log.error(err, 'building rate components');
      return res.status(500).send({ error: err.message });
    }
  };
  get.apiDoc = {
    summary: 'The priceable-component catalogue for the rate-card editor (super admin).',
    operationId: 'getRateComponents',
    tags: ['Rates'],
    responses: {
      200: {
        description: 'Priceable components, each with a match template + the billing unit(s) it can be priced on.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                components: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      dim: { type: 'string', enum: ['audio-path', 'model', 'tts', 'stt'] },
                      key: { type: 'string' },
                      label: { type: 'string' },
                      model: { type: 'string', nullable: true },
                      match: { type: 'object' },
                      units: { type: 'array', items: { type: 'string' } },
                      available: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get };
}
