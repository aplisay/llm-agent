import { Call, Op } from '../../../../lib/database.js';
let appParameters, log;

export default function (logger) {

  log = logger;

  const callsList = (async (req, res) => {
    try {
      let { agentId } = req.params;
      let { startDate, endDate, offset = 0, limit = 50 } = req.query;
      let where = {
        [Op.and]: [
          { agentId },
          {
            [Op.or]: [
              { userId: res.locals.user.id },
              { organisationId: res.locals.user.organisationId }
            ]
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
        attributes: ['id', 'callerId', 'calledId', 'startedAt', 'endedAt'],
        where,
        order: [['createdAt', 'DESC']],
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
      req.log.debug({ where, count, calls, limit, offset });
      next = count > (offset + limit) ? offset + limit : false;
      res.send({ calls, next });
    } catch (error) {
      req.log.error(error);
      res.status(500).send({ error: error.message });
    }
  });

  callsList.apiDoc = {
    summary: 'Returns list of calls in progress to this agent',
    operationId: 'callsList',
    tags: ["Calls"],
    responses: {
      200: {
        description: 'A list of in progress calls',
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
                  { id: "648aa45d-204a-4c0c-a1e1-419406254134", from: "+443300889471", to: "+442080996945" },
                  { id: "632555d87-948e-48f2-a53d-fc5f261daa7", from: "+443300889470", to: "+442080996945" },
                ],
                next: 3
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
        description: "ID of the parent agent",
        in: 'path',
        name: 'agentId',
        required: true,
        schema: {
          type: 'string'
        }
      }
    ],
    GET: callsList
  };



};