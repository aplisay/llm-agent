import { Brand } from '../../../lib/database.js';
import { requirePermission } from '../../../lib/auth/permissions.js';
import { principalBrand, validateBrandId, validateBrandFields } from '../../../lib/brands.js';
import { brandView } from '../brands.js';

const pathParameter = { in: 'path', name: 'brandId', required: true, schema: { type: 'string' } };

/**
 * /api/brands/{brandId}: one brand. A platform operator creates a brand and
 * sets its defaults. A change to the defaults applies to organisations created
 * afterwards. It does not touch an organisation that exists.
 */
export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'brand', 'read')) return;
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
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const put = async (req, res) => {
    if (!requirePermission(res, 'brand', 'update')) return;
    const { brandId } = req.params;
    const idProblem = validateBrandId(brandId);
    if (idProblem) return res.status(400).send({ error: idProblem, code: 'invalid_brand', field: 'brandId' });
    const { name, defaultCapabilities } = req.body || {};
    const nameProblem = validateBrandFields({ name });
    if (nameProblem) return res.status(400).send({ error: nameProblem, code: 'invalid_request', field: 'name' });
    const capabilityProblem = validateBrandFields({ defaultCapabilities });
    if (capabilityProblem) return res.status(400).send({ error: capabilityProblem, code: 'unknown_capability', field: 'defaultCapabilities' });
    const fields = {};
    if (name !== undefined) fields.name = name === null ? null : name.trim();
    if (defaultCapabilities !== undefined) fields.defaultCapabilities = [...new Set(defaultCapabilities)];
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
    }, 'brand defaults set');
    return res.status(existing ? 200 : 201).send(brandView(row));
  };
  put.apiDoc = {
    summary: 'Create a brand or change its defaults.',
    description: 'Platform operator only. `defaultCapabilities` are given to each organisation of the brand when it is created. '
      + 'A change applies to organisations created afterwards and leaves existing ones as they are.',
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
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PUT: put };
}
