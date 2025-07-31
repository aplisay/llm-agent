import { TransactionLog  } from '../../../../lib/database.js';;



export default function (logger) {
  
  const callTransactionLog = async (req, res) => {
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
    },
  };


  return {
    GET: callTransactionLog,
  };
};

