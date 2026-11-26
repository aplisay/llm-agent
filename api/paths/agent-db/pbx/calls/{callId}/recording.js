import { setRecording } from '../../../../../../lib/pbx/call-records.js';
import { sendPbxError } from '../../../../../../lib/pbx/errors.js';

/**
 * PUT /api/agent-db/pbx/calls/{callId}/recording: the finished recording of
 * a call with no agent. Internal, call control token only.
 *
 * The caller deletes its file on any 4xx and keeps it on a 5xx. So a 4xx is
 * sent only when nothing was stored, and a 5xx only when that is not known.
 */
export default function (logger) {
  const put = async (req, res) => {
    const { callId } = req.params;
    try {
      const { outcome, recordingId } = await setRecording(callId, req.body || {});
      if (outcome === 'exists') {
        res.status(409).send({ error: 'This call has a recording already', code: 'recording_exists', recordingId });
        return;
      }
      if (outcome === 'stored') logger?.info?.({ callId, recordingId }, 'phone system call: recording stored');
      res.send({ callId, recordingId });
    } catch (err) {
      sendPbxError(res, err, logger, 'error storing the recording of a phone system call');
    }
  };
  put.apiDoc = {
    summary: 'Store the finished recording of a phone system call (internal).',
    description: 'Sets the name and key of the call\'s recording, once. The same name sent again answers 200. '
      + 'Another name answers 409 `recording_exists` with the name that is held. '
      + 'A call that does not exist, is another organisation\'s, is a leg, or was deleted answers 404.',
    operationId: 'setPbxCallRecording',
    tags: ['agent-db'],
    parameters: [{ in: 'path', name: 'callId', required: true, schema: { type: 'string', format: 'uuid' } }],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              organisationId: { description: 'The organisation the call belongs to.' },
              recordingId: { description: 'The object name in the recording store. It contains the call id.' },
              encryptionKey: { description: 'The AES-256-GCM key of the object: 32 bytes in base64.' },
            },
          },
        },
      },
    },
    responses: {
      200: {
        description: 'The call holds this recording',
        content: { 'application/json': { schema: { type: 'object', properties: { callId: { type: 'string' }, recordingId: { type: 'string' } } } } },
      },
      409: {
        description: 'The call holds another recording, named in `recordingId`',
        content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' }, code: { type: 'string' }, recordingId: { type: 'string' } } } } },
      },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };
  return { PUT: put };
}
