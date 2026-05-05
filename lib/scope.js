import { Op } from 'sequelize';

/**
 * Centralised tenant-scoping helpers.
 * The two helpers in this module are the single source of truth for "rows
 * this user is allowed to see / mutate". Use them everywhere — and never
 * compare `organisationId` directly with `===` / `!==` in a route handler.
 *
 * - {@link scopeWhereForUser}: build a Sequelize where-clause that scopes a
 *   query to rows owned by the user (by `userId`) or by their organisation
 *   (by `organisationId`). Use this for `findAll` / `findOne` / `destroy`.
 *
 * - {@link scopeWhereForOrganisation}: variant for tables that only have an
 *   `organisationId` column (PhoneNumber, PhoneRegistration, Trunk). Returns
 *   `null` when the user has no organisation — the caller must short-circuit
 *   to a 403 / empty list rather than building a query that would otherwise
 *   match every NULL row.
 *
 * - {@link userOwnsRow}: predicate for "I have already fetched this row by
 *   primary key, may this user touch it?". Use this whenever a route does a
 *   `findByPk` (which is unscoped by definition) and then needs to authorise
 *   the requester before reading or mutating the result.
 */

/**
 * Build a Sequelize `where` fragment that scopes a query to rows the user is
 * permitted to see. The returned object is always spreadable into a parent
 * where-clause, e.g.:
 *
 *   const where = { id: callId, ...scopeWhereForUser(user) };
 *
 * or, when combining with an existing `[Op.and]`/`[Op.or]`:
 *
 *   const where = { [Op.and]: [{ index: { [Op.gt]: 0 } }, scopeWhereForUser(user)] };
 *
 * For a user with both `id` and `organisationId`, returns
 *   `{ [Op.or]: [{ userId }, { organisationId }] }`.
 * For a user with only `id` (no organisation), returns `{ userId }`.
 * For a user with only `organisationId` (e.g. some test fixtures), returns
 * `{ organisationId }`.
 *
 * Throws if the user object is missing or has neither identifier — this
 * should not happen in production because the auth middleware refuses such
 * requests upstream.
 *
 * @param {{id?: string, organisationId?: string|null}} user
 * @returns {object} a Sequelize where fragment
 */
export function scopeWhereForUser(user) {
  if (!user) {
    throw new Error('scopeWhereForUser: user is required');
  }
  const hasUserId = user.id != null;
  const hasOrgId = user.organisationId != null;

  if (hasUserId && hasOrgId) {
    return { [Op.or]: [{ userId: user.id }, { organisationId: user.organisationId }] };
  }
  if (hasUserId) {
    return { userId: user.id };
  }
  if (hasOrgId) {
    return { organisationId: user.organisationId };
  }
  throw new Error('scopeWhereForUser: user has neither id nor organisationId');
}

/**
 * Variant of {@link scopeWhereForUser} for tables that have only an
 * `organisationId` column and no `userId` (PhoneNumber, PhoneRegistration,
 * Trunk).
 *
 * Returns `null` when the user has no organisation. Callers MUST check for
 * `null` and short-circuit to an empty result / 403; passing the result of
 * this helper through to a query when it is `null` would be a mistake.
 *
 * Pattern:
 *
 *   const orgScope = scopeWhereForOrganisation(user);
 *   if (!orgScope) {
 *     return res.status(403).send({ error: 'Organisation membership required' });
 *   }
 *   const rows = await PhoneRegistration.findAll({ where: { ...orgScope, ... } });
 *
 * @param {{organisationId?: string|null}} user
 * @returns {object|null} `{ organisationId }` or `null`
 */
export function scopeWhereForOrganisation(user) {
  if (!user) {
    throw new Error('scopeWhereForOrganisation: user is required');
  }
  if (user.organisationId == null) {
    return null;
  }
  return { organisationId: user.organisationId };
}

/**
 * Predicate: does the given user own (or share an organisation with) the
 * given row?
 *
 * The check is deliberately conservative: it requires both sides of the
 * comparison to be non-null AND equal. A user with no organisation
 * never owns an org-tagged row by default, and a row with no organisation
 * is never claimable by an organisation member.
 *
 * The function returns `true` if any of these match:
 *   - both `user.id` and `row.userId` are set and equal, OR
 *   - both `user.organisationId` and `row.organisationId` are set and equal.
 *
 * @param {{id?: string, organisationId?: string|null}|null|undefined} user
 * @param {{userId?: string, organisationId?: string|null}|null|undefined} row
 * @returns {boolean}
 */
export function userOwnsRow(user, row) {
  if (!user || !row) return false;

  if (user.id != null && row.userId != null && row.userId === user.id) {
    return true;
  }
  if (
    user.organisationId != null &&
    row.organisationId != null &&
    row.organisationId === user.organisationId
  ) {
    return true;
  }
  return false;
}

/**
 * PhoneNumber-specific ownership predicate.
 *
 * The `phone_numbers` table does not have a `user_id` column — historically
 * a number's "owner" was its `organisationId`. That model breaks for
 * organisation-less users: numbers in the pool have `organisation_id IS
 * NULL`, and `userOwnsRow` (correctly) refuses to match `null` against
 * `null`. Yet we still want a no-org user to be able to *use* a pool number
 * they have already claimed — i.e. one whose `instanceId` points at a
 * listener they own.
 *
 * Ownership therefore extends transitively through the bound Instance:
 *   - direct: `userOwnsRow(user, phoneNumber)` matches the org, OR
 *   - transitive: the linked Instance is owned by the user.
 *
 * The transitive branch only fires when the caller has loaded the linked
 * Instance via Sequelize `include` (the default association alias is
 * `Instance`). We do NOT refetch from the database here, to avoid hidden
 * N+1 queries; callers must pass an eagerly-loaded row.
 *
 * @param {{id?: string, organisationId?: string|null}|null|undefined} user
 * @param {{
 *   userId?: string,
 *   organisationId?: string|null,
 *   instanceId?: string|null,
 *   Instance?: {userId?: string, organisationId?: string|null}|null
 * }|null|undefined} phoneNumber
 * @returns {boolean}
 */
export function userOwnsPhoneNumber(user, phoneNumber) {
  if (!user || !phoneNumber) return false;
  if (userOwnsRow(user, phoneNumber)) return true;
  // Sequelize default association is the singular model name; some callers
  // (e.g. the LiveKit api-client response) use a lower-case `instance`
  // field, so accept either.
  const linkedInstance = phoneNumber.Instance ?? phoneNumber.instance;
  if (linkedInstance && userOwnsRow(user, linkedInstance)) return true;
  return false;
}
