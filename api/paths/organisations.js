import { randomUUID } from 'node:crypto';
import { Organisation, Brand } from '../../lib/database.js';
import { requirePermission, actorCanGrant, validateRbacFields, can } from '../../lib/auth/permissions.js';
import { adminScope } from '../../lib/auth/admin-scope.js';
import { defaultRateHistoryEntry } from '../../lib/rates.js';
import { principalBrand, capabilitiesForNewOrganisation } from '../../lib/brands.js';

/**
 * /api/organisations (collection) — RBAC-gated (`organisation:*`), org-scoped.
 *   GET  list organisations. orgAdmin sees only their own; superAdmin/support
 *        see all (cross-tenant `organisation:readAll`). Feeds both the SPA Users
 *        admin tab org-filter and the (super-admin-only) org-edit modal.
 *   POST create an organisation (`organisation:create`). Its brand is the
 *        creating key's brand; otherwise only a platform operator may name one.
 *        It starts with that brand's default capabilities.
 */
const LIST_ATTRS = ['id', 'name', 'status', 'agentLimit', 'chargeableNumberLimit', 'customVoiceLimit', 'role', 'allowedModels', 'permissions', 'brand', 'capabilities'];

/**
 * The brand row a new organisation takes, `null` for none, or an error to send.
 * A key of one brand cannot create an organisation of another. A principal
 * without a brand may name one only with `brand:update` (a platform operator).
 */
async function brandForNewOrganisation(user, requested) {
  const own = principalBrand(user);
  const named = requested === undefined || requested === null || requested === '' ? null : requested;
  if (own && named && named !== own) {
    return { error: { status: 403, body: { error: 'This key creates organisations of its own brand only.', code: 'brand_not_allowed', field: 'brand' } } };
  }
  if (!own && named && !can(user, 'brand', 'update')) {
    return { error: { status: 403, body: { error: 'Only a platform operator can name the brand of a new organisation.', code: 'brand_not_allowed', field: 'brand' } } };
  }
  const id = own || named;
  if (!id) return { brand: null };
  const brand = typeof id === 'string' ? await Brand.findByPk(id) : null;
  if (!brand) return { error: { status: 400, body: { error: `Unknown brand: ${String(id)}`, code: 'unknown_brand', field: 'brand' } } };
  return { brand };
}

export default function (logger) {
  const list = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'read')) return;
    try {
      const where = { ...adminScope(res.locals.user, 'organisation') };
      if (typeof req.query.brand === 'string' && req.query.brand && where.brand === undefined) where.brand = req.query.brand;
      const rows = await Organisation.findAll({
        where,
        attributes: LIST_ATTRS,
        order: [['name', 'ASC']],
      });
      return res.send({ organisations: rows });
    } catch (err) {
      logger.error({ err: err?.message }, 'listing organisations');
      return res.status(500).send({ message: 'Failed to list organisations' });
    }
  };
  list.apiDoc = {
    summary: 'List organisations (admin). orgAdmin: own org only; superAdmin/support: all.',
    operationId: 'listOrganisations',
    tags: ['Organisations'],
    parameters: [
      { in: 'query', name: 'brand', required: false, schema: { type: 'string' }, description: 'Only organisations of this brand. A key of one brand sees its own brand only.' },
    ],
    responses: {
      200: {
        description: '`{ organisations }`',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                organisations: { type: 'array', items: { type: 'object' } },
              },
              required: ['organisations'],
            },
          },
        },
      },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const create = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'create')) return;
    const name = String(req.body?.name || '').trim();
    if (!name) return res.status(400).json({ message: 'A name is required.' });
    const role = typeof req.body?.role === 'string' ? req.body.role : null;
    const permissions = req.body?.permissions ?? null;
    const rbacErr = validateRbacFields(req.body);
    if (rbacErr) return res.status(400).json({ message: rbacErr });
    // An org baseline applies to every member — only grant within the actor's own
    // effective permissions (defence-in-depth; this route is superAdmin-only).
    if (!actorCanGrant(res.locals.user, { role, permissions })) {
      return res.status(403).json({ message: 'forbidden', detail: 'You may only set an org baseline within capabilities you hold.' });
    }
    const { brand, error } = await brandForNewOrganisation(res.locals.user, req.body?.brand);
    if (error) return res.status(error.status).json(error.body);
    try {
      // Stamp the platform default rate on the new org so it is costed from the
      // start (null when no default is configured -> untracked, as before).
      const rateHistory = await defaultRateHistoryEntry();
      const org = await Organisation.create({
        id: randomUUID(),
        name,
        agentLimit: req.body?.agentLimit ?? null,
        // undefined → model default (3); explicit null = unlimited
        ...(req.body?.chargeableNumberLimit !== undefined
          ? { chargeableNumberLimit: req.body.chargeableNumberLimit }
          : {}),
        status: req.body?.status || 'active',
        role,
        permissions,
        allowedModels: req.body?.allowedModels ?? null,
        ...(rateHistory ? { rateHistory } : {}),
        brand: brand?.id ?? null,
        capabilities: capabilitiesForNewOrganisation(brand),
      });
      if (brand) {
        logger.info({ audit: 'organisation-created-with-brand', organisationId: org.id, brand: brand.id, capabilities: org.capabilities, userId: res.locals.user?.id },
          'organisation created with brand');
      }
      return res.status(201).send(org);
    } catch (err) {
      logger.error({ err: err?.message }, 'creating organisation');
      return res.status(400).json({ message: err?.message || 'Failed to create organisation' });
    }
  };
  create.apiDoc = {
    summary: 'Create an organisation.',
    description: 'A key of one brand creates organisations of that brand. Otherwise only a platform operator may name `brand`. '
      + 'The new organisation starts with the capabilities its brand has as defaults, and with none when it has no brand.',
    operationId: 'createOrganisation',
    tags: ['Organisations'],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              agentLimit: { type: 'integer', nullable: true },
              chargeableNumberLimit: { type: 'integer', nullable: true, default: 3, description: 'Max numbers the org may hold on chargeable (non-owned) trunks; null = unlimited' },
              status: { type: 'string', enum: ['provisional', 'active', 'suspended', 'deactivated'], default: 'active' },
              role: { type: 'string', nullable: true },
              permissions: { type: 'object', nullable: true },
              allowedModels: { type: 'array', items: { type: 'string' }, nullable: true },
              brand: { type: 'string', nullable: true, description: 'The brand id. Fixed once set.' },
            },
            required: ['name'],
          },
        },
      },
    },
    responses: {
      201: { description: 'Created organisation' },
      400: { description: '`unknown_brand`', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      403: { description: '`brand_not_allowed`', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: list, POST: create };
}
