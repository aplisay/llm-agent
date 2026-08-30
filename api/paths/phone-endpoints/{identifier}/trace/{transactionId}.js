import { requirePermission } from '../../../../../lib/auth/permissions.js';
import { resolveRegistrationNode } from '../../../../../lib/regclient-facade.js';
import {
  TRACE_FORMATS,
  buildTraceUrl,
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
    GET: getRegistrationTraceTransaction
  };
};

/**
 * One captured SIP exchange, in full.
 *
 * The index route says what a registration's trace holds; this returns a single
 * entry from it — a REGISTER ladder or a call dialog — with every message. That
 * split is why a dashboard listing stays cheap: the messages are only fetched
 * for the exchange somebody actually opened.
 */
const getRegistrationTraceTransaction = async (req, res) => {
  // Same gate as the index this transaction id came from: one exchange in full
  // is strictly more than the line describing it.
  if (!requirePermission(res, 'phoneEndpoint', 'read')) return;

  const { organisationId } = res.locals.user || {};
  const { identifier, transactionId } = req.params;
  const { format = 'json', since } = req.query;

  try {
    if (!TRACE_FORMATS.includes(format)) {
      return res.status(400).send({ message: `format must be one of: ${TRACE_FORMATS.join(', ')}` });
    }

    const resolved = await resolveRegistrationNode({ identifier, organisationId, log: req.log });
    if (!resolved.ok) return res.status(resolved.status).send(resolved.body);
    const { node, config } = resolved;

    const url = buildTraceUrl({ node, registrationId: identifier, transactionId, format, since }, config);
    const wantsBinary = format === 'pcap';

    let response;
    try {
      response = await nodeRequest({
        url,
        responseType: wantsBinary ? 'arraybuffer' : 'json',
        config,
        node
      });
    }
    catch (err) {
      // A refused or unreachable connection is a statement about the node, not
      // an outage: it is running the FreeSWITCH stack, which has no such API.
      // nodeRequest has already cached that, so the next call answers at once.
      if (capabilityFromFailure(err) === CAPABILITY_NONE) {
        req.log?.info({ node }, 'b2bua node does not provide the trace API');
        return res.status(501).send(unsupportedNodeBody(node));
      }
      req.log?.warn({ err: err.message, node }, 'b2bua node trace fetch failed');
      return res.status(504).send(describeNodeFailure(err, node));
    }

    if (response.status === 404) {
      // Traces rotate: a transaction listed a few minutes ago may have aged out
      // behind a burst of retries. Say that, rather than implying the
      // registration itself is unknown.
      return res.status(404).send({
        message: 'That exchange is no longer in this registration\'s trace buffer; it may have rotated out',
        node
      });
    }
    if (response.status >= 400) {
      req.log?.warn({ node, status: response.status }, 'b2bua node rejected trace request');
      return res.status(502).send({
        error: 'trace unavailable',
        node,
        reason: `node returned ${response.status}`
      });
    }

    const fetchedAt = new Date().toISOString();
    res.setHeader('X-Regclient-Node', node);
    res.setHeader('X-Regclient-Fetched-At', fetchedAt);

    if (wantsBinary) {
      res.setHeader('Content-Type', 'application/vnd.tcpdump.pcap');
      res.setHeader('Content-Disposition', `attachment; filename="${identifier}-${transactionId}.pcap"`);
      return res.status(200).send(Buffer.from(response.data));
    }

    // `decode` answers with an array and `json` with an object; keep both
    // shapes intact — the provenance rides in the headers either way.
    if (Array.isArray(response.data)) {
      return res.status(200).send(response.data);
    }
    return res.status(200).send({ ...response.data, node, fetchedAt });
  }
  catch (err) {
    req.log?.error(err, 'fetching a registration trace transaction');
    return res.status(500).send({ message: 'Internal server error' });
  }
};

getRegistrationTraceTransaction.apiDoc = {
  summary: 'Fetch one captured SIP exchange in full',
  description: `Returns a single entry from a registration's trace — one REGISTER transaction or one
                call dialog — with every message it holds. Use
                \`GET /phone-endpoints/{identifier}/trace\` to list the entries and their ids.

                Three representations are available via \`format\`:
                  * \`json\` (default) — the transcript: each message with its envelope and raw text.
                  * \`decode\` — a flat, chronological array of parsed packets with headers, CSeq and
                    SDP broken out. Header order and duplicates are preserved, so Via chains and
                    route sets survive the decode.
                  * \`pcap\` — this exchange as a capture file for Wireshark or sngrep.

                Digest credentials are always redacted. Trace entries rotate as new activity
                arrives, so an id listed a few minutes ago may since have aged out; that is a 404.`,
  operationId: 'getPhoneEndpointTraceTransaction',
  tags: ['Phone Endpoints'],
  parameters: [
    {
      name: 'identifier',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Registration endpoint ID (registrations only; not a phone number)'
    },
    {
      name: 'transactionId',
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: 'Identifier of the exchange, from the trace index'
    },
    {
      name: 'format',
      in: 'query',
      required: false,
      schema: { type: 'string', enum: ['json', 'decode', 'pcap'], default: 'json' },
      description: 'Representation to return'
    },
    {
      name: 'since',
      in: 'query',
      required: false,
      schema: { type: 'string', format: 'date-time' },
      description: 'Only return messages captured at or after this time'
    }
  ],
  responses: {
    200: {
      description: 'The exchange in the requested representation',
      content: {
        'application/json': {
          schema: {
            oneOf: [
              { $ref: '#/components/schemas/SipTrace' },
              { type: 'array', items: { $ref: '#/components/schemas/SipTracePacket' } }
            ]
          }
        },
        'application/vnd.tcpdump.pcap': {
          schema: { type: 'string', format: 'binary' }
        }
      }
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    404: { description: 'No such registration, or that exchange has rotated out of the buffer', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
    409: { description: 'Registration is not claimed by any b2bua node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Conflict' } } } },
    501: { description: 'The node holding this registration does not provide this API (it runs the FreeSWITCH stack)', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeCapabilityUnavailable' } } } },
    502: { description: 'The owning node answered with an error, or is not an address we will contact', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    503: { description: 'Node proxying is not configured in this deployment', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    504: { description: 'The owning node did not answer in time', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};
