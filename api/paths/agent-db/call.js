import { Call } from '../../../lib/database.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    POST: callCreate
  };
};

const callCreate = (async (req, res) => {
  let { id, userId, organisationId, instanceId, agentId, platform, platformCallId, calledId, callerId, modelName, options, metadata } = req.body;
  
  if (!userId || !organisationId || !instanceId || !agentId || !platform) {
    return res.status(400).send({ error: 'Missing required fields: userId, organisationId, instanceId, agentId, platform' });
  }

  try {
    let call = await Call.create({
      id,
      userId,
      organisationId,
      instanceId,
      agentId,
      platform,
      platformCallId,
      calledId,
      callerId,
      modelName,
      options,
      metadata
    });

    res.status(201).send(call);
  }
  catch (err) {
    log.error(err, 'error creating call');
    res.status(500).send({ error: 'Internal server error' });
  }
});

callCreate.apiDoc = {
  summary: 'Creates a new call record.',
  operationId: 'createCall',
  tags: ["Calls"],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['userId', 'organisationId', 'instanceId', 'agentId', 'platform'],
          properties: {
            userId: {
              type: 'string',
              description: 'User ID'
            },
            organisationId: {
              type: 'string',
              description: 'Organization ID'
            },
            instanceId: {
              type: 'string',
              description: 'Instance ID'
            },
            agentId: {
              type: 'string',
              description: 'Agent ID'
            },
            platform: {
              type: 'string',
              description: 'Platform name (e.g., livekit, jambonz)'
            },
            platformCallId: {
              type: 'string',
              description: 'Platform-specific call ID'
            },
            calledId: {
              type: 'string',
              description: 'Called number/ID'
            },
            callerId: {
              type: 'string',
              description: 'Caller number/ID'
            },
            modelName: {
              type: 'string',
              description: 'Model name'
            },
            options: {
              type: 'object',
              description: 'Call options'
            },
            metadata: {
              type: 'object',
              description: 'Call metadata'
            }
          }
        }
      }
    }
  },
  responses: {
    201: {
      description: 'Call created successfully.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              id: {
                type: 'string',
                format: 'uuid'
              },
              userId: {
                type: 'string',
                format: 'uuid'
              },
              organisationId: {
                type: 'string',
                format: 'uuid'
              },
              instanceId: {
                type: 'string',
                format: 'uuid'
              },
              agentId: {
                type: 'string',
                format: 'uuid'
              },
              platform: {
                type: 'string'
              },
              platformCallId: {
                type: 'string'
              },
              calledId: {
                type: 'string'
              },
              callerId: {
                type: 'string'
              },
              modelName: {
                type: 'string'
              },
              options: {
                type: 'object'
              },
              metadata: {
                type: 'object'
              },
              createdAt: {
                type: 'string',
                format: 'date-time'
              },
              updatedAt: {
                type: 'string',
                format: 'date-time'
              }
            }
          }
        }
      }
    },
    400: {
      description: 'Bad request - missing required fields',
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
