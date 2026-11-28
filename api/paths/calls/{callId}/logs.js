import { TransactionLog  } from '../../../../lib/database.js';;
import { requirePermission, can } from '../../../../lib/auth/permissions.js';
import { transcriptSpeakerReady } from '../../../../lib/capabilities.js';
import { callVisibility, findVisibleCall } from '../../../../lib/call-visibility.js';



export default function (logger) {
  
  const callTransactionLog = async (req, res) => {
    if (!requirePermission(res, 'call', 'read')) return;
    let { callId } = req.params;

    let where = { callId, ...res.locals.user.sql.where };
    logger.debug({ callId, where }, 'callTransactionLog');
    // A transcript shows to whoever may see its call. The extra read is only for a principal limited to its own calls.
    const visibility = await callVisibility(res.locals.user);
    if (!visibility.all && !(await findVisibleCall(res.locals.user, callId, { attributes: ['id'], visibility }))) {
      return res.send([]);
    }
    // Only the texts of a call with no agent have a speaker. They need what the call's recording needs.
    if (transcriptSpeakerReady() && !can(res.locals.user, 'recording', 'download')) where.speaker = null;
    let transactionLogs = await TransactionLog.findAll({
      where,
      order: [['createdAt', 'ASC']],
    });

    res.send(transactionLogs);
  };
  callTransactionLog.apiDoc = {
    summary: 'Get transaction log for a call',
    description: 'Returns a list of transaction logs for the specified call. The texts of a phone system call with no agent (the rows with a `speaker`) are left out for a caller without `recording:download`.',
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
      503: { description: 'Too many call log reads are in progress on this server. Retry after the interval given in the Retry-After header.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };


  return {
    GET: callTransactionLog,
  };
};

