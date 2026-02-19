import { Call } from '../../../../../lib/database.js';

let log;

export default function (logger) {
  log = logger;
  return {
    PUT: setCallRecording,
  };
}

const setCallRecording = async (req, res) => {
  const { callId } = req.params;
  const { recordingId, encryptionKey } = req.body || {};

  if (!callId) {
    return res.status(400).send({ error: 'callId parameter is required' });
  }
  if (!recordingId) {
    return res.status(400).send({ error: 'recordingId is required' });
  }

  try {
    const call = await Call.findByPk(callId);

    if (!call) {
      return res.status(404).send({ error: 'Call not found' });
    }

    call.recordingId = recordingId;
    if (typeof encryptionKey === 'string' && encryptionKey.length > 0) {
      call.encryptionKey = encryptionKey;
    }

    await call.save();

    return res.send({ callId: call.id, recordingId: call.recordingId });
  }
  catch (err) {
    log?.error?.(err, 'error setting call recording data');
    return res.status(500).send({ error: 'Internal server error' });
  }
};

setCallRecording.apiDoc = {
  summary: 'Set recording metadata for a call.',
  description: 'Internal API used by workers to store recordingId and optional encryptionKey for a call.',
  operationId: 'setCallRecording',
  tags: ['Calls'],
  parameters: [
    {
      name: 'callId',
      in: 'path',
      required: true,
      schema: {
        type: 'string',
        format: 'uuid',
      },
      description: 'The ID of the call to update.',
    },
  ],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            recordingId: {
              type: 'string',
              description: 'Recording identifier (GCP object path) associated with this call.',
            },
            encryptionKey: {
              type: 'string',
              nullable: true,
              description: 'Optional server-generated encryption key for this recording. Omitted when the client supplies its own key.',
            },
          },
          required: ['recordingId'],
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Recording data updated successfully.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              callId: {
                type: 'string',
              },
              recordingId: {
                type: 'string',
              },
            },
          },
        },
      },
    },
    400: {
      description: 'Bad request - missing parameters',
    },
    404: {
      description: 'Call not found',
    },
    500: {
      description: 'Internal server error',
    },
  },
};

