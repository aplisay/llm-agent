import { Call, Op } from '../../lib/database.js';
let appParameters, log;

export default function (logger) {

  log = logger;

  const listAllCalls = (async (req, res) => {
    try {
      let { startDate, endDate, lastIndex = 0, limit = 50 } = req.query;
      let where = {
        [Op.and]: [
          { index: { [Op.gt]: lastIndex } },
          {
            organisationId: res.locals.user.organisationId
          }
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
        attributes: ['id', 'index', 'agentId', 'parentId', 'modelName', 'callerId', 'calledId', 'startedAt', 'endedAt'],
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
                  type: 'string',
                  description: 'The offset to use for the next page of results'
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
                    endedAt: "2025-06-04T12:01:00.000Z"
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
                    endedAt: "2025-06-04T12:02:00.000Z"
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
      }
    ],
    GET: listAllCalls
  };



};