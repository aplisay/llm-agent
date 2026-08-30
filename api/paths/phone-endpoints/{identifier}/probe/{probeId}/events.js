import { requirePermission } from '../../../../../../lib/auth/permissions.js';
import { resolveRegistrationNode } from '../../../../../../lib/regclient-facade.js';
import { verifyProbeHandle } from '../../../../../../lib/regclient-probe-handle.js';
import { buildProbeUrl, openNodeStream } from '../../../../../../lib/regclient.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: streamRegistrationProbe
  };
};

/**
 * Server-sent events for a running probe, piped straight from the node.
 *
 * The short node timeout applies to *establishing* the stream; once the node
 * has answered, the stream stays open until the probe finishes or the client
 * goes away, and either side closing tears down the other.
 */
const streamRegistrationProbe = async (req, res) => {
  // Reading a probe as it happens is the same read as reading its report.
  if (!requirePermission(res, 'phoneEndpoint', 'read')) return;

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
    const { config } = resolved;

    // As for the report: the handle pins the node and binds the probe to this
    // registration. See lib/regclient-probe-handle.js.
    const handle = verifyProbeHandle(probeId, { registrationId: identifier }, config);
    if (!handle.ok) {
      req.log?.info({ reason: handle.reason }, 'rejecting a probe id');
      return res.status(404).send({ message: 'Probe not found' });
    }
    const { node, probeId: nodeProbeId } = handle;

    let upstream;
    try {
      upstream = await openNodeStream({
        url: buildProbeUrl({ node, probeId: nodeProbeId, registrationId: identifier, events: true }, config),
        config
      });
    }
    catch (err) {
      req.log?.warn({ err: err.message, node }, 'b2bua node probe stream failed');
      return res.status(504).send({ error: 'probe unavailable', node, reason: err.message });
    }

    if (upstream.statusCode !== 200) {
      upstream.resume();
      return res
        .status(upstream.statusCode === 404 ? 404 : 502)
        .send({ error: 'probe unavailable', node, reason: `node returned ${upstream.statusCode}` });
    }

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Regclient-Node', node);
    res.flushHeaders?.();

    upstream.pipe(res);
    upstream.on('error', (err) => {
      req.log?.warn({ err: err.message, node }, 'probe event stream ended in error');
      res.end();
    });
    // A browser navigating away must not leave a socket open to the node.
    req.on('close', () => upstream.destroy());
  }
  catch (err) {
    req.log?.error(err, 'streaming registration probe');
    if (!res.headersSent) return res.status(500).send({ message: 'Internal server error' });
    res.end();
  }
};

streamRegistrationProbe.apiDoc = {
  summary: 'Stream live events from a registration probe',
  description: `A \`text/event-stream\` of everything the probe does as it happens: transport
                connection, each SIP message (with digest credentials redacted), timings, and the
                final verdict. The stream ends when the probe completes. Use
                \`GET /phone-endpoints/{identifier}/probe/{probeId}\` for the same information as a
                single document once it has finished.`,
  operationId: 'streamPhoneEndpointProbe',
  tags: ['Phone Endpoints'],
  parameters: [
    { name: 'identifier', in: 'path', required: true, schema: { type: 'string' }, description: 'Registration endpoint ID' },
    { name: 'probeId', in: 'path', required: true, schema: { type: 'string' }, description: 'Probe identifier returned when the probe was started' }
  ],
  responses: {
    200: {
      description: 'Server-sent event stream of probe progress',
      content: { 'text/event-stream': { schema: { type: 'string' } } }
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
    409: { description: 'No b2bua node is available', content: { 'application/json': { schema: { $ref: '#/components/schemas/Conflict' } } } },
    502: { description: 'The node answered with an error', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    503: { description: 'Node proxying is not configured in this deployment', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    504: { description: 'The node did not answer in time', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};
