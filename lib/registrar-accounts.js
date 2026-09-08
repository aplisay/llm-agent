/**
 * Registrar accounts: the platform-issued identities a customer's PBX registers
 * to us with (regserver, hitlist H16).
 *
 * A registrar-mode `phone_registrations` row inverts a line. `registrar` is no
 * longer the customer's registrar but ours — the deployment's balancer name,
 * which is also the digest realm every PBX hashes its password against — and
 * `username` and `password` are minted rather than given. This module holds
 * the two facts the create route and the credentials routes share: what the
 * realm is on this deployment, and what a customer needs to type into a PBX.
 *
 * Design: aplisay-strategy implementation/regserver-tactical-spec.md §2.
 */

/** The port every deployment's balancer listens on; TLS only. */
export const REGISTRAR_PORT = 5061;
export const REGISTRAR_TRANSPORT = 'tls';

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The name this deployment's PBXes register to, from REGSERVER_REGISTRAR.
 *
 * A bare hostname. A scheme, port or parameter that found its way into the
 * variable is stripped rather than stored, because the value becomes the
 * `registrar` column of every account and the realm the node challenges with,
 * and the regserver checks that the two agree row by row. Null when unset or
 * not a hostname, which the create route reports as 503: an account issued
 * against a realm nothing serves is worse than no account.
 */
export function registrarRealm(env = process.env) {
  const raw = String(env.REGSERVER_REGISTRAR || '').trim().replace(/^sips?:/i, '');
  if (!raw) return null;
  const host = raw.split(/[:;/]/)[0].toLowerCase();
  return HOSTNAME_RE.test(host) ? host : null;
}

export function isRegistrarAccount(registration) {
  return registration?.mode === 'registrar';
}

/**
 * What a customer enters into their PBX. The password comes back through the
 * model getter, which decrypts it; callers that just minted one may pass it
 * explicitly to avoid depending on the instance having been reloaded.
 */
export function credentialsFor(registration, password = registration.password) {
  return {
    id: registration.id,
    registrar: registration.registrar,
    port: REGISTRAR_PORT,
    transport: REGISTRAR_TRANSPORT,
    username: registration.username,
    password
  };
}
