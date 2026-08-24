import { Call } from '../../../lib/database.js';
import { Sequelize } from 'sequelize';
import { requirePermission } from '../../../lib/auth/permissions.js';

/** Finalised per-call cost in micro-pounds — see api/paths/calls.js. */
const COST_MICROS_LITERAL =
  '(SELECT SUM(ur.cost_micros)::float8 FROM usage_records ur WHERE ur.call_id = "Call"."id" AND ur.finalised AND ur.cost_micros IS NOT NULL)';

export default function (logger) {

  const getCall = async (req, res) => {
    if (!requirePermission(res, 'call', 'read')) return;
    const { callId } = req.params;

    const where = { id: callId, ...res.locals.user.sql.where };
    logger.debug({ callId, where }, 'getCall');

    try {
      const call = await Call.findOne({
        where,
        attributes: ['id', 'index', 'agentId', 'parentId', 'modelName', 'callerId', 'calledId', 'startedAt', 'endedAt', 'status', 'recordingId', [Sequelize.literal(COST_MICROS_LITERAL), 'costMicros']],
      });

      if (!call) {
        return res.status(404).send({ error: `Call with ID ${callId} not found` });
      }

      res.send({ ...call.dataValues });
    } catch (error) {
      req.log.error(error);
      res.status(500).send({ error: error.message });
    }
  };

  getCall.apiDoc = {
    summary: 'Returns data for a single call',
    description: 'Returns the call object for the specified call ID, scoped to the authenticated user or organisation.',
    tags: ["Calls"],
    operationId: 'getCall',
    parameters: [
      {
        name: 'callId',
        in: 'path',
        description: 'The call ID',
        required: true,
        schema: {
          type: 'string',
        },
      },
    ],
    responses: {
      200: {
        description: 'The call object',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/Call',
            },
          },
        },
      },
      404: {
        description: 'Call not found',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/NotFound',
            },
          },
        },
      },
      default: {
        description: 'Another kind of error occurred',
        content: {
          'application/json': {
            schema: {
              $ref: '#/components/schemas/Error',
            },
          },
        },
      },
    },
  };

  return {
    GET: getCall,
  };
};
