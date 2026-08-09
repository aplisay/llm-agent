import { fn, col, Op } from 'sequelize';
import { ChatSession, UsageRecord } from '../../lib/database.js';
import { scopeWhereForUser } from '../../lib/scope.js';
import { requirePermission } from '../../lib/auth/permissions.js';

let log;

export default function (logger) {
  log = logger;
  return {
    GET: listChatSessions,
  };
}

/**
 * Aggregate LLM token usage (and any resolved cost) for a page of chat
 * sessions in one query — usage_records keys on the same session id.
 */
async function usageBySession(ids) {
  if (!ids.length) return {};
  const rows = await UsageRecord.findAll({
    attributes: [
      [col('session_id'), 'sessionId'],
      [col('unit'), 'unit'],
      [fn('SUM', col('quantity')), 'quantity'],
      [fn('SUM', col('cost_micros')), 'costMicros'],
      [fn('MAX', col('currency')), 'currency'],
    ],
    where: { sessionId: { [Op.in]: ids }, technology: 'llm' },
    group: [col('session_id'), col('unit')],
    raw: true,
  });
  const UNIT_KEYS = {
    input_tokens: 'inputTokens',
    output_tokens: 'outputTokens',
    cache_read_tokens: 'cacheReadTokens',
    cache_write_tokens: 'cacheWriteTokens',
  };
  const out = {};
  for (const r of rows) {
    const key = UNIT_KEYS[r.unit];
    if (!key) continue;
    const entry = (out[r.sessionId] = out[r.sessionId] || {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costMicros: 0, currency: null,
    });
    entry[key] = Number(r.quantity) || 0;
    entry.costMicros += Number(r.costMicros) || 0;
    entry.currency = entry.currency || r.currency || null;
  }
  return out;
}

/**
 * GET /chat-sessions — the builder session history: persisted interactive
 * chat sessions in the caller's scope, newest first, each with its aggregated
 * LLM token usage. Filter by the agent set worked on (`setId`) or the chat
 * agent itself (`agentId`). Transcripts are NOT included here — fetch one
 * session for its transcript.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const listChatSessions = async (req, res) => {
  if (!requirePermission(res, 'agent', 'read')) return;
  try {
    const { setId, agentId } = req.query;
    // set_id is a uuid column — a malformed value would 500 on the Postgres
    // cast; reject it as the client error it is. (agentId is a string column.)
    if (setId && !UUID_RE.test(String(setId))) {
      return res.status(400).send({ message: 'setId must be a UUID' });
    }
    const limit = Math.max(1, Math.min(parseInt(req.query.limit) || 20, 100));
    const offset = Math.max(0, parseInt(req.query.offset) || 0);
    const where = {
      ...scopeWhereForUser(res.locals.user),
      ...(setId ? { setId } : {}),
      ...(agentId ? { agentId } : {}),
    };
    const { count, rows } = await ChatSession.findAndCountAll({
      attributes: ['id', 'agentId', 'setId', 'mode', 'title', 'modelName', 'startedAt', 'endedAt', 'turns'],
      where,
      order: [['startedAt', 'DESC']],
      limit,
      offset,
    });
    const usage = await usageBySession(rows.map((r) => r.id));
    res.send({
      sessions: rows.map((r) => ({ ...r.get({ plain: true }), usage: usage[r.id] || null })),
      total: count,
    });
  } catch (error) {
    req.log.error(error);
    res.status(500).send({ error: error.message });
  }
};

listChatSessions.apiDoc = {
  summary: 'List persisted interactive chat sessions (builder session history)',
  description:
    'Returns the caller\'s persisted text-agent chat sessions, newest first, each with aggregated LLM '
    + 'token usage joined from the usage ledger. Filter by the agent set the session worked on (`setId`) '
    + 'or by the chat agent (`agentId`). Transcripts are returned by GET /chat-sessions/{sessionId} only.',
  operationId: 'listChatSessions',
  tags: ['Agent'],
  parameters: [
    { in: 'query', name: 'setId', required: false, schema: { type: 'string' }, description: 'Only sessions that worked on this agent set' },
    { in: 'query', name: 'agentId', required: false, schema: { type: 'string' }, description: 'Only sessions chatted with this agent (e.g. the org builder)' },
    { in: 'query', name: 'limit', required: false, schema: { type: 'integer', default: 20, maximum: 100 } },
    { in: 'query', name: 'offset', required: false, schema: { type: 'integer', default: 0 } },
  ],
  responses: {
    200: {
      description: 'Sessions in scope, newest first.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              total: { type: 'integer' },
              sessions: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    agentId: { type: 'string', nullable: true },
                    setId: { type: 'string', nullable: true },
                    mode: { type: 'string', nullable: true, description: "'new' | 'edit' | 'troubleshoot'" },
                    title: { type: 'string', nullable: true },
                    modelName: { type: 'string', nullable: true },
                    startedAt: { type: 'string', format: 'date-time' },
                    endedAt: { type: 'string', format: 'date-time', nullable: true },
                    turns: { type: 'integer' },
                    usage: {
                      type: 'object',
                      nullable: true,
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
