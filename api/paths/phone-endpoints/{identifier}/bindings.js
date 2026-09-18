import { PhoneRegistration } from '../../../../lib/database.js';
import { userOwnsRow } from '../../../../lib/scope.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';
import { isRegistrarAccount } from '../../../../lib/registrar-accounts.js';
import { resolveRegistrationNode, nodeDialAddress } from '../../../../lib/regclient-facade.js';
import {
  buildBindingsUrl,
  nodeRequest,
  describeNodeFailure,
  capabilityFromFailure,
  unsupportedNodeBody,
  boolEnv,
  CAPABILITY_NONE
} from '../../../../lib/regclient.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: getBindings
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who is registered to a registrar account, from where, and until when.
 *
 * Two sources for one answer. The default is the mirror: the array the owning
 * regserver node last wrote onto the row, which costs nothing to read and is
 * what a listing or a drawer should show. `live=1` asks the owning node itself
 * through the node API, the same way a trace is fetched, for the moment
 * somebody is asking "is it really registered right now" — at the cost of a
 * round trip to that node and a 504 if it is not answering.
 */
const getBindings = async (req, res) => {
  if (!requirePermission(res, 'phoneEndpoint', 'read')) return;
  const { identifier } = req.params;
  const live = boolEnv(req.query?.live, false);

  try {
    if (!identifier || identifier.match(/^\+?[0-9]+$/)) {
      return res.status(400).send({ error: 'Identifier must be a registration ID, not a phone number' });
    }
    if (!UUID.test(identifier)) {
      return res.status(404).send({ error: 'Phone endpoint not found' });
    }
    const registration = await PhoneRegistration.findByPk(identifier);
    if (!registration) {
      return res.status(404).send({ error: 'Phone endpoint not found' });
    }
    if (!userOwnsRow(res.locals.user, registration)) {
      return res.status(403).send({ error: 'Access denied' });
    }
    if (!isRegistrarAccount(registration)) {
      return res.status(404).send({
        error: 'This registration is a client-mode line; bindings exist only for registrar accounts',
        code: 'not_registrar_account'
      });
    }

    if (!live) {
      return res.send({
        registrationId: registration.id,
        node: registration.b2buaId || null,
        live: false,
        bindings: Array.isArray(registration.bindings) ? registration.bindings : [],
        bindingsUpdatedAt: registration.bindingsUpdatedAt ? new Date(registration.bindingsUpdatedAt).toISOString() : null,
        fetchedAt: null
      });
    }

    const resolved = await resolveRegistrationNode({ identifier, user: res.locals.user, log: req.log });
    if (!resolved.ok) return res.status(resolved.status).send(resolved.body);
    const { node, config } = resolved;

    const address = await nodeDialAddress(node, config, { log: req.log });
    const url = buildBindingsUrl({ node: address, registrationId: identifier }, config);

    let response;
    try {
      response = await nodeRequest({ url, responseType: 'json', config, node });
    }
    catch (err) {
      if (capabilityFromFailure(err) === CAPABILITY_NONE) {
        return res.status(501).send(unsupportedNodeBody(node));
      }
      req.log?.warn({ err: err.message, node }, 'b2bua node bindings fetch failed');
      return res.status(504).send(describeNodeFailure(err, node));
    }

    if (response.status === 404) {
      // The node named on the row does not hold this account: it has moved,
      // or that node restarted and the PBX has not come back yet. The mirror
      // says what was last known; the caller asked for now.
      return res.status(404).send({ message: 'The owning node holds no bindings for this account', node });
    }
    if (response.status >= 400) {
      req.log?.warn({ node, status: response.status }, 'b2bua node rejected bindings request');
      return res.status(502).send({ error: 'bindings unavailable', node, reason: `node returned ${response.status}` });
    }

    const fetchedAt = new Date().toISOString();
    res.setHeader('X-Regclient-Node', node);
    res.setHeader('X-Regclient-Fetched-At', fetchedAt);
    const data = response.data && typeof response.data === 'object' ? response.data : {};
    return res.send({
      registrationId: registration.id,
      node,
      live: true,
      bindings: Array.isArray(data.bindings) ? data.bindings : [],
      bindingsUpdatedAt: registration.bindingsUpdatedAt ? new Date(registration.bindingsUpdatedAt).toISOString() : null,
      fetchedAt
    });
  }
  catch (err) {
    req.log?.error(err, 'fetching registrar account bindings');
    return res.status(500).send({ error: 'Internal server error' });
  }
};

getBindings.apiDoc = {
  summary: 'The bindings held for a registrar account',
  description: `Who is registered to this account, from where, and until when. By default the mirror
                the owning node last wrote onto the row, which is what the Connections table shows.
                With \`live=1\` the owning node is asked directly through the node API, exactly as a
                trace is fetched: 409 when nothing has registered yet, 404 when the named node no
                longer holds the account, 504 when it does not answer in time.`,
  operationId: 'getRegistrarAccountBindings',
  tags: ['Phone Endpoints'],
  parameters: [
    { name: 'identifier', in: 'path', required: true, schema: { type: 'string' }, description: 'Registration endpoint ID (registrar accounts only)' },
    { name: 'live', in: 'query', required: false, schema: { type: 'boolean', default: false }, description: 'Ask the owning node rather than reading the mirror on the row' }
  ],
  responses: {
    200: {
      description: 'The bindings',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RegistrationBindings' } } }
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    404: { description: 'Not found, not a registrar account, or (live) the owning node holds no bindings', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    409: { description: 'Live view requested but no node has accepted a REGISTER for this account yet', content: { 'application/json': { schema: { $ref: '#/components/schemas/Conflict' } } } },
    501: { description: 'The owning node does not provide the node API', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeCapabilityUnavailable' } } } },
    502: { description: 'The owning node answered with an error, or is not an address we will contact', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    503: { description: 'Node proxying is not configured in this deployment', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    504: { description: 'The owning node did not answer in time', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};
