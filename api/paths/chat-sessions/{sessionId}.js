import { fn, col } from 'sequelize';
import { ChatSession, UsageRecord } from '../../../lib/database.js';
import { scopeWhereForUser } from '../../../lib/scope.js';
import { requirePermission } from '../../../lib/auth/permissions.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: getChatSession,
  };
}

/**
 * GET /chat-sessions/{sessionId} — one persisted chat session, including its
 * transcript and aggregated LLM token usage. Scoped to the caller.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const getChatSession = async (req, res) => {
  if (!requirePermission(res, 'agent', 'read')) return;
  const { sessionId } = req.params;
  // id is a uuid column — a malformed value would 500 on the Postgres cast;
  // for a GET-by-id that's simply "no such session".
  if (!UUID_RE.test(String(sessionId))) {
    return res.status(404).send({ message: `Chat session ${sessionId} not found` });
  }
  try {
    const session = await ChatSession.findOne({
      where: { id: sessionId, ...scopeWhereForUser(res.locals.user) },
    });
    if (!session) {
      return res.status(404).send({ message: `Chat session ${sessionId} not found` });
    }
    const rows = await UsageRecord.findAll({
      attributes: [
        [col('unit'), 'unit'],
        [fn('SUM', col('quantity')), 'quantity'],
        [fn('SUM', col('cost_micros')), 'costMicros'],
        [fn('MAX', col('currency')), 'currency'],
      ],
      where: { sessionId, technology: 'llm' },
      group: [col('unit')],
      raw: true,
    });
    const UNIT_KEYS = {
      input_tokens: 'inputTokens',
      output_tokens: 'outputTokens',
      cache_read_tokens: 'cacheReadTokens',
      cache_write_tokens: 'cacheWriteTokens',
    };
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, currency: null };
    for (const r of rows) {
      const key = UNIT_KEYS[r.unit];
      if (!key) continue;
      usage[key] = Number(r.quantity) || 0;
      usage.costMicros += Number(r.costMicros) || 0;
      usage.currency = usage.currency || r.currency || null;
    }
    res.send({ ...session.get({ plain: true }), usage });
  } catch (error) {
    req.log.error(error);
    res.status(500).send({ error: error.message });
  }
};

getChatSession.apiDoc = {
  summary: 'Fetch one persisted chat session, including its transcript',
  description:
    'Returns a single persisted text-agent chat session in the caller\'s scope, with the recorded '
    + 'transcript ([{role, text, at}]) and aggregated LLM token usage from the usage ledger.',
  operationId: 'getChatSession',
  tags: ['Agent'],
  parameters: [
    { in: 'path', name: 'sessionId', required: true, schema: { type: 'string' } },
  ],
  responses: {
    200: {
      description: 'The chat session.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              agentId: { type: 'string', nullable: true },
              setId: { type: 'string', nullable: true },
              mode: { type: 'string', nullable: true },
              title: { type: 'string', nullable: true },
              modelName: { type: 'string', nullable: true },
              startedAt: { type: 'string', format: 'date-time' },
              endedAt: { type: 'string', format: 'date-time', nullable: true },
              turns: { type: 'integer' },
              transcript: {
                type: 'array',
                nullable: true,
                items: {
                  type: 'object',
                  properties: {
                    role: { type: 'string' },
                    text: { type: 'string' },
                    at: { type: 'string' },
                  },
                },
              },
              usage: {
                type: 'object',
                properties: {
                  inputTokens: { type: 'integer' },
                  outputTokens: { type: 'integer' },
                  cacheReadTokens: { type: 'integer' },
                  cacheWriteTokens: { type: 'integer' },
                  costMicros: { type: 'integer' },
                  currency: { type: 'string', nullable: true },
                },
              },
            },
          },
        },
      },
    },
    404: {
      description: 'No such session in the caller\'s scope.',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
        },
      },
    },
    default: {
      description: 'Error',
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Error' },
        },
      },
    },
  },
};
