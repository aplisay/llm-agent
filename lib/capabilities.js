/**
 * Capabilities switch whole features on for one organisation. They are held
 * as an array of names on `organisations.capabilities`.
 *
 * This module reads no database, so anything may import it.
 */
import { stepReady } from './schema-guards.js';

// `phoneRedirect`: this organisation's desk phones may be bound in the vendor's redirect service.
export const CAPABILITIES = ['phoneSystem', 'phoneRedirect'];

/** Capabilities only a platform operator gives or takes, one organisation at a time. Never a brand default. */
export const OPERATOR_ONLY_CAPABILITIES = ['phoneRedirect'];

/** The operator-only capabilities whose presence differs between two lists. */
export function operatorOnlyChanges(before, after) {
  const had = new Set(before || []);
  const has = new Set(after || []);
  return OPERATOR_ONLY_CAPABILITIES.filter((name) => had.has(name) !== has.has(name));
}

export function hasCapability(organisation, name) {
  const list = organisation?.capabilities;
  return Array.isArray(list) && list.includes(name);
}

/** The body every phone-system route sends for an organisation without the capability. */
export const PHONE_SYSTEM_DISABLED = {
  error: 'The phone system is not enabled for this organisation',
  code: 'phone_system_disabled',
};

export const PHONE_SYSTEM_NOT_READY = {
  error: 'The phone system needs a database upgrade. Run tools/agent-admin.js upgrade-db, then restart the API server.',
  code: 'phone_system_not_ready',
};

/** False on a database without the phone system schema steps. Desk phone lines also need the registrar HA1 columns. */
export function phoneSystemReady() {
  return stepReady('registrarHA1') && stepReady('phoneSystem');
}

/** False until the desk phone provisioning schema step is applied. */
export function phoneProvisioningReady() {
  return phoneSystemReady() && stepReady('phoneProvisioning');
}

/** Sends 503 `phone_system_not_ready` when the phone system schema is missing. */
export function requirePhoneSystemSchema(res) {
  if (phoneSystemReady()) return true;
  res.status(503).json(PHONE_SYSTEM_NOT_READY);
  return false;
}

/**
 * Route guard, used the way requirePermission is. The gate is about the
 * organisation, not the caller: a super admin acting on an organisation
 * without the capability is refused too.
 *
 *   if (!requirePhoneSystem(res, organisation)) return;
 */
export function requirePhoneSystem(res, organisation, field) {
  if (!requirePhoneSystemSchema(res)) return false;
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
