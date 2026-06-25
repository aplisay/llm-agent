/**
 * Admin tenancy scoping for the `/api/users` and `/api/organisations` resources
 * (R3 / R4). RBAC (`can`) decides whether the principal may perform the action
 * at all; THIS module decides on whose rows.
 *
 * The cross-tenant capability is the `readAll` action:
 *   - a principal with `<resource>:readAll` (superAdmin / support) operates on
 *     ALL organisations;
 *   - otherwise (orgAdmin) they are confined to their OWN organisation.
 *
 * Note the scope COLUMN differs by resource: users are scoped by their
 * `organisationId`, organisations by their own `id`.
 */
import { can } from './permissions.js';

const NO_ORG = '__none__'; // sentinel so an org-less admin matches nothing (fail-closed)

/**
 * A Sequelize `where` fragment confining a LIST query to the rows the principal
 * may administer. `{}` (no filter) for a cross-tenant principal.
 *
 * @param {object} user  res.locals.user
 * @param {'user'|'organisation'} resource
 */
export function adminScope(user, resource) {
  if (can(user, resource, 'readAll')) return {};
  const orgId = user?.organisationId ?? NO_ORG;
  return resource === 'organisation' ? { id: orgId } : { organisationId: orgId };
}

/**
 * May the principal act on this already-loaded target row? `true` for a
 * cross-tenant principal; otherwise only when the target belongs to the
 * principal's own organisation. Used after a `findByPk` on item routes —
 * callers should 404 (not 403) when this returns false, to avoid leaking
 * existence across tenants.
 *
 * @param {object} user
 * @param {'user'|'organisation'} resource
 * @param {object} target  the loaded User or Organisation row
 */
export function targetInScope(user, resource, target) {
  if (can(user, resource, 'readAll')) return true;
  if (!target || user?.organisationId == null) return false;
  const targetOrgId = resource === 'organisation' ? target.id : target.organisationId;
  return targetOrgId != null && targetOrgId === user.organisationId;
}

export default { adminScope, targetInScope };
