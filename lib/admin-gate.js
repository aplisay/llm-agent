/**
 * Admin gate for the /api/users and /api/organisations management routes.
 *
 * Now RBAC-aware (see lib/auth/permissions.js): "admin" is resolved from the
 * principal's effective permissions, with `ADMIN_USER_IDS` retained purely as a
 * BOOTSTRAP super-admin allowlist — it lets the first super admin exist before
 * any `superAdmin` role has been assigned, and is what middleware/auth.js grants
 * full permissions to. The internal system principal (`x-shared-token`) is also
 * all-powerful.
 *
 * Most routes now call `requirePermission(res, resource, action)` +
 * `adminScope`/`targetInScope` directly for fine-grained, org-scoped control.
 * `requireAdmin` remains as a coarse back-compat shim meaning "may administer
 * users at all" (org admin OR super admin).
 */
import { can } from './auth/permissions.js';

const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/**
 * Bootstrap super-admins: the internal system principal, or an id in the
 * `ADMIN_USER_IDS` env allowlist. middleware/auth.js grants these full
 * (`superAdmin`) permissions at auth time, regardless of stored role.
 */
export function isBootstrapSuperAdmin(user) {
  if (!user) return false;
  if (user.isSystem === true) return true;
  return user.id != null && ADMIN_USER_IDS.includes(user.id);
}

/** Cross-tenant super admin: bootstrap, or holds `user:readAll` (the superAdmin role). */
export function isSuperAdmin(user) {
  return isBootstrapSuperAdmin(user) || can(user, 'user', 'readAll');
}

/**
 * Coarse back-compat shim: may this principal administer users at all (org admin
 * OR super admin)? New code should prefer `requirePermission` + `adminScope`.
 */
export function requireAdmin(user) {
  return isBootstrapSuperAdmin(user) || can(user, 'user', 'read');
}

export { ADMIN_USER_IDS };
export default requireAdmin;
