import { TransactionLog } from '../../../lib/database.js';

let appParameters, log;

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    POST: transactionLogCreate
  };
};

const transactionLogCreate = (async (req, res) => {
  let { userId, organisationId, callId, type, data, isFinal } = req.body;
  
  if (!userId || !organisationId || !callId || !type) {
    return res.status(400).send({ error: 'Missing required fields: userId, organisationId, callId, type' });
  }

  try {
    let transactionLog = await TransactionLog.create({
      userId,
      organisationId,
      callId,
      type,
      data,
      isFinal: isFinal || false
    });

    res.status(201).send(transactionLog);
  }
  catch (err) {
    log.error(err, 'error creating transaction log');
    res.status(500).send({ error: 'Internal server error' });
  }
});

transactionLogCreate.apiDoc = {
  summary: 'Creates a new transaction log record.',
  operationId: 'createTransactionLog',
  tags: ["Calls"],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['userId', 'organisationId', 'callId', 'type'],
          properties: {
            userId: {
              type: 'string',
              description: 'User ID'
            },
            organisationId: {
              type: 'string',
              description: 'Organization ID'
            },
            callId: {
              type: 'string',
              description: 'Call ID'
            },
            type: {
              type: 'string',
              description: 'Transaction type (e.g., answer, user, agent)'
            },
            data: {
              anyOf: [
                { type: 'string' },
                { type: 'object' }
              ],
              description: 'Transaction data'
            },
            isFinal: {
              type: 'boolean',
              description: 'Whether this is a final transaction',
              default: false
            }
          }
        }
      }
    }
  },
  responses: {
    201: {
      description: 'Transaction log created successfully.',
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
              callId: {
                type: 'string',
                format: 'uuid'
              },
              type: {
                type: 'string'
              },
              data: {
                type: 'string'
              },
              isFinal: {
                type: 'boolean'
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
