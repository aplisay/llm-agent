import { randomUUID } from 'node:crypto';
import { Organisation } from '../../lib/database.js';
import { requirePermission, actorCanGrant, validateRbacFields } from '../../lib/auth/permissions.js';
import { adminScope } from '../../lib/auth/admin-scope.js';
import { defaultRateHistoryEntry } from '../../lib/rates.js';

/**
 * /api/organisations (collection) — RBAC-gated (`organisation:*`), org-scoped.
 *   GET  list organisations. orgAdmin sees only their own; superAdmin/support
 *        see all (cross-tenant `organisation:readAll`). Feeds both the SPA Users
 *        admin tab org-filter and the (super-admin-only) org-edit modal.
 *   POST create an organisation — superAdmin only (`organisation:create`).
 */
const LIST_ATTRS = ['id', 'name', 'status', 'agentLimit', 'role', 'allowedModels', 'permissions'];

export default function (logger) {
  const list = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'read')) return;
    try {
      const rows = await Organisation.findAll({
        where: { ...adminScope(res.locals.user, 'organisation') },
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
    if (!requirePermission(res, 'organisation', 'create')) return; // superAdmin only
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
    try {
      // Stamp the platform default rate on the new org so it is costed from the
      // start (null when no default is configured -> untracked, as before).
      const rateHistory = await defaultRateHistoryEntry();
      const org = await Organisation.create({
        id: randomUUID(),
        name,
        agentLimit: req.body?.agentLimit ?? null,
        status: req.body?.status || 'active',
        role,
        permissions,
        allowedModels: req.body?.allowedModels ?? null,
        ...(rateHistory ? { rateHistory } : {}),
      });
      return res.status(201).send(org);
    } catch (err) {
      logger.error({ err: err?.message }, 'creating organisation');
      return res.status(400).json({ message: err?.message || 'Failed to create organisation' });
    }
  };
  create.apiDoc = {
    summary: 'Create an organisation (super admin).',
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
              status: { type: 'string', enum: ['provisional', 'active', 'suspended', 'deactivated'], default: 'active' },
              role: { type: 'string', nullable: true },
              permissions: { type: 'object', nullable: true },
              allowedModels: { type: 'array', items: { type: 'string' }, nullable: true },
            },
            required: ['name'],
          },
        },
      },
    },
    responses: {
      201: { description: 'Created organisation' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: list, POST: create };
}
