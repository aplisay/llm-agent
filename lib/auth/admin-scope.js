/**
 * Admin tenancy scoping for the `/api/users` and `/api/organisations` resources
 * (R3 / R4). RBAC (`can`) decides whether the principal may perform the action
 * at all; THIS module decides on whose rows.
 *
 * The cross-tenant capability is the `readAll` action:
 *   - a principal with `<resource>:readAll` (superAdmin / support) operates on
 *     ALL organisations;
 *   - a principal with `readAll` whose key carries a brand operates on the
 *     organisations of that brand only (lib/brands.js);
 *   - otherwise (orgAdmin) they are confined to their OWN organisation.
 *
 * Note the scope COLUMN differs by resource: users are scoped by their
 * `organisationId`, organisations by their own `id`.
 */
import { can } from './permissions.js';
import { principalBrand } from '../brands.js';

const NO_ORG = '__none__'; // sentinel so an org-less admin matches nothing (fail-closed)

/**
 * A Sequelize `where` fragment confining a LIST query to the rows the principal
 * may administer. `{}` (no filter) for a cross-tenant principal.
 *
 * Brand scoping covers organisations only. A principal with a brand reaches no
 * user rows of another organisation: no brand key holds a `user` permission yet.
 *
 * @param {object} user  res.locals.user
 * @param {'user'|'organisation'} resource
 */
export function adminScope(user, resource) {
  if (can(user, resource, 'readAll')) {
    const brand = principalBrand(user);
    if (!brand) return {};
    return resource === 'organisation' ? { brand } : { organisationId: NO_ORG };
  }
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
  if (can(user, resource, 'readAll')) {
    const brand = principalBrand(user);
    if (!brand) return true;
    if (!target) return false;
    return resource === 'organisation' && target.brand === brand;
  }
  if (!target || user?.organisationId == null) return false;
  const targetOrgId = resource === 'organisation' ? target.id : target.organisationId;
  return targetOrgId != null && targetOrgId === user.organisationId;
}

export default { adminScope, targetInScope };
