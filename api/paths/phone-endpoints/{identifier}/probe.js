import { requirePermission } from '../../../../lib/auth/permissions.js';
import {
  resolveRegistrationNode,
  passThroughNodeStatus,
  nodeDialAddress
} from '../../../../lib/regclient-facade.js';
import { signProbeHandle } from '../../../../lib/regclient-probe-handle.js';
import {
  buildProbeUrl,
  nodeRequest,
  describeNodeFailure,
  capabilityFromFailure,
  unsupportedNodeBody,
  CAPABILITY_NONE
} from '../../../../lib/regclient.js';

let log;

export default function (logger) {
  log = logger;
  return {
    POST: startRegistrationProbe
  };
};

/**
 * Start a live registration probe on the node that owns this registration.
 *
 * A probe performs a real REGISTER attempt and reports what happened as it
 * happens — transport connect, challenge, auth retry, final response — instead
 * of leaving the operator to infer failure from a database row changing minutes
 * later. In `discover` mode the node walks a small matrix of transports and
 * next-hop choices and returns the minimal `options` patch that works, which is
 * what turns onboarding a quirky PBX into one API call.
 *
 * Probing is deliberately constrained here: only registrations the caller's
 * organisation owns, never a free-form credential candidate, so this API cannot
 * be used as a credential-testing oracle against arbitrary registrars.
 */
const startRegistrationProbe = async (req, res) => {
  // A probe is a write, not a read. It puts a real REGISTER on the wire from an
  // address the customer's PBX trusts, it exercises their stored credential,
  // and with `apply` it modifies the registration's options. phoneEndpoint.update
  // is the permission that already governs changing an endpoint, and this
  // changes one.
  if (!requirePermission(res, 'phoneEndpoint', 'update')) return;

  const user = res.locals.user;
  const { identifier } = req.params;
  const { discover = false, apply = false } = req.body || {};

  try {
    const resolved = await resolveRegistrationNode({
      identifier,
      user,
      allowUnclaimed: true,
      log: req.log
    });
    if (!resolved.ok) return res.status(resolved.status).send(resolved.body);
    const { node, config } = resolved;

    const address = await nodeDialAddress(node, config, { log: req.log });
    const url = buildProbeUrl({ node: address }, config);
    let response;
    try {
      response = await nodeRequest({
        url,
        method: 'POST',
        data: { registrationId: identifier, discover: !!discover, apply: !!apply },
        config,
        node
      });
    }
    catch (err) {
      if (capabilityFromFailure(err) === CAPABILITY_NONE) {
        req.log?.info({ node }, 'b2bua node does not provide the probe API');
        return res.status(501).send(unsupportedNodeBody(node));
      }
      req.log?.warn({ err: err.message, node }, 'b2bua node probe start failed');
      return res.status(504).send({ ...describeNodeFailure(err, node), error: 'probe unavailable' });
    }

    if (response.status >= 400) {
      req.log?.warn({ node, status: response.status }, 'b2bua node rejected probe request');
      // 409 (discovery against a live registration), 429 (+Retry-After), 501
      // (probing disabled here) and the caller's own 400/404 are answers, not
      // failures — they go back as they came.
      if (passThroughNodeStatus(res, response, node)) return;
      return res.status(502).send({
        error: 'probe unavailable',
        node,
        reason: `node returned ${response.status}`,
        ...(response.data && typeof response.data === 'object' ? { detail: response.data } : {})
      });
    }

    // The id handed back names the node this probe is running on and the
    // registration it is for, signed. A bare node-local id would send every
    // follow-up to whichever node holds the registration *at that moment* —
    // wrong the instant somebody migrates the row, which is exactly what an
    // operator watching a probe is likely to be doing — and it would let a
    // caller pair their own registration in the path with somebody else's
    // probe id in the URL. See lib/regclient-probe-handle.js.
    const handle = signProbeHandle(
      { node, registrationId: identifier, probeId: response.data?.probeId },
      config
    );
    if (!handle) {
      req.log?.error({ node }, 'could not sign a probe handle; refusing to return an unbound probe id');
      return res.status(500).send({ message: 'Internal server error' });
    }

    return res.status(202).send({ ...response.data, probeId: handle, node });
  }
  catch (err) {
    req.log?.error(err, 'starting registration probe');
    return res.status(500).send({ message: 'Internal server error' });
  }
};

startRegistrationProbe.apiDoc = {
  summary: 'Start a live SIP registration probe',
  description: `Runs a real registration attempt against this endpoint's registrar from the b2bua node
                that owns it, and returns a probe identifier. Progress can be streamed from
                \`GET /phone-endpoints/{identifier}/probe/{probeId}/events\` and the final verdict read
                from \`GET /phone-endpoints/{identifier}/probe/{probeId}\`.

                With \`discover: true\` the node tries a small matrix of transports and next-hop
                choices rather than a single attempt, and reports the minimal set of \`options\` that
                works. With \`apply: true\` that patch is merged into the endpoint's options and the
                registration is restarted — note that a later full update of \`options\` replaces them
                wholesale, so a re-probe may be needed after one.

                Probing a registration that is currently registered degrades to a harmless forced
                refresh of its existing binding; the node will not create a second contact binding at
                the registrar.`,
  operationId: 'startPhoneEndpointProbe',
  tags: ['Phone Endpoints'],
  parameters: [
    {
      name: 'identifier',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Registration endpoint ID (registrations only; not a phone number)'
    }
  ],
  requestBody: {
    required: false,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/RegistrationProbeRequest' }
      }
    }
  },
  responses: {
    202: {
      description: 'Probe accepted and running',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RegistrationProbeAccepted' } } }
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
    409: { description: 'No b2bua node is available to run the probe, or discovery was requested against a currently-registered endpoint (disable it first)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Conflict' } } } },
    429: { description: 'The node is already running its maximum number of concurrent probes. Retry after the interval given in the Retry-After header.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    501: { description: 'The node holding this registration does not provide this API (it runs the FreeSWITCH stack)', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeCapabilityUnavailable' } } } },
    502: { description: 'The node answered with an error, or is not an address we will contact', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    503: { description: 'Node proxying is not configured in this deployment', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    504: { description: 'The node did not answer in time', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};
