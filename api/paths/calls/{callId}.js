import { Call } from '../../../lib/database.js';
import { Sequelize } from 'sequelize';
import { requirePermission } from '../../../lib/auth/permissions.js';
import { callVisibility, withVisibility } from '../../../lib/call-visibility.js';
import { callRedactionReady, notRedacted, redactCallTree } from '../../../lib/call-redaction.js';

export const CALL_REDACTION_NOT_READY = {
  error: 'Deleting calls needs a database upgrade. Run tools/agent-admin.js upgrade-db, then restart the API server.',
  code: 'call_redaction_not_ready',
};

const errorContent = { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } };

/** Finalised per-call cost in micro-pounds — see api/paths/calls.js. */
const COST_MICROS_LITERAL =
  '(SELECT SUM(ur.cost_micros)::float8 FROM usage_records ur WHERE ur.call_id = "Call"."id" AND ur.finalised AND ur.cost_micros IS NOT NULL)';

export default function (logger) {

  const getCall = async (req, res) => {
    if (!requirePermission(res, 'call', 'read')) return;
    const { callId } = req.params;

    try {
      const where = withVisibility({ id: callId, ...res.locals.user.sql.where, ...notRedacted() }, await callVisibility(res.locals.user));
      logger.debug({ callId }, 'getCall');
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

  const deleteCall = async (req, res) => {
    if (!requirePermission(res, 'call', 'delete')) return;
    if (!callRedactionReady()) return res.status(503).send(CALL_REDACTION_NOT_READY);
    const { callId } = req.params;
    const log = req.log || logger;

    try {
      const result = await redactCallTree({
        callId,
        scope: res.locals.user.sql.where,
        actorId: res.locals.user.id ?? null,
        log,
      });
      if (result.outcome === 'not_found') {
        return res.status(404).send({ error: `Call with ID ${callId} not found` });
      }
      if (result.outcome === 'busy') {
        return res.status(409).send({
          error: 'A leg of this call is still in progress or ended less than 15 minutes ago. Try again later.',
          code: 'call_in_progress',
          blockers: result.blockers,
        });
      }
      return res.send({ callIds: result.callIds });
    } catch (error) {
      log.error({ err: error, callId }, 'call delete failed');
      res.status(500).send({ error: error.message });
    }
  };

  deleteCall.apiDoc = {
    summary: 'Deletes a call',
    description:
      'Deletes the caller data and content of a call and of every call linked to it (transfer, handover and bridged '
      + 'legs of the same conversation): caller and called numbers, metadata, agent options, transcripts, call events, '
      + 'invocation logs and the recording. A billing record of each leg is kept: its ID, organisation, user, agent, '
      + 'model, trunk, start and end times, duration and status, with its usage and cost records, which hold the '
      + 'billed destination number of a chargeable outbound leg. A deleted call is left out of call reads; '
      + '`GET /calls?redacted=include` lists it with its billing fields and `redactedAt`. A leg that is still in '
      + 'progress, or ended less than 15 minutes ago, makes the request fail with 409 so that late writes cannot '
      + 'bring data back. A leg with no end after 24 hours counts as stuck and does not block.',
    tags: ['Calls'],
    operationId: 'deleteCall',
    parameters: [
      {
        name: 'callId',
        in: 'path',
        description: 'The ID of any leg of the call',
        required: true,
        schema: { type: 'string' },
      },
    ],
    responses: {
      200: {
        description: 'The call is deleted. `callIds` lists every leg that was deleted with it.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                callIds: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      403: { description: 'Requires call:delete', content: errorContent },
      404: {
        description: 'Call not found, or already deleted',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } },
      },
      409: { description: '`call_in_progress`: a leg is in progress or ended too recently. `blockers` names each one.', content: errorContent },
      503: { description: '`call_redaction_not_ready`: the database lacks the upgrade that adds call deletion', content: errorContent },
      default: { description: 'Another kind of error occurred', content: errorContent },
    },
  };

  return {
    GET: getCall,
    DELETE: deleteCall,
  };
};
