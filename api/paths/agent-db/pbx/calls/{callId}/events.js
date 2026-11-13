import { addEvents } from '../../../../../../lib/pbx/call-records.js';
import { sendPbxError } from '../../../../../../lib/pbx/errors.js';

/**
 * POST /api/agent-db/pbx/calls/{callId}/events: things that happened on a call
 * and are not rows of their own, such as a phone that rang and was not
 * answered. Internal, call control token only. Each event carries an id from
 * the caller, and one already stored is skipped.
 */
export default function (logger) {
  const add = async (req, res) => {
    try {
      res.send(await addEvents(req.params.callId, req.body?.events));
    } catch (err) {
      sendPbxError(res, err, logger, 'error recording phone system call events');
    }
  };
  add.apiDoc = {
    summary: 'Add events to a phone system call (internal).',
    operationId: 'recordPbxCallEvents',
    tags: ['agent-db'],
    parameters: [{ in: 'path', name: 'callId', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['events'],
            properties: {
              events: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'object',
                  required: ['id', 'type'],
                  properties: {
                    id: { type: 'string', format: 'uuid', description: 'Chosen by the caller.' },
                    type: { type: 'string', description: 'A short lower-case name, for example leg_rang, leg_answered, hold, unhold.' },
                    at: { type: 'string', format: 'date-time', nullable: true },
                    data: { type: 'object', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'How many events were stored and how many were already there', content: { 'application/json': { schema: { type: 'object', properties: { stored: { type: 'integer' }, duplicates: { type: 'integer' } } } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { POST: add };
}
