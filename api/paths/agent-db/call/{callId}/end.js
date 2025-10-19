import { Call , TransactionLog } from '../../../../../lib/database.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    POST: callEnd
  };
};

const callEnd = (async (req, res) => {
  let { callId } = req.params;
  let { reason } = req.body;
  
  if (!callId) {
    return res.status(400).send({ error: 'callId parameter is required' });
  }

  try {
    let call = await Call.findByPk(callId);
    
    if (!call) {
      return res.status(404).send({ error: 'Call not found' });
    }

    await TransactionLog.create({
      callId,
      type: 'hangup',
      data: reason || 'unknown'
    });
    await call.end();
    
    res.send({ message: 'Call ended successfully', callId });
  }
  catch (err) {
    log.error(err, 'error ending call');
    res.status(500).send({ error: 'Internal server error' });
  }
});

callEnd.apiDoc = {
  summary: 'Ends a call by updating the call record.',
  operationId: 'endCall',
  tags: ["Calls"],
  parameters: [
    {
      name: 'callId',
      in: 'path',
      required: true,
      schema: {
        type: 'string',
        format: 'uuid'
      },
      description: 'The ID of the call to end'
    }
  ],
  requestBody: {
    required: false,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            reason: { type: 'string' }
          }
        }
      }
    }
  },
  responses: {
    200: {
      description: 'Call end record created successfully.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              message: {
                type: 'string'
              },
              callId: {
                type: 'string',
                format: 'uuid'
              }
            }
          }
        }
      }
    },
    400: {
      description: 'Bad request - missing callId parameter',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    404: {
      description: 'Call not found',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: {
                type: 'string'
              }
            }
          }
        }
      }
    }
  }
};
