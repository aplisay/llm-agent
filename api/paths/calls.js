import { Call, Op } from '../../lib/database.js';
import { Sequelize } from 'sequelize';
import { visibleCallsWhere } from '../../lib/call-visibility.js';
import { requirePermission } from '../../lib/auth/permissions.js';
import { callRedactionReady } from '../../lib/redacted-calls.js';
import { presentAttributes } from '../../lib/schema-guards.js';
let appParameters, log;

const REDACTED_WHERE = {
  exclude: { redactedAt: null },
  include: {},
  only: { redactedAt: { [Op.ne]: null } },
};

/**
 * Finalised cost of a call in micro-pounds (1e-6 GBP): the sum of its costed,
 * finalised usage records, as a correlated aggregate so list pages stay one
 * query. NULL when nothing has been costed yet — distinct from a zero-cost
 * call. float8 keeps the JSON value numeric (a bigint SUM would serialise as a
 * string).
 */
const COST_MICROS_LITERAL =
  '(SELECT SUM(ur.cost_micros)::float8 FROM usage_records ur WHERE ur.call_id = "Call"."id" AND ur.finalised AND ur.cost_micros IS NOT NULL)';


export default function (logger) {

  log = logger;

  const listAllCalls = (async (req, res) => {
    if (!requirePermission(res, 'call', 'read')) return;
    try {
      let { startDate, endDate, lastIndex = 0, limit = 50, redacted = 'exclude' } = req.query;
      if (!callRedactionReady() && redacted === 'only') return res.send({ calls: [], next: false });
      let where = {
        [Op.and]: [
          { index: { [Op.gt]: lastIndex } },
          await visibleCallsWhere(res.locals.user),
          callRedactionReady() ? REDACTED_WHERE[redacted] ?? REDACTED_WHERE.exclude : {},
        ]
      };
      startDate = startDate ? new Date(startDate) : new Date(0);
      endDate = endDate ? new Date(endDate) : new Date();
      if (startDate && endDate) {
        where.createdAt = {
          [Op.gte]: startDate,
          [Op.lte]: endDate
        };
      }
      let { count, rows: calls } = await Call.findAndCountAll({
        attributes: [
          ...presentAttributes(Call, ['id', 'index', 'agentId', 'parentId', 'modelName', 'callerId', 'calledId', 'startedAt', 'endedAt', 'status', 'recordingId', 'redactedAt']),
          [Sequelize.literal(COST_MICROS_LITERAL), 'costMicros'],
        ],
        where,
        order: [['index', 'ASC']],
        limit: parseInt(limit),
      });
      req.log.debug({ where, count, calls, limit, lastIndex });
      // Paginate using the last index returned in this page; if there are no more
      // rows beyond this page then `next` will be false.
      const next = (count > calls.length && calls.length)
        ? calls[calls.length - 1].index
        : false;
      res.send({ calls, next });
    } catch (error) {
      req.log.error(error);
      res.status(500).send({ error: error.message });
    }
  });

  listAllCalls.apiDoc = {
    summary: 'Returns list of all calls to agents owned by the user or organisation',
    description:
      'Returns a paginated list of calls across all agents in scope for the authenticated principal. '
      + 'A principal without `call: readOthers` sees a phone system call only when it involves the directory person linked to its login '
      + '(docs/phone-system.md, "Who sees calls").',
    operationId: 'listAllCalls',
    tags: ["Calls"],
    responses: {
      200: {
        description: 'A list of all calls',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                calls: {
                  type: 'array',
                  items: {
                    $ref: '#/components/schemas/Call'
                  }
                },
                next: {
                  type: 'number',
                  description: 'The last index in this page; pass as `lastIndex` to fetch the next page.'
                }
              },
              example: {
                calls: [
                  {
                    id: "648aa45d-204a-4c0c-a1e1-419406254134",
                    index: 1,
                    agentId: "648aa45d-204a-4c0c-a1e1-419406252234",
                    parentId: null,
                    modelName: "livekit:ultravox:ultravox-70b",
                    callerId: "+443300889471",
                    calledId: "+442080996945",
                    startedAt: "2025-06-04T12:00:00.000Z",
                    endedAt: "2025-06-04T12:01:00.000Z",
                    status: "ended normally",
                    recordingId: "development-recordings/648aa45d-204a-4c0c-a1e1-419406254134.enc"
                  },
                  {
                    id: "632555d87-948e-48f2-a53d-fc5f261daa7",
                    index: 2,
                    agentId: "632555d87-948e-48f2-a53d-fc5f261df2a",
                    parentId: "648aa45d-204a-4c0c-a1e1-419406254134",
                    modelName: "telephony:bridged-call",
                    callerId: "+443300889470",
                    calledId: "+442080996945",
                    startedAt: "2025-06-04T12:01:00.000Z",
                    endedAt: "2025-06-04T12:02:00.000Z",
                    status: "ended normally",
                    recordingId: null
                  },
                ],
                next: 2
              }
            }
          }
        }
      },
      404: {
        description: 'Agent not found',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/NotFound'
            }
          }
        }
      },
      default: {
        description: 'Another kind of error occurred',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/Error'
            }
          }
        }
      }

    }
  };


  return {
    description: `Call objects are created when an agent receives a call from an external caller`,
    summary: 'Call objects represent live calls on the agent',
    parameters: [
      {
        description: "Start date of the calls to return",
        in: 'query',
        name: 'startDate',
        required: false,
        schema: {
          type: 'string',
          format: 'date-time'
        }
      },
      {
        description: "End date of the calls to return",
        in: 'query',
        name: 'endDate',
        required: false,
        schema: {
          type: 'string',
          format: 'date-time'
        }
      },
      {
        description: "Last index before the set of calls to return - this is used to paginate through the calls, set to the last index of the previous set of calls",
        in: 'query',
        name: 'lastIndex',
        required: false,
        schema: {
          type: 'number'
        }
      },
      {
        description: "Limit of the number of calls to return",
        in: 'query',
        name: 'limit',
        required: false,
        schema: {
          type: 'number',
          default: 50
        }
      },
      {
        description: "Deleted calls (DELETE /calls/{callId}) are left out by default. `include` lists them with the rest, and `only` lists nothing else. A deleted call shows its billing fields and `redactedAt`; its caller and called numbers are null.",
        in: 'query',
        name: 'redacted',
        required: false,
        schema: {
          type: 'string',
          enum: ['exclude', 'include', 'only'],
          default: 'exclude'
        }
      }
    ],
    GET: listAllCalls
  };



};