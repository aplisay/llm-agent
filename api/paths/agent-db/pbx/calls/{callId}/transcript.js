import { addTranscript } from '../../../../../../lib/pbx/call-records.js';
import { sendPbxError } from '../../../../../../lib/pbx/errors.js';

/**
 * POST /api/agent-db/pbx/calls/{callId}/transcript: what was said on a call
 * with no agent, one text for each thing a party said. Internal, call control
 * token only. Each text carries an id from the caller, and one already stored
 * is skipped.
 */
export default function (logger) {
  const add = async (req, res) => {
    try {
      res.send(await addTranscript(req.params.callId, req.body?.texts));
    } catch (err) {
      sendPbxError(res, err, logger, 'error storing the transcript of a phone system call');
    }
  };
  add.apiDoc = {
    summary: 'Add texts to the transcript of a phone system call (internal).',
    operationId: 'addPbxCallTranscript',
    tags: ['agent-db'],
    parameters: [{ in: 'path', name: 'callId', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          // No types on purpose: the function checks the texts, so every refusal has the same body.
          schema: {
            type: 'object',
            properties: {
              texts: {
                description: 'A list of 1 to 200 texts. One bad text refuses the whole request. Each text is an object: '
                  + '`id`, a UUID chosen by the caller (a text sent twice is stored once). '
                  + '`leg`, the row that spoke: the call id for the caller, or the id of an answered leg of this call. '
                  + '`text`, one final text of 1 to 4000 characters. '
                  + '`at`, when the words began (absent means now). '
                  + '`party`, `startMs` and `endMs` may be sent and are not stored.',
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'How many texts were stored and how many were already there', content: { 'application/json': { schema: { type: 'object', properties: { stored: { type: 'integer' }, duplicates: { type: 'integer' } } } } } },
      400: { description: 'A text or the list is not valid. Nothing was stored.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      404: { description: 'No such phone system call, an erased call, or a leg that is not of this call. Nothing was stored.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      503: { description: 'The database needs the schema 82 upgrade.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { POST: add };
}
