/**
 * Shared resolution for the regclient facade routes.
 *
 * Every route in this family answers the same three questions before it can do
 * anything useful: does this registration exist and belong to the caller's
 * organisation, which node owns it, and is this deployment configured to talk
 * to nodes at all. Doing that once here keeps the routes to their actual job —
 * shaping one request and one response.
 *
 * Returns either `{ ok: false, status, body }`, ready to send verbatim, or
 * `{ ok: true, registration, node, config }`.
 */

import { PhoneRegistration } from './database.js';
import {
  loadRegclientConfig,
  configurationProblem,
  assertNodeAddressAllowed,
  selectProbeNode
} from './regclient.js';

export async function resolveRegistrationNode({
  identifier,
  organisationId,
  allowUnclaimed = false,
  env = process.env,
  log
}) {
  if (!identifier) {
    return { ok: false, status: 400, body: { message: 'Registration ID is required' } };
  }
  if (identifier.match(/^\+?[0-9]+$/)) {
    return {
      ok: false,
      status: 400,
      body: { message: 'Identifier must be a registration ID, not a phone number' }
    };
  }

  const registration = await PhoneRegistration.findByPk(identifier);
  if (!registration) {
    return { ok: false, status: 404, body: { message: 'Phone registration not found' } };
  }
  if (registration.organisationId !== organisationId) {
    return { ok: false, status: 403, body: { message: 'Access denied' } };
  }

  const config = loadRegclientConfig(env);
  const problem = configurationProblem(config);
  if (problem) {
    log?.error({ problem }, 'regclient node API is not configured');
    return { ok: false, status: 503, body: { message: `b2bua node API not available: ${problem}` } };
  }

  const claimed = String(registration.b2buaId || '').trim();
  const node = allowUnclaimed
    ? selectProbeNode({ registrationId: identifier, claimedNode: claimed, env })
    : claimed;

  if (!node) {
    return {
      ok: false,
      status: 409,
      body: {
        message: allowUnclaimed
          ? 'Registration is not claimed by a b2bua node and no probe node pool is configured'
          : 'Registration has not been claimed by a b2bua node, so no trace exists yet'
      }
    };
  }

  const allowed = assertNodeAddressAllowed(node, config);
  if (!allowed.ok) {
    log?.warn({ node, reason: allowed.reason }, 'refusing to contact b2bua node address');
    return {
      ok: false,
      status: 502,
      body: { message: `Refusing to contact b2bua node: ${allowed.reason}` }
    };
  }

  return { ok: true, registration, node, config, claimed: !!claimed };
}
