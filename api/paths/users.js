import { randomUUID } from 'node:crypto';
import { User, Organisation, Op } from '../../lib/database.js';
import { auth } from '../../lib/auth/index.js';
import { requirePermission, can, actorCanGrant, validateRbacFields } from '../../lib/auth/permissions.js';
import { adminScope } from '../../lib/auth/admin-scope.js';

/**
 * /api/users (collection) — RBAC-gated (`user:*`), org-scoped.
 *   GET  list users — orgAdmin sees only their own org, superAdmin/support see all
 *        (the cross-tenant `user:readAll`). status/search filter, pagination.
 *   POST admin-create a user. orgAdmin may only create in their own org and may
 *        not grant a cross-tenant role; superAdmin may target any org / role.
 * The PUBLIC sign-up lives at the sibling POST /api/users/signup (skip-listed).
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = ['owner', 'member', 'textOnly', 'audioOnly', 'support', 'orgAdmin', 'superAdmin'];
const LIST_ATTRS = ['id', 'name', 'email', 'emailVerified', 'status', 'role', 'signupMethod', 'organisationId', 'agentLimit', 'allowedModels', 'createdAt', 'updatedAt'];
const sanitize = (raw) => String(raw ?? '').trim().replace(/[%_\\]/g, '');

export default function (logger) {
  const list = async (req, res) => {
    if (!requirePermission(res, 'user', 'read')) return;
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const status = req.query.status ? String(req.query.status) : null;
    const search = sanitize(req.query.search);

    // Tenancy: orgAdmin is confined to their own org; readAll principals see all.
    const where = { ...adminScope(res.locals.user, 'user') };
    if (status) where.status = status;
    if (search) {
      const p = `%${search}%`;
      where[Op.or] = [{ email: { [Op.iLike]: p } }, { name: { [Op.iLike]: p } }];
    }
    try {
      const { count, rows } = await User.findAndCountAll({
        where,
        attributes: LIST_ATTRS,
        include: [{ model: Organisation, attributes: ['id', 'name'], required: false }],
        order: [['createdAt', 'DESC'], ['id', 'ASC']],
        limit,
        offset,
      });
      const next = count > offset + rows.length ? offset + limit : false;
      return res.send({ users: rows, next });
    } catch (err) {
      logger.error({ err: err?.message }, 'listing users');
      return res.status(500).send({ message: 'Failed to list users' });
    }
  };
  list.apiDoc = {
    summary: 'List users (admin). orgAdmin: own org only; superAdmin/support: all.',
    operationId: 'listUsers',
    tags: ['Users'],
    parameters: [
      { in: 'query', name: 'limit', required: false, schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 } },
      { in: 'query', name: 'offset', required: false, schema: { type: 'integer', minimum: 0, default: 0 } },
      { in: 'query', name: 'status', required: false, schema: { type: 'string', enum: ['provisional', 'active', 'suspended', 'deactivated'] } },
      { in: 'query', name: 'search', required: false, schema: { type: 'string' } },
    ],
    responses: {
      200: {
        description: '`{ users, next }`',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                users: { type: 'array', items: { type: 'object' } },
                next: { oneOf: [{ type: 'integer' }, { type: 'boolean', enum: [false] }] },
              },
              required: ['users', 'next'],
            },
          },
        },
      },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  // Admin-create — same primitive as signup, but the admin may pass status/role/org.
  const create = async (req, res) => {
    if (!requirePermission(res, 'user', 'create')) return;
    if (!auth) return res.status(503).json({ message: 'Sign-up is temporarily unavailable.' });

    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return res.status(400).json({ message: 'A valid email is required.' });
    const password = req.body?.password ? String(req.body.password) : null;
    const status = req.body?.status || 'provisional';
    const role = typeof req.body?.role === 'string' ? req.body.role : 'owner';
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ message: `Unknown role '${role}'.` });
    const rbacErr = validateRbacFields(req.body);
    if (rbacErr) return res.status(400).json({ message: rbacErr });

    // Escalation guards: a non-cross-tenant actor (orgAdmin) may only create users
    // in their OWN org and may not grant a cross-tenant role / permission set.
    const actorReadAll = can(res.locals.user, 'user', 'readAll');
    const organisationId = actorReadAll ? (req.body?.organisationId ?? null) : (res.locals.user.organisationId ?? null);
    const permissions = req.body?.permissions ?? null;
    const allowedModels = req.body?.allowedModels ?? null;
    // An admin may only grant a role/permission set within their OWN effective
    // permissions — blocks cross-tenant readAll AND intra-tenant capability escalation.
    if (!actorCanGrant(res.locals.user, { role, permissions })) {
      return res.status(403).json({ message: 'forbidden', detail: 'You may only grant capabilities you hold.' });
    }

    try {
      if (await User.findOne({ where: { email } })) {
        return res.status(409).json({ message: 'A user with that email already exists.' });
      }
      const extra = { role, status, signupMethod: 'admin-create', organisationId, permissions, allowedModels };
      if (password) {
        // Credentialed: better-auth writes the hash + account row; then set the
        // admin-chosen fields (signUpEmail can't take a data bag).
        await auth.api.signUpEmail({ body: { email, password, name: email.split('@')[0] } });
        await User.update(extra, { where: { email } });
      } else {
        await User.upsert({ id: randomUUID(), email, name: email.split('@')[0], emailVerified: false, ...extra });
      }
      const created = await User.findOne({ where: { email }, attributes: LIST_ATTRS });
      return res.status(201).send(created);
    } catch (err) {
      logger.error({ err: err?.message }, 'admin create user');
      return res.status(400).json({ message: err?.message || 'Failed to create user' });
    }
  };
  create.apiDoc = {
    summary: 'Create a user (admin). May set status/role/organisation/permissions/allowedModels.',
    operationId: 'adminCreateUser',
    tags: ['Users'],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              email: { type: 'string', format: 'email' },
              password: { type: 'string', minLength: 8 },
              status: { type: 'string', enum: ['provisional', 'active', 'suspended', 'deactivated'], default: 'provisional' },
              role: { type: 'string', enum: VALID_ROLES, default: 'owner' },
              organisationId: { type: 'string', nullable: true },
              permissions: { type: 'object', nullable: true },
              allowedModels: { type: 'array', items: { type: 'string' }, nullable: true },
            },
            required: ['email'],
          },
        },
      },
    },
    responses: {
      201: { description: 'Created user' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: list, POST: create };
}
