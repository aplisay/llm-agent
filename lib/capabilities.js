/**
 * Capabilities switch whole features on for one organisation. They are held
 * as an array of names on `organisations.capabilities`.
 *
 * This module reads no database, so anything may import it.
 */

export const CAPABILITIES = ['phoneSystem'];

export function hasCapability(organisation, name) {
  const list = organisation?.capabilities;
  return Array.isArray(list) && list.includes(name);
}

/** The body every phone-system route sends for an organisation without the capability. */
export const PHONE_SYSTEM_DISABLED = {
  error: 'The phone system is not enabled for this organisation',
  code: 'phone_system_disabled',
};

/**
 * Route guard, used the way requirePermission is. The gate is about the
 * organisation, not the caller: a super admin acting on an organisation
 * without the capability is refused too.
 *
 *   if (!requirePhoneSystem(res, organisation)) return;
 */
export function requirePhoneSystem(res, organisation, field) {
  if (hasCapability(organisation, 'phoneSystem')) return true;
  res.status(403).json(field ? { ...PHONE_SYSTEM_DISABLED, field } : PHONE_SYSTEM_DISABLED);
  return false;
}

/** An error message for a capability list that cannot be stored, or null. */
export function validateCapabilities(list) {
  if (!Array.isArray(list)) return 'capabilities must be an array of strings';
  for (const name of list) {
    if (typeof name !== 'string' || !CAPABILITIES.includes(name)) return `Unknown capability: ${String(name)}`;
  }
  return null;
}
