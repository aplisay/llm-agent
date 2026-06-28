import { recordUsageBatch } from '../../../lib/usage.js';

/**
 * Internal agent-db endpoint used by the out-of-process workers (LiveKit,
 * Pipecat) and any other producer to post metered consumption into the usage
 * ledger. Accepts a single record or `{ records: [...] }`. Gated by
 * `x-shared-token` in middleware/auth.js like every other /api/agent-db route.
 */

let log;

export default function (logger) {
  log = logger;
  return {
    POST: usageCreate,
  };
}

function validateRecord(record) {
  const errors = [];
  if (!record || typeof record !== 'object') {
    return ['record must be an object'];
  }
  if (!record.sessionId && !record.callId) errors.push('sessionId or callId is required');
  if (!record.technology) errors.push('technology is required');
  if (!record.unit) errors.push('unit is required');
  if (
    record.quantity === undefined
    || record.quantity === null
    || Number.isNaN(Number(record.quantity))
  ) {
    errors.push('quantity (number) is required');
  }
  if (!record.organisationId) errors.push('organisationId is required');
  if (!record.userId) errors.push('userId is required');
  if (record.mode && !['set', 'increment'].includes(record.mode)) {
    errors.push("mode must be 'set' or 'increment'");
  }
  return errors;
}

const usageCreate = async (req, res) => {
  const body = req.body || {};
  const incoming = Array.isArray(body.records) ? body.records : [body];

  if (!incoming.length) {
    return res.status(400).send({ error: 'No usage records provided' });
  }

  const invalid = [];
  incoming.forEach((record, index) => {
    const errors = validateRecord(record);
    if (errors.length) invalid.push({ index, errors });
  });
  if (invalid.length) {
    return res.status(400).send({ error: 'Invalid usage record(s)', details: invalid });
  }

  try {
    const results = await recordUsageBatch(incoming, { log });
    const recorded = results.filter(Boolean);
    return res.status(201).send({
      recorded: recorded.length,
      skipped: results.length - recorded.length,
      records: recorded.map((r) => ({
        id: String(r.id),
        sessionId: r.sessionId,
        technology: r.technology,
        provider: r.provider,
        detail: r.detail,
        unit: r.unit,
        quantity: Number(r.quantity),
        finalised: r.finalised,
      })),
    });
  } catch (err) {
    log.error(err, 'error recording usage');
    return res.status(500).send({ error: 'Internal server error' });
  }
};

const usageRecordProps = {
  sessionId: { type: 'string', description: 'Session grouping key. Defaults to callId when omitted.' },
  callId: { type: 'string', format: 'uuid', description: 'Originating call id (omit for headless text agents).' },
  organisationId: { type: 'string', description: 'Organisation that owns the session.' },
  userId: { type: 'string', description: 'User that owns the session.' },
  agentId: { type: 'string', format: 'uuid', description: 'Agent that consumed the units.' },
  technology: { type: 'string', description: "Broad category: 'llm' | 'tts' | 'stt' | 'voice' | 'function' …" },
  provider: { type: 'string', description: "Vendor, e.g. 'anthropic' | 'openai' | 'elevenlabs' | 'deepgram'." },
  detail: { type: 'string', description: "Detailed model/technology name, e.g. 'claude-opus-4-8' | 'eleven_turbo_v2'." },
  unit: { type: 'string', description: "Unit of measure: 'input_tokens' | 'output_tokens' | 'characters' | 'milliseconds' | 'invocations' …" },
  quantity: { type: 'number', description: 'Cumulative total (mode=set) or delta (mode=increment).' },
  finalised: { type: 'boolean', description: 'Mark the meter final for the session.' },
  mode: { type: 'string', enum: ['set', 'increment'], description: 'Replace (set, default) or add (increment) the stored quantity.' },
  metadata: { type: 'object', description: 'Optional context (raw provider usage blob, function args, …).' },
};

usageCreate.apiDoc = {
  summary: 'Records one or more usage meters for agent sessions.',
  description:
    'Internal agent-db endpoint. Accepts a single usage record (record fields at '
    + 'the top level) or a batch via `{ "records": [...] }`. Each record upserts a '
    + 'meter keyed on (sessionId, technology, provider, detail, unit): mode "set" '
    + 'replaces the stored quantity with a cumulative total, mode "increment" adds a '
    + 'delta. Set `finalised: true` when the count is complete for the session.',
  operationId: 'createUsageRecords',
  tags: ['Usage'],
  requestBody: {
    required: true,
    content: {
      'application/json': {
        schema: {
          type: 'object',
          properties: {
            records: {
              type: 'array',
              description: 'Batch form: an array of usage records.',
              items: { type: 'object', properties: usageRecordProps },
            },
            ...usageRecordProps,
          },
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Usage records created/updated successfully.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              recorded: { type: 'integer' },
              skipped: { type: 'integer' },
              records: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    sessionId: { type: 'string' },
                    technology: { type: 'string' },
                    provider: { type: 'string', nullable: true },
                    detail: { type: 'string', nullable: true },
                    unit: { type: 'string' },
                    quantity: { type: 'number' },
                    finalised: { type: 'boolean' },
                  },
                },
              },
            },
          },
        },
      },
    },
    400: {
      description: 'Bad request - missing or invalid fields',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              error: { type: 'string' },
              details: { type: 'array', items: { type: 'object' } },
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
            properties: { error: { type: 'string' } },
          },
        },
      },
    },
  },
};
