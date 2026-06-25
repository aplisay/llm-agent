import { User } from '../../../lib/database.js';
import { requireAdmin } from '../../../lib/admin-gate.js';

/**
 * /api/users/{userId} (item) — ADMIN-gated.
 *   GET    fetch a user.
 *   PATCH  the accept/activate primitive (status: provisional -> active) plus
 *          role / agentLimit / name edits. Direct Sequelize (status is our own
 *          domain column, not modelled by better-auth).
 *   DELETE soft-deactivate (status='deactivated'); never destroy (FK'd data).
 *
 * NB: this route must stay GET/PATCH/DELETE only — the POST-only signup sibling
 * (/api/users/signup) relies on there being no POST here, or it could be shadowed.
 */
const EDITABLE = ['status', 'role', 'agentLimit', 'name'];

export default function (logger) {
  const get = async (req, res) => {
    if (!requireAdmin(res.locals.user)) return res.status(403).json({ message: 'Admin only' });
    const u = await User.findByPk(req.params.userId);
    return u ? res.send(u) : res.status(404).send({ message: `User ${req.params.userId} not found` });
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
    if (!requireAdmin(res.locals.user)) return res.status(403).json({ message: 'Admin only' });
    const u = await User.findByPk(req.params.userId);
    if (!u) return res.status(404).send({ message: `User ${req.params.userId} not found` });
    for (const k of EDITABLE) if (k in req.body) u[k] = req.body[k]; // e.g. { status: 'active' } == ACCEPT
    try {
      await u.save();
      return res.send(u);
    } catch (err) {
      logger.error({ err: err?.message }, 'updating user');
      return res.status(400).send({ message: err?.message || 'Failed to update user' });
    }
  };
  update.apiDoc = {
    summary: 'Modify a user (admin): accept/activate, set role, agentLimit, name.',
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
              role: { type: 'object' },
              agentLimit: { type: 'integer', nullable: true },
              name: { type: 'string' },
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
    if (!requireAdmin(res.locals.user)) return res.status(403).json({ message: 'Admin only' });
    const u = await User.findByPk(req.params.userId);
    if (!u) return res.status(404).send({ message: `User ${req.params.userId} not found` });
    // Soft-delete: deactivate rather than destroy (FK'd data elsewhere).
    u.status = 'deactivated';
    await u.save();
    return res.status(200).send();
  };
  del.apiDoc = {
    summary: 'Deactivate a user (admin, soft delete).',
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
