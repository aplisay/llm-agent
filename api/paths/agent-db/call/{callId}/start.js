import { Call } from '../../../../../lib/database.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    POST: callStart
  };
};

const callStart = (async (req, res) => {
  let { callId } = req.params;
  
  if (!callId) {
    return res.status(400).send({ error: 'callId parameter is required' });
  }

  try {
    let call = await Call.findByPk(callId);
    
    if (!call) {
      return res.status(404).send({ error: 'Call not found' });
    }

    await call.start();
    
    res.send({ message: 'Call started successfully', callId });
  }
  catch (err) {
    log.error(err, 'error starting call');
    res.status(500).send({ error: 'Internal server error' });
  }
});

callStart.apiDoc = {
  summary: 'Starts a call by updating the call record.',
  operationId: 'startCall',
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
      description: 'The ID of the call to start'
    }
  ],
  responses: {
    200: {
      description: 'Call started successfully.',
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
