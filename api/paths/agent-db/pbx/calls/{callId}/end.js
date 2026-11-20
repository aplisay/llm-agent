import { endCall, callView } from '../../../../../../lib/pbx/call-records.js';
import { sendPbxError } from '../../../../../../lib/pbx/errors.js';

/**
 * POST /api/agent-db/pbx/calls/{callId}/end: a call or a leg has ended.
 * Internal, call control token only. Ending a call twice changes nothing.
 * Ending writes the call's usage (lib/pbx/usage.js).
 */
export default function (logger) {
  const end = async (req, res) => {
    try {
      const { call } = await endCall(req.params.callId, req.body || {});
      res.send(callView(call));
    } catch (err) {
      sendPbxError(res, err, logger, 'error ending a phone system call');
    }
  };
  end.apiDoc = {
    summary: 'End a phone system call or leg (internal).',
    operationId: 'endPbxCall',
    tags: ['agent-db'],
    parameters: [{ in: 'path', name: 'callId', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: false,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              endedAt: { type: 'string', format: 'date-time', nullable: true },
              reason: { type: 'string', nullable: true, description: 'Why it ended, for example hangup, no_answer, refused.' },
              answered: { type: 'boolean', nullable: true },
              recordedMs: { type: 'integer', minimum: 0, nullable: true, description: 'On the call itself: how long it was recorded. Charged by the recording line of the rate card.' },
              transcribedMs: { type: 'integer', minimum: 0, nullable: true, description: 'How much of the call or leg was transcribed. Charged by the transcription line of the rate card.' },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'The call', content: { 'application/json': { schema: { type: 'object' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { POST: end };
}
