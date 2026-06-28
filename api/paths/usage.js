import { UsageRecord, Sequelize, Op } from '../../lib/database.js';
import { scopeWhereForUser } from '../../lib/scope.js';
import { requirePermission, can } from '../../lib/auth/permissions.js';

let log;

// Meter dimensions a caller may group by, mapped to the model attribute.
const DIMENSIONS = {
  technology: 'technology',
  provider: 'provider',
  detail: 'detail',
  unit: 'unit',
  agent: 'agentId',
  user: 'userId',
};
const DEFAULT_GROUP_BY = ['technology', 'provider', 'detail', 'unit'];

export default function (logger) {
  log = logger;
  return {
    GET: getUsage,
  };
}

const getUsage = async (req, res) => {
  if (!requirePermission(res, 'usage', 'read')) return;
  try {
    let { startDate, endDate, groupBy, period, technology, provider, unit } = req.query;

    const requested = (groupBy ? String(groupBy).split(',') : DEFAULT_GROUP_BY)
      .map((d) => d.trim())
      .filter((d) => DIMENSIONS[d]);
    const dimensions = (requested.length ? requested : DEFAULT_GROUP_BY).map((d) => DIMENSIONS[d]);

    // Optional time bucketing via date_trunc on created_at.
    const periodBucket = ['day', 'week', 'month'].includes(period)
      ? Sequelize.fn('date_trunc', period, Sequelize.col('created_at'))
      : null;

    const attributes = [
      ...dimensions,
      ...(periodBucket ? [[periodBucket, 'period']] : []),
      [Sequelize.fn('SUM', Sequelize.col('quantity')), 'quantity'],
      [Sequelize.fn('COUNT', Sequelize.col('id')), 'meters'],
    ];
    const group = [...dimensions, ...(periodBucket ? [periodBucket] : [])];

    // Own-org by default; a usage:readAll holder (support / superAdmin) sees
    // cross-tenant usage (the one admin-surface read that is NOT own-org-only).
    const usageScope = can(res.locals.user, 'usage', 'readAll') ? {} : scopeWhereForUser(res.locals.user);
    const where = { [Op.and]: [usageScope] };
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt[Op.gte] = new Date(startDate);
      if (endDate) where.createdAt[Op.lte] = new Date(endDate);
    }
    if (technology) where.technology = technology;
    if (provider) where.provider = provider;
    if (unit) where.unit = unit;

    const rows = await UsageRecord.findAll({
      attributes,
      where,
      group,
      order: dimensions.map((d) => [d, 'ASC']),
      raw: true,
    });

    const usage = rows.map((row) => ({
      ...row,
      quantity: Number(row.quantity) || 0,
      meters: Number(row.meters) || 0,
    }));

    res.send({ usage });
  } catch (error) {
    req.log.error(error, 'error aggregating usage');
    res.status(500).send({ error: error.message });
  }
};

getUsage.apiDoc = {
  summary: 'Aggregated usage for the authenticated user / organisation.',
  description:
    'Returns summed usage (tokens, characters, minutes, invocations) from the usage '
    + 'ledger, grouped by the requested meter dimensions and optionally bucketed by '
    + 'time. Always scoped to the caller — you only ever see your own or your '
    + "organisation's usage.",
  operationId: 'getUsage',
  tags: ['Usage'],
  parameters: [
    {
      name: 'startDate', in: 'query', required: false,
      schema: { type: 'string', format: 'date-time' },
      description: 'Inclusive lower bound on createdAt (ISO 8601).',
    },
    {
      name: 'endDate', in: 'query', required: false,
      schema: { type: 'string', format: 'date-time' },
      description: 'Inclusive upper bound on createdAt (ISO 8601).',
    },
    {
      name: 'groupBy', in: 'query', required: false,
      schema: { type: 'string' },
      description:
        'Comma-separated dimensions to group by: technology, provider, detail, unit, '
        + 'agent, user. Defaults to "technology,provider,detail,unit".',
    },
    {
      name: 'period', in: 'query', required: false,
      schema: { type: 'string', enum: ['day', 'week', 'month'] },
      description: 'Optional time bucket (date_trunc on createdAt).',
    },
    {
      name: 'technology', in: 'query', required: false,
      schema: { type: 'string' },
      description: "Filter to a single technology (e.g. 'llm', 'tts', 'voice').",
    },
    {
      name: 'provider', in: 'query', required: false,
      schema: { type: 'string' }, description: 'Filter to a single provider.',
    },
    {
      name: 'unit', in: 'query', required: false,
      schema: { type: 'string' }, description: 'Filter to a single unit.',
    },
  ],
  responses: {
    200: {
      description: 'Aggregated usage rows.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              usage: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    technology: { type: 'string' },
                    provider: { type: 'string', nullable: true },
                    detail: { type: 'string', nullable: true },
                    unit: { type: 'string' },
                    agentId: { type: 'string', nullable: true },
                    userId: { type: 'string', nullable: true },
                    period: { type: 'string', format: 'date-time', nullable: true },
                    quantity: { type: 'number' },
                    meters: { type: 'number', description: 'Number of ledger rows aggregated.' },
                  },
                },
              },
            },
            example: {
              usage: [
                { technology: 'llm', provider: 'anthropic', detail: 'claude-opus-4-8', unit: 'input_tokens', quantity: 18234, meters: 12 },
                { technology: 'llm', provider: 'anthropic', detail: 'claude-opus-4-8', unit: 'output_tokens', quantity: 4120, meters: 12 },
                { technology: 'tts', provider: 'elevenlabs', detail: 'eleven_turbo_v2', unit: 'characters', quantity: 9043, meters: 12 },
                { technology: 'voice', provider: 'livekit', detail: 'livekit:ultravox:ultravox-70b', unit: 'milliseconds', quantity: 600000, meters: 10 },
              ],
            },
          },
        },
      },
    },
    500: {
      description: 'Internal server error',
      content: {
        'application/json': {
          schema: { type: 'object', properties: { error: { type: 'string' } } },
        },
      },
    },
  },
};
