import { upsertCall, callView } from '../../../../lib/pbx/call-records.js';
import { sendPbxError } from '../../../../lib/pbx/errors.js';

/**
 * POST /api/agent-db/pbx/calls: call control records a call, or an answered
 * leg of one (`parentId`). Internal, call control token only. The caller
 * chooses the id, so a write sent twice is one row.
 */
export default function (logger) {
  const create = async (req, res) => {
    try {
      const { call, created } = await upsertCall(req.body || {});
      res.status(created ? 201 : 200).send(callView(call));
    } catch (err) {
      sendPbxError(res, err, logger, 'error recording a phone system call');
    }
  };
  create.apiDoc = {
    summary: 'Record a phone system call or an answered leg, or update it (internal).',
    operationId: 'recordPbxCall',
    tags: ['agent-db'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['id', 'organisationId'],
            properties: {
              id: { type: 'string', format: 'uuid', description: 'Chosen by the caller.' },
              organisationId: { type: 'string' },
              parentId: { type: 'string', format: 'uuid', nullable: true, description: 'The call this answered leg belongs to.' },
              callerId: { type: 'string', nullable: true },
              calledId: { type: 'string', nullable: true },
              platformCallId: { type: 'string', nullable: true },
              outboundTrunkId: { type: 'string', nullable: true, description: 'The trunk an outside leg went out on.' },
              startedAt: { type: 'string', format: 'date-time', nullable: true },
              metadata: { type: 'object', nullable: true, description: 'Kept under `metadata.pbx` on the call: the extension, the line, the direction.' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The call already existed and was updated', content: { 'application/json': { schema: { type: 'object' } } } },
      201: { description: 'The call was created', content: { 'application/json': { schema: { type: 'object' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { POST: create };
}
