/**
 * Minimal admin gate for the /api/users management routes (phase 1).
 *
 * There is no enforced RBAC yet — `users.role` is written (default
 * `{admin:true,join:true}` for everyone) but read by no route, so it is useless
 * as a discriminator. Until the migration plan's role-string + `requirePermission`
 * lands, "admin" is an explicit allowlist: the internal system principal
 * (`x-shared-token`) or a user id in the `ADMIN_USER_IDS` env list.
 *
 * Swap the body for `requirePermission(user, 'user', 'read'|'update'|...)` when
 * RBAC arrives — call sites (`requireAdmin(res.locals.user)`) won't change.
 */
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function requireAdmin(user) {
  if (!user) return false;
  if (user.isSystem === true) return true; // x-shared-token internal principal
  return ADMIN_USER_IDS.includes(user.id); // explicit human-admin allowlist
}

export default requireAdmin;
