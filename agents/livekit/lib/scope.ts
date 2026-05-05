/**
 * Tenant ownership predicate for the LiveKit worker.
 *
 * The platform-side scoping helpers live in `lib/scope.js`; this module is a
 * deliberately tiny mirror because the worker is a TypeScript build and
 * cannot import the JS module directly. The semantics MUST match
 * `userOwnsRow` in `lib/scope.js`: the row is owned if (and only if) the
 * caller and row share a matching, non-null `userId` or a matching, non-null
 * `organisationId`.
 *
 * Why the strict null check matters: `null === null` is `true` and
 * `null !== null` is `false` in JavaScript. A naive
 * `caller.organisationId !== row.organisationId` check therefore "passes"
 * whenever both sides are null, which lets two no-organisation tenants
 * reach each others' rows. Centralising the comparison here means the
 * worker cannot accidentally re-introduce that bug.
 */
export interface OwnershipIdentity {
  id?: string | null;
  userId?: string | null;
  organisationId?: string | null;
}

export interface OwnedRow {
  userId?: string | null;
  organisationId?: string | null;
}

/**
 * True iff the caller owns the row, by either:
 *   - both `caller.id` (or `caller.userId`) and `row.userId` are non-null
 *     and equal; OR
 *   - both `caller.organisationId` and `row.organisationId` are non-null
 *     and equal.
 *
 * Returns false when either side of every potential match is null/undefined.
 */
export function userOwnsRow(
  caller: OwnershipIdentity | null | undefined,
  row: OwnedRow | null | undefined,
): boolean {
  if (!caller || !row) return false;

  const callerUserId = caller.id ?? caller.userId ?? null;
  if (callerUserId != null && row.userId != null && row.userId === callerUserId) {
    return true;
  }

  if (
    caller.organisationId != null &&
    row.organisationId != null &&
    row.organisationId === caller.organisationId
  ) {
    return true;
  }

  return false;
}

/**
 * PhoneNumber-specific ownership predicate. Mirrors the JS helper in
 * `lib/scope.js`. Use this for "may this caller use this PhoneNumber as a
 * caller-ID?" decisions.
 *
 * A caller owns a phone number when:
 *   - the org/userId matches directly (via `userOwnsRow`), OR
 *   - the linked Instance is owned by the caller. The Instance must be
 *     eagerly attached on the row (any of `Instance` / `instance`); we do
 *     not fetch it from the API here.
 */
export interface PhoneNumberWithInstance extends OwnedRow {
  instanceId?: string | null;
  Instance?: OwnedRow | null;
  instance?: OwnedRow | null;
}

export function userOwnsPhoneNumber(
  caller: OwnershipIdentity | null | undefined,
  phoneNumber: PhoneNumberWithInstance | null | undefined,
): boolean {
  if (!caller || !phoneNumber) return false;
  if (userOwnsRow(caller, phoneNumber)) return true;
  const linkedInstance = phoneNumber.Instance ?? phoneNumber.instance ?? null;
  if (linkedInstance && userOwnsRow(caller, linkedInstance)) return true;
  return false;
}
