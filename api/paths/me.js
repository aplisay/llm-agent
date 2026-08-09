import { can, roles, actorCanGrant, effectivePermissions, statementsFor } from '../../lib/auth/permissions.js';
import { isSuperAdmin } from '../../lib/admin-gate.js';

/**
 * GET /api/me — the caller's own identity + resolved RBAC view.
 *
 * Lets the SPA gate admin affordances (the Users tab, the super-admin-only
 * org-edit modal) and offer only roles the caller may actually assign, without a
 * separate admin probe. NOT admin-gated — every authenticated principal may read
 * their OWN record. `res.locals.user` and its memoised `_effectivePermissions` /
 * `_allowedModels` are set by middleware/auth.js (attachRbac).
 */
export default function (logger) {
  const getMe = async (req, res) => {
    const u = res.locals.user;
    if (!u) return res.status(401).json({ message: 'Not authenticated' });
    return res.send({
      id: u.id ?? null,
      email: u.email ?? null,
      name: u.name ?? null,
      organisationId: u.organisationId ?? null,
      // The caller's own org name — every principal may see it, so dashboards
      // don't need the admin-gated GET /organisations just to label the shell
      // (member sessions were 403ing that on every layout load).
      organisationName: u.Organisation?.name ?? null,
      role: u.role ?? null,
      status: u.status ?? null,
      // Prefer the memoised map; fall back to a live computation so principals
      // attachRbac never ran on (no-auth defaultUser, x-shared-token system) still
      // report a permissions map consistent with isAdmin/isSuperAdmin below.
      permissions: u._effectivePermissions
        ?? (u.isSystem ? statementsFor('superAdmin') : effectivePermissions(u, u.Organisation)),
      allowedModels: u._allowedModels ?? null, // null = unrestricted
      isAdmin: can(u, 'user', 'read'),          // org admin OR super
      isSuperAdmin: isSuperAdmin(u),            // cross-tenant
      assignableRoles: Object.keys(roles).filter((r) => actorCanGrant(u, { role: r })),
    });
  };
  getMe.apiDoc = {
    summary: "The caller's own identity and resolved RBAC permissions.",
    operationId: 'getMe',
    tags: ['Users'],
    responses: {
      200: {
        description: 'Caller identity + effective permissions',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { GET: getMe };
}
