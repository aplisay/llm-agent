import { resolveRegistrationNode } from '../../../../../lib/regclient-facade.js';
import {
  buildProbeUrl,
  nodeRequest,
  describeNodeFailure,
  capabilityFromFailure,
  unsupportedNodeBody,
  CAPABILITY_NONE
} from '../../../../../lib/regclient.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: getRegistrationProbe
  };
};

/**
 * The final report for one probe: verdict, transcript, diagnosis and — in
 * discovery mode — the minimal `options` patch that made the registration work.
 */
const getRegistrationProbe = async (req, res) => {
  const { organisationId } = res.locals.user || {};
  const { identifier, probeId } = req.params;

  try {
    const resolved = await resolveRegistrationNode({
      identifier,
      organisationId,
      allowUnclaimed: true,
      log: req.log
    });
    if (!resolved.ok) return res.status(resolved.status).send(resolved.body);
    const { node, config } = resolved;

    let response;
    try {
      response = await nodeRequest({ url: buildProbeUrl({ node, probeId }, config), config, node });
    }
    catch (err) {
      if (capabilityFromFailure(err) === CAPABILITY_NONE) {
        req.log?.info({ node }, 'b2bua node does not provide the probe API');
        return res.status(501).send(unsupportedNodeBody(node));
      }
      req.log?.warn({ err: err.message, node }, 'b2bua node probe fetch failed');
      return res.status(504).send({ ...describeNodeFailure(err, node), error: 'probe unavailable' });
    }

    if (response.status === 404) {
      return res.status(404).send({ message: 'Probe not found on the b2bua node', node });
    }
    if (response.status >= 400) {
      return res.status(502).send({
        error: 'probe unavailable',
        node,
        reason: `node returned ${response.status}`
      });
    }

    return res.status(200).send({ ...response.data, node, fetchedAt: new Date().toISOString() });
  }
  catch (err) {
    req.log?.error(err, 'fetching registration probe');
    return res.status(500).send({ message: 'Internal server error' });
  }
};

getRegistrationProbe.apiDoc = {
  summary: 'Fetch the report for a registration probe',
  description: `Returns the current state of a probe started with
                \`POST /phone-endpoints/{identifier}/probe\`: the verdict once it has finished, the SIP
                transcript of each branch it tried, a diagnosis in plain language, and — for discovery
                probes — the suggested \`options\` patch. Probes are held in memory on the node that ran
                them and expire; a probe from an earlier node restart returns 404.`,
  operationId: 'getPhoneEndpointProbe',
  tags: ['Phone Endpoints'],
  parameters: [
    { name: 'identifier', in: 'path', required: true, schema: { type: 'string' }, description: 'Registration endpoint ID' },
    { name: 'probeId', in: 'path', required: true, schema: { type: 'string' }, description: 'Probe identifier returned when the probe was started' }
  ],
  responses: {
    200: {
      description: 'Probe report',
      content: { 'application/json': { schema: { $ref: '#/components/schemas/RegistrationProbeReport' } } }
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
    409: { description: 'No b2bua node is available', content: { 'application/json': { schema: { $ref: '#/components/schemas/Conflict' } } } },
    501: { description: 'The node holding this registration does not provide this API (it runs the FreeSWITCH stack)', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeCapabilityUnavailable' } } } },
    502: { description: 'The node answered with an error', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    503: { description: 'Node proxying is not configured in this deployment', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    504: { description: 'The node did not answer in time', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};
