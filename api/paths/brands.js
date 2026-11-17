import { Brand } from '../../lib/database.js';
import { requirePermission } from '../../lib/auth/permissions.js';
import { principalBrand, brandsReady, BRANDS_NOT_READY } from '../../lib/brands.js';

/** The 503 a brand route gives on a database without the brand upgrade. */
export const brandsNotReadyResponse = {
  description: '`brands_not_ready`: the database lacks the upgrade that adds brands',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
};

/** The fields of a brand that the API shows. */
export function brandView(row) {
  return {
    id: row.id,
    name: row.name ?? null,
    defaultCapabilities: Array.isArray(row.defaultCapabilities) ? row.defaultCapabilities : [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * GET /api/brands: the brands and their defaults for a new organisation. A
 * platform operator sees every brand. A brand's service key sees its own.
 */
export default function (logger) {
  const list = async (req, res) => {
    if (!requirePermission(res, 'brand', 'read')) return;
    if (!brandsReady()) return res.status(503).send(BRANDS_NOT_READY);
    const own = principalBrand(res.locals.user);
    const rows = await Brand.findAll({ where: own ? { id: own } : {}, order: [['id', 'ASC']] });
    return res.send({ brands: rows.map(brandView) });
  };
  list.apiDoc = {
    summary: 'List brands and their defaults for a new organisation.',
    operationId: 'listBrands',
    tags: ['Organisations'],
    responses: {
      200: {
        description: 'The brands',
        content: { 'application/json': { schema: { type: 'object', properties: { brands: { type: 'array', items: { $ref: '#/components/schemas/Brand' } } } } } },
      },
      503: brandsNotReadyResponse,
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { GET: list };
}
