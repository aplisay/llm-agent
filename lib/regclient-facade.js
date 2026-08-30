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
import { userOwnsRow } from './scope.js';
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
  user,
  allowUnclaimed = false,
  env = process.env,
  log
}) {
  const owned = await resolveRegistrationForHandle({ identifier, user, env, log });
  if (!owned.ok) return owned;
  const { registration, config } = owned;

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

/**
 * Who is asking, and how this deployment talks to nodes — with no node chosen.
 *
 * The probe report and event streams are addressed by a signed handle that
 * already names the node the probe is running on. Selecting a node here as well
 * would answer 409 for a row that has since been unclaimed, or 501 for one that
 * has since moved to a FreeSWITCH node, about a probe still running perfectly
 * well on the node the handle names — and rolling a registration back while
 * watching its probe is precisely what an operator does (§9 rollback). The
 * handle exists to survive that, so those routes check ownership and
 * configuration here and let the handle pick the node.
 *
 * Ownership is still enforced, and the caller must still put the handle's node
 * through assertNodeAddressAllowed before contacting it.
 */
export async function resolveRegistrationForHandle({
  identifier,
  user,
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
  // userOwnsRow, not a bare `!==`. Both sides of an organisation comparison can
  // legitimately be null — an org-less principal, and a row orphaned by the
  // `SET NULL` on organisation delete (or created by an org-less user) — and
  // `null !== null` is false, so the direct comparison *granted* access across
  // two unrelated org-less tenants. That is the same leak the listing route
  // already carries a comment about (api/paths/phone-endpoints.js), and a SIP
  // trace is the registrar, the account identity and the credentials in flight.
  // scope.js is explicit that org-scoped rows must never be compared this way.
  if (!userOwnsRow(user, registration)) {
    return { ok: false, status: 403, body: { message: 'Access denied' } };
  }

  const config = loadRegclientConfig(env);
  const problem = configurationProblem(config);
  if (problem) {
    log?.error({ problem }, 'regclient node API is not configured');
    return { ok: false, status: 503, body: { message: `b2bua node API not available: ${problem}` } };
  }

  return { ok: true, registration, config };
}

/**
 * Check a node named by a verified handle before contacting it.
 *
 * The handle is integrity-protected, so the node in it is one we put there —
 * but it was signed at probe-start and the allow-list may have changed since,
 * so it goes through the same address gate as a freshly selected node.
 */
export function assertHandleNodeAllowed(node, config, log) {
  const allowed = assertNodeAddressAllowed(node, config);
  if (allowed.ok) return null;
  log?.warn({ node, reason: allowed.reason }, 'refusing to contact b2bua node address');
  return { status: 502, body: { message: `Refusing to contact b2bua node: ${allowed.reason}` } };
}

/**
 * Statuses from a node that mean something to the caller, and so have to reach
 * them rather than being flattened into 502.
 *
 * 502 says "the node is broken", and none of these are that. 409 is the
 * deliberate refusal to run discovery against a registration that is currently
 * live — the caller's fix is to disable it first, which they can only do if we
 * tell them. 429 is the probe rate limiter, and its `Retry-After` is the whole
 * of the advice. 501 is probing switched off on that node. 400 and 404 are the
 * caller's own request. Reporting any of these as "probe unavailable" sends
 * somebody to look at the node when the answer was in their hands.
 *
 * Returns true when it has answered, so callers read as a guard clause.
 */
const NODE_STATUS_PASSTHROUGH = new Set([400, 404, 409, 429, 501]);

export function passThroughNodeStatus(res, response, node) {
  if (!NODE_STATUS_PASSTHROUGH.has(response.status)) return false;

  if (response.status === 429) {
    const retryAfter = response.headers?.['retry-after'] ?? response.headers?.['Retry-After'];
    if (retryAfter != null) res.setHeader('Retry-After', String(retryAfter));
  }

  const body = (response.data && typeof response.data === 'object')
    ? { ...response.data, node }
    : { message: `The b2bua node returned ${response.status}`, node };
  res.status(response.status).send(body);
  return true;
}
