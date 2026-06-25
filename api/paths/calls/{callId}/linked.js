import { Call, Agent, Op } from '../../../../lib/database.js';
import { scopeWhereForUser } from '../../../../lib/scope.js';
import { requirePermission } from '../../../../lib/auth/permissions.js';

// Safety caps: a single call's transfer chain is small in practice.
const MAX_LINKED = 50;   // total legs returned
const MAX_DEPTH = 25;    // parent walk-up hops

let log;

/**
 * GET /calls/{callId}/linked — the whole call tree this leg belongs to.
 *
 * A call can span several legs: a `transfer_agent` handover continues the call
 * as a NEW Call row whose `parentId` is the call it took over from (see
 * voice-agent-runtime.restartWithAgent / transfer-handler), so the legs form a
 * tree linked by parentId. Given ANY leg, this resolves the root (walk up
 * parentId) and returns the root plus all descendants (walk down), each tagged
 * with its agent's name/label — so the AI editor (and historical-call analysis)
 * can see every agent the call passed through.
 *
 * parentId is a durable Call→Call link: unlike `instanceId` (SET NULL when the
 * listener is torn down) it survives, so this works for historical calls long
 * after the listener is gone — and resolves the same tree from any leg.
 */
export default function (logger) {
  log = logger;

  const linkedCalls = async (req, res) => {
    if (!requirePermission(res, 'call', 'read')) return;
    try {
      const { callId } = req.params;
      const { limit } = req.query;
      const cap = Math.min(parseInt(limit, 10) || MAX_LINKED, MAX_LINKED);
      const scope = scopeWhereForUser(res.locals.user);

      // 1. Resolve the root by walking up parentId (minimal columns — navigation
      //    only). Cycle- and depth-guarded.
      const nav = await Call.findOne({ where: { id: callId, ...scope }, attributes: ['id', 'parentId'] });
      if (!nav) {
        return res.status(404).send({ error: `Call ${callId} not found` });
      }
      let root = nav;
      const seenUp = new Set([root.id]);
      for (let i = 0; root.parentId && i < MAX_DEPTH; i += 1) {
        if (seenUp.has(root.parentId)) break;                       // cycle guard
        // eslint-disable-next-line no-await-in-loop
        const parent = await Call.findOne({ where: { id: root.parentId, ...scope }, attributes: ['id', 'parentId'] });
        if (!parent) break;                                         // parent gone / out of scope
        seenUp.add(parent.id);
        root = parent;
      }

      // 2. Collect root + all descendants (BFS down via parentId), bounded.
      const attributes = ['id', 'parentId', 'instanceId', 'agentId', 'modelName',
        'callerId', 'calledId', 'startedAt', 'endedAt', 'status'];
      const include = [{ model: Agent, attributes: ['id', 'name', 'label'], required: false }];
      const collected = new Map();
      let frontier = [root.id];
      while (frontier.length && collected.size < cap) {
        // eslint-disable-next-line no-await-in-loop
        const rows = await Call.findAll({ where: { id: { [Op.in]: frontier }, ...scope }, attributes, include });
        for (const c of rows) collected.set(c.id, c);
        // eslint-disable-next-line no-await-in-loop
        const children = await Call.findAll({
          where: { parentId: { [Op.in]: frontier }, ...scope },
          attributes: ['id'],
        });
        frontier = children.map((c) => c.id).filter((id) => !collected.has(id));
      }

      res.send({
        calls: [...collected.values()].map((c) => ({
          id: c.id,
          parentId: c.parentId,
          instanceId: c.instanceId,
          agentId: c.agentId,
          agentName: c.Agent?.name ?? null,
          agentLabel: c.Agent?.label ?? null,
          modelName: c.modelName,
          callerId: c.callerId,
          calledId: c.calledId,
          startedAt: c.startedAt,
          endedAt: c.endedAt,
          status: c.status,
        })),
      });
    } catch (error) {
      req.log.error(error);
      res.status(500).send({ error: error.message });
    }
  };

  linkedCalls.apiDoc = {
    summary: 'List the whole call tree (transfer chain) a call belongs to',
    description: 'Given any call leg, resolves the root of its transfer tree (walking up `parentId`) and returns '
      + 'the root plus all descendant legs, each tagged with its agent\'s name/label. Linked by `parentId`, so it '
      + 'is durable for historical calls (unlike an instance-scoped lookup). Used by the AI set editor to diagnose '
      + 'a test across all agents the call passed through.',
    operationId: 'linkedCallsList',
    tags: ['Calls'],
    parameters: [
      {
        in: 'path',
        name: 'callId',
        required: true,
        description: 'Any leg of the call tree (root or a transferred-to leg).',
        schema: { type: 'string' },
      },
      {
        in: 'query',
        name: 'limit',
        required: false,
        description: `Maximum number of legs to return (default ${MAX_LINKED}).`,
        schema: { type: 'number', default: MAX_LINKED },
      },
    ],
    responses: {
      200: {
        description: 'All legs of the call tree.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                calls: { type: 'array', items: { $ref: '#/components/schemas/Call' } },
              },
            },
          },
        },
      },
      404: {
        description: 'Call not found',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } },
      },
      default: {
        description: 'An error occurred',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  };

  return { GET: linkedCalls };
}
