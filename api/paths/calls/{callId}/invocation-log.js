import { InvocationLog } from '../../../../lib/database.js';
import { gunzipSync } from 'zlib';
import { requirePermission } from '../../../../lib/auth/permissions.js';

export default function (logger) {
  const getInvocationLog = async (req, res) => {
    if (!requirePermission(res, 'call', 'read')) return;
    const { callId } = req.params;

    const where = { callId, ...res.locals.user.sql.where };
    logger.debug({ callId, where }, 'getInvocationLog');

    const records = await InvocationLog.findAll({
      where,
      order: [['createdAt', 'ASC']],
    });

    const result = records.map((record) => {
      let decodedLog = null;
      const stored = record.log;
      if (
        stored &&
        typeof stored === 'object' &&
        stored.encoding === 'gzip_base64' &&
        typeof stored.data === 'string'
      ) {
        try {
          const buf = Buffer.from(stored.data, 'base64');
          const json = gunzipSync(buf).toString('utf8');
          decodedLog = JSON.parse(json);
        } catch (e) {
          logger.error({ e }, 'Failed to decompress invocation log, returning raw wrapper');
          decodedLog = stored;
        }
      } else {
        decodedLog = stored;
      }

      return {
        callId: record.callId,
        organisationId: record.organisationId,
        userId: record.userId,
        subsystem: record.subsystem,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        log: decodedLog,
      };
    });

    res.send(result);
  };

  getInvocationLog.apiDoc = {
    summary: 'Get invocation logs for a call',
    description: 'Returns all pruned and decompressed invocation logs (pino logs) for the specified call across all subsystems.',
    tags: ['Calls'],
    operationId: 'getInvocationLog',
    parameters: [
      {
        name: 'callId',
        in: 'path',
        description: 'The call ID',
        required: true,
        schema: {
          type: 'string',
        },
      },
    ],
    responses: {
      200: {
        description: 'Invocation logs for the call',
        content: {
          'application/json': {
            schema: {
              type: 'array',
              items: {
                $ref: '#/components/schemas/InvocationLog',
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
    GET: getInvocationLog,
  };
}

