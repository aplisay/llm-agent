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

import { PhoneRegistration, B2buaNode } from './database.js';
import {
  loadRegclientConfig,
  configurationProblem,
  assertNodeAddressAllowed,
  selectProbeNode,
  nodeCapability,
  rememberNodeCapability,
  unsupportedNodeBody,
  CAPABILITY_TRACE,
  CAPABILITY_NONE,
  CAPABILITY_UNKNOWN
} from './regclient.js';

/**
 * How long a node's heartbeat is treated as current.
 *
 * Nodes heartbeat about once a minute, so three minutes is three missed beats.
 * Past that the row is treated as saying nothing rather than as still true —
 * and, importantly, a stale row is NOT read as "this node has no trace API".
 * A regclient node whose heartbeat has broken is still a regclient node, and
 * refusing its traces because we stopped hearing from it would be exactly
 * backwards: that is when somebody most wants to look.
 */
const HEARTBEAT_FRESH_MS = 3 * 60 * 1000;

/**
 * What the node last told us about itself.
 *
 * This is the difference between knowing and finding out. A node that has
 * heartbeated is classified before the first request is sent; only one that
 * never has falls through to discovery.
 */
export async function capabilityFromHeartbeat(node, { now = Date.now, model = B2buaNode } = {}) {
  try {
    const record = await model.findByPk(node);
    if (!record?.lastSeenAt) return CAPABILITY_UNKNOWN;
    if (now() - new Date(record.lastSeenAt).getTime() > HEARTBEAT_FRESH_MS) return CAPABILITY_UNKNOWN;
    return record.type === 'regclient' ? CAPABILITY_TRACE : CAPABILITY_NONE;
  }
  catch (err) {
    // The registry is an optimisation, not a dependency. If it cannot be read,
    // fall through to discovery rather than failing a request over it.
    return CAPABILITY_UNKNOWN;
  }
}

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

  // What this node is, in increasing order of cost: what this process already
  // learned, then what the node itself last told us, then — only for a node
  // that has never heartbeated — finding out by asking.
  //
  // During the migration both stacks run against the same table, so a
  // registration held by a FreeSWITCH node is an ordinary state of affairs
  // rather than a fault, and one worth answering in microseconds.
  let capability = nodeCapability(node, { env });
  if (capability === CAPABILITY_UNKNOWN) {
    capability = await capabilityFromHeartbeat(node);
    // Cache what the heartbeat said, so the rest of this replica's requests
    // skip even the database read.
    rememberNodeCapability(node, capability);
  }
  if (capability === CAPABILITY_NONE) {
    return { ok: false, status: 501, body: unsupportedNodeBody(node) };
  }

  return { ok: true, registration, node, config, claimed: !!claimed };
}
