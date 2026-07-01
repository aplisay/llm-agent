import { requirePermission } from '../../../lib/auth/permissions.js';
import { getDefaultRateName, setDefaultRateName, validateDefaultRateName } from '../../../lib/rates.js';

/**
 * /api/rates/default — the platform-wide DEFAULT rate name (a Metadata singleton,
 * NOT a rate-card row: rate cards are temporal + immutable, so the default is a
 * NAME resolved to its covering version at cost time). A newly created org with
 * no explicit rateHistory is stamped with this name (see the org-create paths),
 * so no org is ever silently left uncosted.
 *   GET  read the current default name (rate:read).      -> { defaultRateName }
 *   PUT  set/clear it (rate:update — super only). Validated: the name must have a
 *        rate card covering "now"; null/'' clears the default.
 *
 * Sits beside /api/rates/{rateId}; `default` is a literal path segment (mirrors
 * /api/users/signup beside /api/users/{userId}), so it never collides with an id.
 */
export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'rate', 'read')) return;
    try {
      const defaultRateName = await getDefaultRateName();
      return res.send({ defaultRateName });
    } catch (err) {
      req.log.error(err, 'reading default rate name');
      return res.status(500).send({ error: err.message });
    }
  };
  get.apiDoc = {
    summary: 'Read the platform default rate name (super admin).',
    operationId: 'getDefaultRate',
    tags: ['Rates'],
    responses: {
      200: { description: '`{ defaultRateName }` — the name a new org is assigned at creation, or null when unset.' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const put = async (req, res) => {
    if (!requirePermission(res, 'rate', 'update')) return; // super only
    const raw = req.body?.defaultRateName;
    // Normalise: a blank/whitespace/absent value clears the default.
    const name = (typeof raw === 'string' && raw.trim()) ? raw.trim() : null;
    const err = await validateDefaultRateName(name);
    if (err) return res.status(400).send({ message: err });
    try {
      const defaultRateName = await setDefaultRateName(name);
      return res.send({ defaultRateName });
    } catch (e) {
      req.log.error(e, 'setting default rate name');
      return res.status(400).send({ message: e?.message || 'Failed to set default rate name' });
    }
  };
  put.apiDoc = {
    summary: 'Set (or clear) the platform default rate name (super admin).',
    operationId: 'setDefaultRate',
    tags: ['Rates'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              defaultRateName: {
                type: 'string',
                nullable: true,
                description: 'Rate name a new org starts on. Must have a rate card covering now. null/"" clears the default.',
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated default (`{ defaultRateName }`).' },
      400: { description: 'Invalid — no rate card covers the name now.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PUT: put };
}
