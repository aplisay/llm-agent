/**
 * Where a phone fetches its settings, and the phone's own admin password.
 * Reads no database, so anything may import it.
 */
import { createHmac, randomBytes } from 'node:crypto';

/**
 * The phone's own admin and web password. Made from CREDENTIALS_KEY and the
 * device id, so it is the same at every fetch and is stored nowhere. Without
 * the key it is random at each fetch and nobody can know it.
 */
export function deviceAdminPassword(deviceId, env = process.env) {
  if (!env.CREDENTIALS_KEY) return randomBytes(15).toString('base64url');
  return createHmac('sha256', String(env.CREDENTIALS_KEY)).update(`phone-admin:${deviceId}`).digest('base64url').slice(0, 20);
}

/** The public base address of the provisioning service, from PROV_PUBLIC_URL. Null unless it is an https URL. */
export function provisioningPublicUrl(env = process.env) {
  const raw = String(env.PROV_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  return /^https:\/\/[a-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._~/-]*)?$/i.test(raw) ? raw : null;
}

export const settingServerUrl = (publicUrl, token) => `${publicUrl}/snom/${token}/{mac}.xml`;
