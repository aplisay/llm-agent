import { TransactionLog  } from '../../../../lib/database.js';;
import { requirePermission } from '../../../../lib/auth/permissions.js';



export default function (logger) {
  
  const callTransactionLog = async (req, res) => {
    if (!requirePermission(res, 'call', 'read')) return;
    let { callId } = req.params;

    let where = { callId, ...res.locals.user.sql.where };
    logger.debug({ callId, where }, 'callTransactionLog');
    let transactionLogs = await TransactionLog.findAll({
      where,
      order: [['createdAt', 'ASC']],
    });

    res.send(transactionLogs);
  };
  callTransactionLog.apiDoc = {
    summary: 'Get transaction log for a call',
    description: 'Returns a list of transaction logs for the specified call',
    tags: ["Calls"],
    operationId: 'callTransactionLog',
    parameters: [
      {
        name: 'callId',
        in: 'path',
        description: 'The call ID',
        required: true,
        schema: {
          type:'string',
        },
      },
    ],
    responses: {
      200: {
        description: 'The transaction logs',
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/TransactionLog',
              },
            },
          },
        },
      },
      429: { description: 'Too many call log requests from this principal. Retry after the interval given in the Retry-After header.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };


  return {
    GET: callTransactionLog,
  };
};

