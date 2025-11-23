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
  let { reason, transactionLogs, userId, organisationId } = req.body;
  
  if (!callId) {
    return res.status(400).send({ error: 'callId parameter is required' });
  }

  try {
    let call = await Call.findByPk(callId);
    
    if (!call) {
      return res.status(404).send({ error: 'Call not found' });
    }

    // Use provided userId/organisationId or fall back to call record values
    const finalUserId = userId || call.userId;
    const finalOrganisationId = organisationId || call.organisationId;

    // If transactionLogs array is provided, batch create them
    if (transactionLogs && Array.isArray(transactionLogs) && transactionLogs.length > 0) {
      // Ensure all logs have the correct callId and preserve createdAt timestamps
      const logsToCreate = transactionLogs.map(log => ({
        ...log,
        callId: callId,
        // Preserve createdAt if provided, otherwise Sequelize will use current timestamp
        createdAt: log.createdAt ? new Date(log.createdAt) : undefined
      }));
      await TransactionLog.bulkCreate(logsToCreate);
    }

    // Always create the hangup log with userId and organisationId
    await TransactionLog.create({
      userId: finalUserId,
      organisationId: finalOrganisationId,
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
            reason: { 
              type: 'string',
              description: 'Reason for ending the call'
            },
            userId: {
              type: 'string',
              description: 'User ID for transaction log creation'
            },
            organisationId: {
              type: 'string',
              description: 'Organisation ID for transaction log creation'
            },
            transactionLogs: {
              type: 'array',
              description: 'Array of transaction logs to batch create when ending the call (used when streamLog is false)',
              items: {
                type: 'object',
                properties: {
                  userId: { type: 'string' },
                  organisationId: { type: 'string' },
                  callId: { type: 'string' },
                  type: { type: 'string' },
                  data: { type: 'string' },
                  isFinal: { type: 'boolean' },
                  createdAt: { 
                    type: 'string',
                    format: 'date-time',
                    description: 'Timestamp when the log was captured (preserved from client-side)'
                  }
                }
              }
            }
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
