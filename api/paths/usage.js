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
  media: 'media',
  currency: 'currency',
  rateName: 'rateName',
  costStatus: 'costStatus',
  agent: 'agentId',
  user: 'userId',
  call: 'callId',
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
    let { startDate, endDate, groupBy, period, technology, provider, unit, callId, finalised } = req.query;

    const requested = (groupBy ? String(groupBy).split(',') : DEFAULT_GROUP_BY)
      .map((d) => d.trim())
      .filter((d) => DIMENSIONS[d]);
    const dimensions = (requested.length ? requested : DEFAULT_GROUP_BY).map((d) => DIMENSIONS[d]);

    // Time bucketing on the billing instant (billedAt), the canonical period
    // anchor — falling back to created_at for rows not yet costed (billedAt null).
    const billedAtCol = Sequelize.fn('COALESCE', Sequelize.col('billed_at'), Sequelize.col('created_at'));
    const periodBucket = ['day', 'week', 'month'].includes(period)
      ? Sequelize.fn('date_trunc', period, billedAtCol)
      : null;

    const attributes = [
      ...dimensions,
      ...(periodBucket ? [[periodBucket, 'period']] : []),
      [Sequelize.fn('SUM', Sequelize.col('quantity')), 'quantity'],
      [Sequelize.fn('COUNT', Sequelize.col('id')), 'meters'],
      // Frozen cost (micro-pence) summed, plus an EXPLICIT count of rows not yet
      // costed (cost_micros IS NULL) so a consumer never mistakes "uncosted" for
      // "free" — a partial total is visibly partial.
      [Sequelize.fn('SUM', Sequelize.col('cost_micros')), 'costMicros'],
      [Sequelize.literal('COUNT(*) FILTER (WHERE cost_micros IS NULL)'), 'uncostedMeters'],
      // The quantity `costMicros` is actually the price OF. Without this a
      // bucket mixing costed and uncosted rows reports a total quantity beside a
      // cost that only covers part of it, and the two silently disagree — e.g.
      // "238,897 input tokens · £0.05" where 21,451 of those tokens are on a
      // row that has never been valued.
      [Sequelize.literal('COALESCE(SUM(quantity) FILTER (WHERE cost_micros IS NOT NULL), 0)'), 'costedQuantity'],
      // Rows still being metered (an open call, a live builder session — or a
      // session abandoned before its teardown ran). Their totals are PROVISIONAL
      // and by design not yet costed, which is a different fact from "we have no
      // price for this" and must not be presented as the same thing.
      [Sequelize.literal('COUNT(*) FILTER (WHERE NOT finalised)'), 'provisionalMeters'],
      [Sequelize.literal('COALESCE(SUM(quantity) FILTER (WHERE NOT finalised), 0)'), 'provisionalQuantity'],
      // Priced deliberately at zero — a bundled/included meter (realtime speech
      // charged by the model minute), NOT an unpriced one. Counted so a consumer
      // can present it as "included" instead of listing £0.00 lines.
      [Sequelize.literal('COUNT(*) FILTER (WHERE cost_micros = 0)'), 'zeroRatedMeters'],
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
    if (callId) where.callId = callId;
    // Default is UNCHANGED (every row, provisional included) so existing callers
    // keep the totals they have; `finalised=true` is how a caller asks for only
    // the settled ledger.
    if (finalised !== undefined && finalised !== null && finalised !== '') {
      where.finalised = finalised === true || finalised === 'true';
    }

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
      // costMicros is null (not 0) when NO row in the bucket is costed, so a
      // consumer can distinguish "priced at zero" from "not yet priced".
      costMicros: row.costMicros == null ? null : Number(row.costMicros),
      uncostedMeters: Number(row.uncostedMeters) || 0,
      costedQuantity: Number(row.costedQuantity) || 0,
      provisionalMeters: Number(row.provisionalMeters) || 0,
      provisionalQuantity: Number(row.provisionalQuantity) || 0,
      zeroRatedMeters: Number(row.zeroRatedMeters) || 0,
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
        + 'media, currency, rateName, costStatus, agent, user, call. Defaults to '
        + '"technology,provider,detail,unit". media (webrtc/telephony) is the audio '
        + 'transport on voice rows; rateName/currency identify the card that valued the row; '
        + 'costStatus says WHY a row is unpriced (matched | no_rate | no_line | errored | null).',
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
    {
      name: 'callId', in: 'query', required: false,
      schema: { type: 'string' },
      description: 'Filter to a single call id (the per-call usage breakdown).',
    },
    {
      name: 'finalised', in: 'query', required: false,
      schema: { type: 'boolean' },
      description:
        'Filter on meter completeness. Omitted (the default) returns EVERY row, '
        + 'provisional ones included, which is the historical behaviour. Pass true for '
        + 'the settled ledger only — the totals that can be reconciled against a cost.',
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
                    media: { type: 'string', nullable: true, description: 'Audio transport (webrtc/telephony) on voice rows.' },
                    currency: { type: 'string', nullable: true },
                    rateName: { type: 'string', nullable: true, description: 'Rate card that valued the row.' },
                    agentId: { type: 'string', nullable: true },
                    userId: { type: 'string', nullable: true },
                    period: { type: 'string', format: 'date-time', nullable: true, description: 'Bucket on billedAt (the billing instant), not created_at.' },
                    quantity: { type: 'number' },
                    meters: { type: 'number', description: 'Number of ledger rows aggregated.' },
                    costMicros: { type: 'number', nullable: true, description: 'Summed frozen cost in micro-pence; null when no row in the bucket is yet costed.' },
                    costStatus: { type: 'string', nullable: true, description: 'Costing outcome, when grouped by it: matched | no_rate (no card covered the billing instant) | no_line (the card priced no dimension of this row) | errored | null (never costed).' },
                    uncostedMeters: { type: 'number', description: 'Rows in the bucket with no cost yet (cost_micros IS NULL) — a partial total is visibly partial.' },
                    costedQuantity: { type: 'number', description: 'The quantity costMicros is the price OF. Equals quantity only when every row in the bucket is costed; the gap is what the cost does not cover.' },
                    provisionalMeters: { type: 'number', description: 'Rows still being metered (finalised = false): an open call or live session. Their totals are provisional and not yet costed BY DESIGN — distinct from having no price.' },
                    provisionalQuantity: { type: 'number', description: 'Quantity carried by those provisional rows.' },
                    zeroRatedMeters: { type: 'number', description: 'Rows priced deliberately at zero (cost_micros = 0) — a bundled/included meter, not an unpriced one.' },
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
