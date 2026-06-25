import { Organisation } from '../../../lib/database.js';
import { requirePermission, can, actorCanGrant, validateRbacFields } from '../../../lib/auth/permissions.js';
import { targetInScope } from '../../../lib/auth/admin-scope.js';

/**
 * /api/organisations/{organisationId} (item) — RBAC-gated (`organisation:*`),
 * org-scoped. Backs the (super-admin-only) org-edit modal in the SPA Users tab.
 *   GET    fetch an organisation (orgAdmin: own org only).
 *   PATCH  edit name / agentLimit / status (orgAdmin, own org) and the RBAC/model
 *          baseline role / permissions / allowedModels (superAdmin only — these
 *          are a platform policy; `organisation:setPermissions`).
 *   DELETE soft-deactivate (status='deactivated'); superAdmin only
 *          (`organisation:delete`). Never destroy — orgs CASCADE to users/agents.
 *
 * Out-of-scope targets return 404 so existence isn't leaked across tenants.
 */
export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'read')) return;
    const org = await Organisation.findByPk(req.params.organisationId);
    if (!org || !targetInScope(res.locals.user, 'organisation', org)) {
      return res.status(404).send({ message: `Organisation ${req.params.organisationId} not found` });
    }
    return res.send(org);
  };
  get.apiDoc = {
    summary: 'Get an organisation (admin).',
    operationId: 'getOrganisation',
    tags: ['Organisations'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Organisation' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const update = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'update')) return;
    const org = await Organisation.findByPk(req.params.organisationId);
    if (!org || !targetInScope(res.locals.user, 'organisation', org)) {
      return res.status(404).send({ message: `Organisation ${req.params.organisationId} not found` });
    }

    // name / status are covered by organisation:update (entry check). agentLimit
    // needs setLimits; the RBAC/model baseline (role/permissions/allowedModels)
    // needs setPermissions — superAdmin only, and never cross-tenant.
    if ('agentLimit' in req.body && !can(res.locals.user, 'organisation', 'setLimits')) {
      return res.status(403).json({ message: 'forbidden', detail: 'Requires organisation:setLimits' });
    }
    const baselineKeys = ['role', 'permissions', 'allowedModels'];
    if (baselineKeys.some((k) => k in req.body)) {
      if (!can(res.locals.user, 'organisation', 'setPermissions')) {
        return res.status(403).json({ message: 'forbidden', detail: 'Requires organisation:setPermissions (super admin)' });
      }
      if (!actorCanGrant(res.locals.user, { role: req.body.role, permissions: req.body.permissions })) {
        return res.status(403).json({ message: 'forbidden', detail: 'You may only set an org baseline within capabilities you hold.' });
      }
    }

    const rbacErr = validateRbacFields(req.body);
    if (rbacErr) return res.status(400).send({ message: rbacErr });

    const EDITABLE = ['name', 'agentLimit', 'status', 'role', 'permissions', 'allowedModels'];
    for (const k of EDITABLE) if (k in req.body) org[k] = req.body[k];
    try {
      await org.save();
      return res.send(org);
    } catch (err) {
      logger.error({ err: err?.message }, 'updating organisation');
      return res.status(400).send({ message: err?.message || 'Failed to update organisation' });
    }
  };
  update.apiDoc = {
    summary: 'Modify an organisation: name/status/agentLimit (admin); role/permissions/allowedModels baseline (super admin).',
    operationId: 'updateOrganisation',
    tags: ['Organisations'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              agentLimit: { type: 'integer', nullable: true },
              status: { type: 'string', enum: ['provisional', 'active', 'suspended', 'deactivated'] },
              role: { type: 'string', nullable: true },
              permissions: { type: 'object', nullable: true },
              allowedModels: { type: 'array', items: { type: 'string' }, nullable: true },
            },
            required: [],
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated organisation' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const del = async (req, res) => {
    if (!requirePermission(res, 'organisation', 'delete')) return; // superAdmin only
    const org = await Organisation.findByPk(req.params.organisationId);
    if (!org || !targetInScope(res.locals.user, 'organisation', org)) {
      return res.status(404).send({ message: `Organisation ${req.params.organisationId} not found` });
    }
    // Soft-delete: deactivate rather than destroy (CASCADEs to users/agents/etc).
    org.status = 'deactivated';
    await org.save();
    return res.status(200).send();
  };
  del.apiDoc = {
    summary: 'Deactivate an organisation (super admin, soft delete).',
    operationId: 'deactivateOrganisation',
    tags: ['Organisations'],
    parameters: [{ in: 'path', name: 'organisationId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Deactivated' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PATCH: update, DELETE: del };
}
