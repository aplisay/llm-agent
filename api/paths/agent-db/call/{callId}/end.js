import { Call , TransactionLog } from '../../../../../lib/database.js';
import { maybeSendCallHook } from '../../../../../lib/call-hook.js';

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

/**
 * Set the createdAt of rows already stored for this call. A bad entry is
 * skipped: a correction must never stop the call from ending.
 */
async function applyTransactionLogCorrections(callId, corrections) {
  for (const { id, createdAt } of corrections) {
    const rowId = Number(id);
    const at = new Date(createdAt);
    if (!Number.isSafeInteger(rowId) || rowId <= 0 || Number.isNaN(at.getTime())) continue;
    try {
      // No hooks: the progress socket must not send the row a second time.
      await TransactionLog.update({ createdAt: at }, { where: { id: rowId, callId }, hooks: false });
    }
    catch (err) {
      log?.warn?.({ err: err?.message, callId, id }, 'transaction log correction skipped');
    }
  }
}

const callEnd = (async (req, res) => {
  let { callId } = req.params;
  let { reason, transactionLogs, transactionLogCorrections, userId, organisationId } = req.body;
  
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

    // Rows streamed during the call carry a provisional time. Apply the
    // reconciled times first: for a streamed call the end hook reads them back.
    if (Array.isArray(transactionLogCorrections) && transactionLogCorrections.length > 0) {
      await applyTransactionLogCorrections(callId, transactionLogCorrections);
    }

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

    // Build transcript from provided transactionLogs if present
    let transcript = null;
    if (transactionLogs && Array.isArray(transactionLogs) && transactionLogs.length > 0) {
      transcript = {
        entries: transactionLogs
      };
    }

    // Fire callHook end callback (non-blocking)
    maybeSendCallHook({
      event: 'end',
      call,
      agent: null,
      listenerOrInstance: null,
      reason,
      transcript,
      logger: log
    }).catch((err) => {
      log?.warn?.(err, 'error sending callHook end callback');
    });
    
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
            },
            transactionLogCorrections: {
              type: 'array',
              description: 'Reconciled createdAt times for rows already stored during the call (used when streamLog is true). Applied before the end hook is sent.',
              items: {
                type: 'object',
                required: ['id', 'createdAt'],
                properties: {
                  id: { type: 'integer', description: 'The transaction log row id returned when it was created' },
                  createdAt: { type: 'string', format: 'date-time' }
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
