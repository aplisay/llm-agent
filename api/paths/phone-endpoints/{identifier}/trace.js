import { resolveRegistrationNode } from '../../../../lib/regclient-facade.js';
import {
  TRACE_INDEX_FORMATS,
  buildTraceUrl,
  nodeRequest,
  describeNodeFailure
} from '../../../../lib/regclient.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: getRegistrationTrace
  };
};

/**
 * Index of the SIP exchanges captured for one registration.
 *
 * The b2bua keeps a bounded ring buffer of the SIP conversation per
 * registration — REGISTER transactions (the most recent successful and the most
 * recent failed one are pinned so a retry storm cannot evict the pair you want
 * to compare), recent call dialogs, and keepalive counters. Nothing is stored
 * centrally, so this route is a thin, strictly time-bounded proxy to the one
 * node that owns the registration.
 *
 * This route lists what the buffer holds — one line per exchange, with its
 * outcome, timing and size — rather than returning all of it. A full trace runs
 * to tens of kilobytes of SIP text, which is the wrong thing to re-download
 * every time a listing renders. Fetch one exchange in full from
 * `/phone-endpoints/{identifier}/trace/{transactionId}` using the ids returned
 * here.
 */
const getRegistrationTrace = async (req, res) => {
  const { organisationId } = res.locals.user || {};
  const { identifier } = req.params;
  const { format = 'json', since } = req.query;

  try {
    if (!TRACE_INDEX_FORMATS.includes(format)) {
      return res.status(400).send({
        message: `format must be one of: ${TRACE_INDEX_FORMATS.join(', ')}. ` +
          'Use /trace/{transactionId} for the decoded packets of a single exchange.'
      });
    }

    const resolved = await resolveRegistrationNode({ identifier, organisationId, log: req.log });
    if (!resolved.ok) return res.status(resolved.status).send(resolved.body);
    const { node, config } = resolved;

    const url = buildTraceUrl({ node, registrationId: identifier, format, since }, config);
    const wantsBinary = format === 'pcap';

    let response;
    try {
      response = await nodeRequest({
        url,
        responseType: wantsBinary ? 'arraybuffer' : 'json',
        config
      });
    }
    catch (err) {
      req.log?.warn({ err: err.message, node }, 'b2bua node trace fetch failed');
      return res.status(504).send(describeNodeFailure(err, node));
    }

    if (response.status === 404) {
      return res.status(404).send({ message: 'No trace held for this registration on its node', node });
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
      res.setHeader('Content-Disposition', `attachment; filename="${identifier}.pcap"`);
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
    req.log?.error(err, 'fetching registration trace');
    return res.status(500).send({ message: 'Internal server error' });
  }
};

getRegistrationTrace.apiDoc = {
  summary: 'List the SIP exchanges captured for a phone registration',
  description: `Lists what the b2bua node holding this registration has captured: recent REGISTER
                transactions (the most recent successful and most recent failed one are always
                retained), recent call dialogs, and keepalive counters. Each entry carries an
                \`id\`, its outcome, when it happened and how many messages it holds — but not the
                messages themselves, which would be tens of kilobytes of SIP text on every listing.

                Fetch one exchange in full from
                \`GET /phone-endpoints/{identifier}/trace/{transactionId}\`, which additionally
                offers \`format=decode\` for parsed packets.

                \`format=pcap\` is available here and returns a capture of the **whole**
                registration for Wireshark or sngrep — TLS legs included, exported decrypted, which
                an on-wire capture can never show.

                Traces live in a bounded in-memory buffer on the node, so they cover recent activity
                rather than full history, and are lost if that node restarts. What has been
                discarded is reported in \`evictions\`, so a gap is never silent. Digest credentials
                are always redacted at this API. The request is proxied to the owning node with a
                hard timeout and no retries: if that node is unreachable the response is 504.`,
  operationId: 'getPhoneEndpointTrace',
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
      name: 'format',
      in: 'query',
      required: false,
      schema: { type: 'string', enum: ['json', 'pcap'], default: 'json' },
      description: 'json (default) lists the captured exchanges; pcap exports the whole registration as a capture file'
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
      description: 'Index of captured SIP exchanges, or a whole-registration capture file',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/SipTraceIndex' }
        },
        'application/vnd.tcpdump.pcap': {
          schema: { type: 'string', format: 'binary' }
        }
      }
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    403: { description: 'Forbidden', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
    409: { description: 'Registration is not claimed by any b2bua node', content: { 'application/json': { schema: { $ref: '#/components/schemas/Conflict' } } } },
    502: { description: 'The owning node answered with an error, or is not an address we will contact', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    503: { description: 'Node proxying is not configured in this deployment', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    504: { description: 'The owning node did not answer in time', content: { 'application/json': { schema: { $ref: '#/components/schemas/NodeUnavailable' } } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};
