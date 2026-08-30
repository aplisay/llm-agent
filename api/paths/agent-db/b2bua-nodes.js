import { B2buaNode, B2BUA_NODE_TYPES } from '../../../lib/database.js';
import { rememberNodeCapability, CAPABILITY_TRACE, CAPABILITY_NONE } from '../../../lib/regclient.js';

let log;

export default function (logger) {
  log = logger;
  return {
    POST: heartbeat,
    GET: listNodes
  };
};

/**
 * A b2bua node announcing itself, once a minute.
 *
 * This is the node telling us what it is, rather than us finding out by asking
 * — which matters because the finding-out is only cheap when it succeeds. A
 * node running the FreeSWITCH stack has no HTTP surface at all, so discovering
 * that costs a connection attempt at best and a firewall timeout at worst,
 * repeated for every node until something caches it. A heartbeat makes it known
 * before the first trace request ever arrives.
 *
 * Internal, and restricted deliberately — an ordinary caller able to post here
 * could mark a node as the wrong stack, which would either deny traces that
 * exist or send requests at a node that cannot answer them.
 *
 * Two principals are accepted: the system user, and the narrowly-scoped
 * b2bua-node principal that B2BUA_HEARTBEAT_TOKEN mints. Nodes should carry the
 * scoped token: they are internet-facing SIP machines, and SHARED_API_TOKEN is
 * accepted on every route in the internal API. The scoped one reaches this
 * route and nothing else — not even the fleet listing below.
 */
const heartbeat = async (req, res) => {
  const caller = res.locals.user;
  if (caller?.isSystem !== true && caller?.isB2buaNode !== true) {
    return res.status(403).send({ message: 'b2bua node heartbeats are accepted only from internal callers' });
  }

  const { nodeId, type = 'regclient', version, registrations, failedRegistrations, systemLoad } = req.body || {};

  if (!nodeId || typeof nodeId !== 'string' || !nodeId.trim()) {
    return res.status(400).send({ message: 'nodeId is required' });
  }
  if (!B2BUA_NODE_TYPES.includes(type)) {
    return res.status(400).send({ message: `type must be one of: ${B2BUA_NODE_TYPES.join(', ')}` });
  }

  try {
    const now = new Date();
    const [record] = await B2buaNode.upsert({
      nodeId: nodeId.trim(),
      type,
      version: version ?? null,
      // A node that cannot count its own registrations should not be able to
      // zero the fleet view by accident.
      registrations: Number.isFinite(registrations) ? registrations : 0,
      failedRegistrations: Number.isFinite(failedRegistrations) ? failedRegistrations : 0,
      systemLoad: Number.isFinite(systemLoad) ? systemLoad : null,
      lastSeenAt: now
    }, { returning: true });

    // Prime the in-process capability cache from the same fact, so the very
    // next trace request on this replica skips even the database read.
    rememberNodeCapability(nodeId.trim(), type === 'regclient' ? CAPABILITY_TRACE : CAPABILITY_NONE);

    return res.status(200).send({
      nodeId: record?.nodeId ?? nodeId.trim(),
      acknowledgedAt: now.toISOString()
    });
  }
  catch (err) {
    req.log?.error(err, 'recording a b2bua node heartbeat');
    return res.status(500).send({ message: 'Internal server error' });
  }
};

/**
 * The fleet: which nodes are up, what they are running, and what they hold.
 *
 * Nothing had this view before — it was spread across whichever registrations
 * each node happened to have claimed, and a node holding none was
 * indistinguishable from a node that was not there.
 */
const listNodes = async (req, res) => {
  // A stricter gate than the heartbeat's, and deliberately so: this listing is
  // every node's public IP, stack, version, registration counts and load — a
  // map of the estate — so the scoped b2bua-node principal that may announce
  // itself above is refused here. `/api/agent-db` is already refused at the
  // prefix for anything without an internal token (middleware/auth.js); this is
  // the second lock.
  if (res.locals.user?.isSystem !== true) {
    return res.status(403).send({ message: 'the b2bua node listing is available only to internal callers' });
  }

  const staleAfterSeconds = Number(req.query.staleAfterSeconds ?? 180);

  try {
    const nodes = await B2buaNode.findAll({ order: [['nodeId', 'ASC']] });
    const now = Date.now();
    return res.send({
      nodes: nodes.map((node) => {
        const lastSeenAt = node.lastSeenAt ? new Date(node.lastSeenAt) : null;
        const ageSeconds = lastSeenAt ? Math.round((now - lastSeenAt.getTime()) / 1000) : null;
        return {
          nodeId: node.nodeId,
          type: node.type,
          version: node.version,
          registrations: node.registrations,
          failedRegistrations: node.failedRegistrations,
          systemLoad: node.systemLoad,
          lastSeenAt: lastSeenAt ? lastSeenAt.toISOString() : null,
          // A node that has stopped heartbeating is reported as stale rather
          // than quietly dropped: "this node has gone quiet" is the thing worth
          // seeing, and it is invisible if the row simply disappears.
          stale: ageSeconds === null || ageSeconds > staleAfterSeconds
        };
      })
    });
  }
  catch (err) {
    req.log?.error(err, 'listing b2bua nodes');
    return res.status(500).send({ message: 'Internal server error' });
  }
};

heartbeat.apiDoc = {
  summary: 'Record a b2bua node heartbeat (internal)',
  description: `Called by each b2bua node about once a minute to say what it is and what it is doing.
                Internal only: authenticated with the shared token.

                The immediate use is capability — \`phone_registrations.b2bua_id\` says which node
                holds a registration but not what that node is, and only regclient serves the trace
                and probe API. Knowing before the first request removes a discovery round-trip that
                is only cheap when it succeeds.`,
  operationId: 'recordB2buaNodeHeartbeat',
  tags: ['Agent DB'],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/B2buaNodeHeartbeat' }
      }
    }
  },
  responses: {
    200: {
      description: 'Heartbeat recorded',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              nodeId: { type: 'string' },
              acknowledgedAt: { type: 'string', format: 'date-time' }
            }
          }
        }
      }
    },
    400: { description: 'Bad request', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    403: { description: 'Not an internal caller', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};

listNodes.apiDoc = {
  summary: 'List known b2bua nodes (internal)',
  description: `The fleet as the nodes themselves last reported it: what each is running, how many
                registrations it holds, how many are failing, and its load. A node that has stopped
                heartbeating is marked \`stale\` rather than omitted.`,
  operationId: 'listB2buaNodes',
  tags: ['Agent DB'],
  parameters: [
    {
      name: 'staleAfterSeconds',
      in: 'query',
      required: false,
      schema: { type: 'integer', default: 180 },
      description: 'Age beyond which a node is reported stale (default three missed heartbeats)'
    }
  ],
  responses: {
    200: {
      description: 'Known b2bua nodes',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              nodes: {
                type: 'array',
                items: { $ref: '#/components/schemas/B2buaNode' }
              }
            }
          }
        }
      }
    },
    403: { description: 'Not an internal caller', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    500: { description: 'Internal server error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } }
  }
};
