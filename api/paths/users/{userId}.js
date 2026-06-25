import { User, Organisation } from '../../../lib/database.js';
import { requirePermission, can, actorCanGrant, validateRbacFields } from '../../../lib/auth/permissions.js';
import { targetInScope } from '../../../lib/auth/admin-scope.js';

/**
 * /api/users/{userId} (item) — RBAC-gated (`user:*`), org-scoped.
 *   GET    fetch a user (orgAdmin: own org only).
 *   PATCH  accept/activate (status), and edit role / agentLimit / name /
 *          permissions / allowedModels / organisationId. Cross-tenant edits
 *          (granting a cross-tenant role/permission, or moving a user to another
 *          org) require the cross-tenant `user:readAll` (superAdmin).
 *   DELETE soft-deactivate (status='deactivated'); superAdmin only (`user:delete`).
 *          orgAdmin deactivates a user via PATCH { status:'deactivated' } instead.
 *
 * Out-of-scope targets return 404 (not 403) so existence isn't leaked across tenants.
 * This route must stay GET/PATCH/DELETE only — the POST-only signup sibling
 * (/api/users/signup) relies on there being no POST here.
 */
const EDITABLE = ['status', 'role', 'agentLimit', 'name', 'permissions', 'allowedModels', 'organisationId'];
const VALID_ROLES = ['owner', 'member', 'textOnly', 'audioOnly', 'support', 'orgAdmin', 'superAdmin'];

export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'user', 'read')) return;
    const u = await User.findByPk(req.params.userId, { include: [{ model: Organisation, attributes: ['id', 'name'], required: false }] });
    if (!u || !targetInScope(res.locals.user, 'user', u)) {
      return res.status(404).send({ message: `User ${req.params.userId} not found` });
    }
    return res.send(u);
  };
  get.apiDoc = {
    summary: 'Get a user (admin).',
    operationId: 'getUser',
    tags: ['Users'],
    parameters: [{ in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'User' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const update = async (req, res) => {
    if (!requirePermission(res, 'user', 'update')) return;
    const u = await User.findByPk(req.params.userId);
    if (!u || !targetInScope(res.locals.user, 'user', u)) {
      return res.status(404).send({ message: `User ${req.params.userId} not found` });
    }
    const actorReadAll = can(res.locals.user, 'user', 'readAll');
    const isSelf = req.params.userId === res.locals.user.id;

    // Self-protection: an admin may not edit their OWN role/permissions/status/org/
    // allowedModels via this route (prevents self-escalation — incl. self-widening
    // their own model allow-list past an admin-set restriction). Bootstrap
    // super-admins are env-driven so this never locks them out; name/agentLimit
    // self-edits are fine.
    if (isSelf && ['role', 'permissions', 'status', 'organisationId', 'allowedModels'].some((k) => k in req.body)) {
      return res.status(403).json({ message: 'forbidden', detail: 'You cannot change your own role, permissions, status, organisation, or model access.' });
    }

    // Per-field capability guards.
    if ('role' in req.body) {
      if (!can(res.locals.user, 'user', 'setRole')) return res.status(403).json({ message: 'forbidden', detail: 'Requires user:setRole' });
      if (!VALID_ROLES.includes(req.body.role)) return res.status(400).send({ message: `Unknown role '${req.body.role}'.` });
    }
    if (('permissions' in req.body || 'allowedModels' in req.body) && !can(res.locals.user, 'user', 'setPermissions')) {
      return res.status(403).json({ message: 'forbidden', detail: 'Requires user:setPermissions' });
    }
    if ('agentLimit' in req.body && !can(res.locals.user, 'user', 'setLimits')) {
      return res.status(403).json({ message: 'forbidden', detail: 'Requires user:setLimits' });
    }
    if ('organisationId' in req.body && !actorReadAll) {
      return res.status(403).json({ message: 'forbidden', detail: 'Only a super admin may move a user between organisations.' });
    }
    // An admin may only grant a role/permission set within their OWN effective perms
    // — blocks cross-tenant readAll AND intra-tenant capability escalation by proxy.
    if (('role' in req.body || 'permissions' in req.body)
        && !actorCanGrant(res.locals.user, { role: req.body.role, permissions: req.body.permissions })) {
      return res.status(403).json({ message: 'forbidden', detail: 'You may only grant capabilities you hold.' });
    }

    const rbacErr = validateRbacFields(req.body);
    if (rbacErr) return res.status(400).send({ message: rbacErr });

    for (const k of EDITABLE) if (k in req.body) u[k] = req.body[k]; // e.g. { status: 'active' } == ACCEPT
    try {
      await u.save();
      // Accepting a (self-signup) user also activates their PROVISIONAL org so the
      // org-status gate doesn't immediately re-block the freshly-accepted user.
      if (req.body.status === 'active' && u.organisationId) {
        const org = await Organisation.findByPk(u.organisationId);
        if (org && org.status === 'provisional') { org.status = 'active'; await org.save(); }
      }
      return res.send(u);
    } catch (err) {
      logger.error({ err: err?.message }, 'updating user');
      return res.status(400).send({ message: err?.message || 'Failed to update user' });
    }
  };
  update.apiDoc = {
    summary: 'Modify a user (admin): accept/activate, set role, agentLimit, name, permissions, allowedModels, organisation.',
    operationId: 'updateUser',
    tags: ['Users'],
    parameters: [{ in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['provisional', 'active', 'suspended', 'deactivated'] },
              role: { type: 'string', enum: VALID_ROLES },
              agentLimit: { type: 'integer', nullable: true },
              name: { type: 'string' },
              permissions: { type: 'object', nullable: true },
              allowedModels: { type: 'array', items: { type: 'string' }, nullable: true },
              organisationId: { type: 'string', nullable: true },
            },
            required: [],
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated user' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const del = async (req, res) => {
    if (!requirePermission(res, 'user', 'delete')) return;
    const u = await User.findByPk(req.params.userId);
    if (!u || !targetInScope(res.locals.user, 'user', u)) {
      return res.status(404).send({ message: `User ${req.params.userId} not found` });
    }
    // Soft-delete: deactivate rather than destroy (FK'd data elsewhere).
    u.status = 'deactivated';
    await u.save();
    return res.status(200).send();
  };
  del.apiDoc = {
    summary: 'Deactivate a user (super admin, soft delete).',
    operationId: 'deactivateUser',
    tags: ['Users'],
    parameters: [{ in: 'path', name: 'userId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Deactivated' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PATCH: update, DELETE: del };
}
