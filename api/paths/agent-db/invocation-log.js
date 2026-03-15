import { InvocationLog } from '../../../lib/database.js';
import { gzipSync } from 'zlib';

let appParameters, log;

function pruneJson(value, maxSize = 256 * 1024) {
  try {
    const s = JSON.stringify(value);
    if (s.length <= maxSize) return value;
  } catch {
    // fall through to structural pruning
  }

  if (Array.isArray(value)) {
    const pruned = [];
    for (const item of value) {
      pruned.push(pruneJson(item, maxSize));
      try {
        if (JSON.stringify(pruned).length > maxSize) {
          pruned.push({ __truncated__: true });
          break;
        }
      } catch {
        break;
      }
    }
    return pruned;
  }

  if (value && typeof value === 'object') {
    const pruned = {};
    for (const [k, v] of Object.entries(value)) {
      pruned[k] = pruneJson(v, maxSize);
      try {
        if (JSON.stringify(pruned).length > maxSize) {
          pruned.__truncated__ = true;
          break;
        }
      } catch {
        break;
      }
    }
    return pruned;
  }

  if (typeof value === 'string') {
    return value.length > maxSize ? value.slice(0, maxSize) : value;
  }

  return value;
}

export default function (logger, voices, wsServer) {
  (appParameters = {
    logger,
    voices,
    wsServer
  });
  log = logger;
  return {
    POST: invocationLogCreate
  };
};

const invocationLogCreate = (async (req, res) => {
  const { userId, organisationId, agentId, instanceId, callId, log: logPayload, subsystem } = req.body;

  if (!userId || !organisationId || !agentId || !instanceId || !callId || !logPayload) {
    return res.status(400).send({
      error: 'Missing required fields: userId, organisationId, agentId, instanceId, callId, log'
    });
  }

  const effectiveSubsystem = subsystem || 'livekit-agent';
  if (effectiveSubsystem !== 'livekit-agent') {
    return res.status(400).send({
      error: 'Invalid subsystem; currently only "livekit-agent" is supported',
    });
  }

  try {
    const prunedLog = pruneJson(logPayload, 512*1024);
    const jsonString = JSON.stringify(prunedLog);
    const compressed = gzipSync(Buffer.from(jsonString, 'utf8')).toString('base64');

    const record = await InvocationLog.create({
      userId,
      organisationId,
      agentId,
      instanceId,
      callId,
      subsystem: effectiveSubsystem,
      log: {
        encoding: 'gzip_base64',
        data: compressed,
      },
    });

    res.status(201).send({
      id: record.id,
      callId: record.callId,
      agentId: record.agentId,
      instanceId: record.instanceId,
      organisationId: record.organisationId,
      userId: record.userId,
      subsystem: record.subsystem,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    });
  } catch (err) {
    log.error(err, 'error creating invocation log');
    res.status(500).send({ error: 'Internal server error' });
  }
});

invocationLogCreate.apiDoc = {
  summary: 'Creates a new compressed invocation log record for a call.',
  description: 'Internal agent-db endpoint used by workers to store compressed pino logs for a single call invocation.',
  operationId: 'createInvocationLog',
  tags: ['Calls'],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          required: ['userId', 'organisationId', 'agentId', 'instanceId', 'callId', 'log'],
          properties: {
            userId: {
              type: 'string',
              description: 'User ID that owns the agent/call',
            },
            organisationId: {
              type: 'string',
              description: 'Organisation ID that owns the agent/call',
            },
            agentId: {
              type: 'string',
              description: 'Agent ID handling this call',
            },
            instanceId: {
              type: 'string',
              description: 'Instance/listener ID handling this call',
            },
            callId: {
              type: 'string',
              description: 'Call ID this invocation log belongs to',
            },
            subsystem: {
              type: 'string',
              description: 'Subsystem that produced this log (currently always "livekit-agent")',
              enum: ['livekit-agent'],
            },
            log: {
              description: 'Raw JSON structure containing the pino logs for this agent run. Will be pruned and compressed server-side.',
              anyOf: [
                { type: 'object' },
                { type: 'array', items: { type: 'object' } },
              ],
            },
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Invocation log created successfully.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string', format: 'uuid' },
              callId: { type: 'string', format: 'uuid' },
              agentId: { type: 'string', format: 'uuid' },
              instanceId: { type: 'string', format: 'uuid' },
              organisationId: { type: 'string' },
              userId: { type: 'string' },
              subsystem: { type: 'string' },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        },
      },
    },
    400: {
      description: 'Bad request - missing required fields',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: { type: 'string' },
            },
          },
        },
      },
    },
  },
};

