import { Brand } from '../../../lib/database.js';
import { requirePermission } from '../../../lib/auth/permissions.js';
import { principalBrand, validateBrandId, validateBrandFields, brandsReady, BRANDS_NOT_READY } from '../../../lib/brands.js';
import { brandView, brandsNotReadyResponse } from '../brands.js';
import { validateCeiling, outboundPolicyReady, POLICY_CODES } from '../../../lib/outbound-policy.js';

const pathParameter = { in: 'path', name: 'brandId', required: true, schema: { type: 'string' } };

/**
 * /api/brands/{brandId}: one brand. A platform operator creates a brand and
 * sets its defaults. A change to the defaults applies to organisations created
 * afterwards. It does not touch an organisation that exists.
 */
export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'brand', 'read')) return;
    if (!brandsReady()) return res.status(503).send(BRANDS_NOT_READY);
    const own = principalBrand(res.locals.user);
    const row = (!own || own === req.params.brandId) ? await Brand.findByPk(req.params.brandId) : null;
    if (!row) return res.status(404).send({ error: 'Brand not found', code: 'not_found' });
    return res.send(brandView(row));
  };
  get.apiDoc = {
    summary: 'Read a brand.',
    operationId: 'getBrand',
    tags: ['Organisations'],
    parameters: [pathParameter],
    responses: {
      200: { description: 'The brand', content: { 'application/json': { schema: { $ref: '#/components/schemas/Brand' } } } },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      503: brandsNotReadyResponse,
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const put = async (req, res) => {
    if (!requirePermission(res, 'brand', 'update')) return;
    if (!brandsReady()) return res.status(503).send(BRANDS_NOT_READY);
    const { brandId } = req.params;
    const idProblem = validateBrandId(brandId);
    if (idProblem) return res.status(400).send({ error: idProblem, code: 'invalid_brand', field: 'brandId' });
    const { name, defaultCapabilities, outboundCeiling } = req.body || {};
    const nameProblem = validateBrandFields({ name });
    if (nameProblem) return res.status(400).send({ error: nameProblem, code: 'invalid_request', field: 'name' });
    const capabilityProblem = validateBrandFields({ defaultCapabilities });
    if (capabilityProblem) return res.status(400).send({ error: capabilityProblem, code: 'unknown_capability', field: 'defaultCapabilities' });
    if (outboundCeiling !== undefined) {
      if (!outboundPolicyReady()) {
        return res.status(503).send({ error: 'The outbound policy needs a database upgrade. Run tools/agent-admin.js upgrade-db, then restart the API server.', code: POLICY_CODES.notReady });
      }
      const ceilingProblem = validateCeiling(outboundCeiling);
      if (ceilingProblem) return res.status(400).send({ error: ceilingProblem.error, code: 'invalid_request', field: ceilingProblem.field });
    }
    const fields = {};
    if (name !== undefined) fields.name = name === null ? null : name.trim();
    if (defaultCapabilities !== undefined) fields.defaultCapabilities = [...new Set(defaultCapabilities)];
    if (outboundCeiling !== undefined) fields.outboundCeiling = outboundCeiling;
    const existing = await Brand.findByPk(brandId);
    const before = existing ? existing.defaultCapabilities : null;
    const row = existing ? await existing.update(fields) : await Brand.create({ id: brandId, ...fields });
    logger.info({
      audit: 'brand-set',
      brand: brandId,
      created: !existing,
      userId: res.locals.user?.id,
      before,
      defaultCapabilities: row.defaultCapabilities,
      ...(outboundCeiling !== undefined ? { outboundCeiling } : {}),
    }, 'brand defaults set');
    return res.status(existing ? 200 : 201).send(brandView(row));
  };
  put.apiDoc = {
    summary: 'Create a brand or change its defaults.',
    description: 'Platform operator only. `defaultCapabilities` are given to each organisation of the brand when it is created. '
      + 'A change applies to organisations created afterwards and leaves existing ones as they are. '
      + '`outboundCeiling` is the most an organisation of the brand may set in its outbound policy, and applies at once to every '
      + "organisation of the brand. A field left out takes the platform's value.",
    operationId: 'setBrand',
    tags: ['Organisations'],
    parameters: [pathParameter],
    requestBody: {
      required: true,
      content: { 'application/json': { schema: { $ref: '#/components/schemas/BrandInput' } } },
    },
    responses: {
      200: { description: 'The brand after the change', content: { 'application/json': { schema: { $ref: '#/components/schemas/Brand' } } } },
      201: { description: 'The brand, created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Brand' } } } },
      503: brandsNotReadyResponse,
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PUT: put };
}
