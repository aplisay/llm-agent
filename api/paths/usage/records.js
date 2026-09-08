import { UsageRecord, Op } from '../../../lib/database.js';
import { scopeWhereForUser } from '../../../lib/scope.js';
import { requirePermission, can } from '../../../lib/auth/permissions.js';

/**
 * GET /api/usage/records — the ITEMISED usage ledger.
 *
 * `/usage` aggregates: it answers "how much of X did I use", and by construction
 * cannot answer "which one, and why is that one not priced". This returns the
 * individual rows behind those totals, newest first, with the frozen per-line
 * cost breakdown each carries — so a customer (or support) can find the single
 * meter that explains a charge, or the single meter that explains its absence.
 *
 * Scope is the same rule as `/usage`: own-org by default, cross-tenant only for
 * a `usage:readAll` holder.
 *
 * @module api/paths/usage/records
 */

/**
 * Why this row carries no price — the machine-readable half of what the usage
 * screen has to say out loud. `costStatus` alone is not enough: a null status on
 * a row that is still being metered is normal and temporary, while a null status
 * on a finalised row means costing never ran at all, and those must not be shown
 * to a customer as the same thing.
 */
function priceState(row) {
  if (!row.finalised) return 'provisional';
  // cost_micros is a bigint: Sequelize hands it back as a STRING, so compare
  // numerically or every deliberate zero reads as an ordinary charge.
  if (row.costMicros != null && Number(row.costMicros) === 0) return 'included';
  if (row.costMicros != null) return 'priced';
  switch (row.costStatus) {
    case 'no_rate': return 'no_rate';
    case 'no_line': return 'no_line';
    case 'errored': return 'errored';
    default: return 'uncosted';
  }
}

export default function (logger) {
  const get = async (req, res) => {
    if (!requirePermission(res, 'usage', 'read')) return;
    try {
      const {
        startDate, endDate, technology, provider, unit, media, detail,
        agentId, callId, sessionId, costStatus, finalised, priced,
        before, limit = 100,
      } = req.query;

      const scope = can(res.locals.user, 'usage', 'readAll') ? {} : scopeWhereForUser(res.locals.user);
      const and = [scope];

      // The billing instant is the anchor a customer reasons in, but it is null
      // until a row is costed — so bound on it with created_at as the fallback,
      // exactly as the aggregate's period bucket does. Without the COALESCE a
      // date filter would silently drop every uncosted row, which is precisely
      // the population this endpoint exists to show.
      const anchor = UsageRecord.sequelize.literal('COALESCE(billed_at, created_at)');
      if (startDate) and.push(UsageRecord.sequelize.where(anchor, { [Op.gte]: new Date(startDate) }));
      if (endDate) and.push(UsageRecord.sequelize.where(anchor, { [Op.lte]: new Date(endDate) }));

      const where = {};
      if (technology) where.technology = technology;
      if (provider) where.provider = provider;
      if (unit) where.unit = unit;
      if (media) where.media = media;
      if (detail) where.detail = detail;
      if (agentId) where.agentId = agentId;
      if (callId) where.callId = callId;
      if (sessionId) where.sessionId = sessionId;
      if (costStatus) {
        // 'none' selects rows that were never costed at all (status IS NULL) —
        // not expressible as a value, but it is a real and interesting state.
        where.costStatus = costStatus === 'none' ? null : { [Op.in]: String(costStatus).split(',') };
      }
      if (finalised !== undefined && finalised !== null && finalised !== '') {
        where.finalised = finalised === true || finalised === 'true';
      }
      // `priced` is the question a customer actually asks — "show me what I was
      // charged for" / "show me what has no price" — which spans several
      // costStatus values and the finalised flag at once.
      if (priced === true || priced === 'true') where.costMicros = { [Op.gt]: 0 };
      if (priced === false || priced === 'false') where.costMicros = null;

      // Newest first BY THE BILLING INSTANT, which is the only order a ledger
      // can be read in — and not the same as insertion order, because a row
      // costed later can be anchored earlier (a backfill, a call whose meters
      // land after a session's). Ordering by id alone put a July row between two
      // September ones under a column headed "When".
      //
      // `id` breaks ties and makes the cursor total: two rows can share a
      // billing instant to the millisecond, so a cursor on the timestamp alone
      // would either repeat or skip them. The cursor is therefore composite,
      // `<iso>,<id>`, and the predicate is the lexicographic "strictly before"
      // that matches the sort exactly.
      if (before) {
        const [ts, id] = String(before).split(',');
        const at = new Date(ts);
        if (!Number.isNaN(at.getTime())) {
          and.push({
            [Op.or]: [
              UsageRecord.sequelize.where(anchor, { [Op.lt]: at }),
              {
                [Op.and]: [
                  UsageRecord.sequelize.where(anchor, { [Op.eq]: at }),
                  { id: { [Op.lt]: Number(id) || 0 } },
                ],
              },
            ],
          });
        }
      }

      const pageSize = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
      const rows = await UsageRecord.findAll({
        where: { [Op.and]: [...and, where] },
        order: [[anchor, 'DESC'], ['id', 'DESC']],
        limit: pageSize + 1, // one extra row: presence of it IS "there is a next page"
      });

      const page = rows.slice(0, pageSize);
      const records = page.map((r) => ({
        id: String(r.id),
        sessionId: r.sessionId,
        callId: r.callId,
        agentId: r.agentId,
        userId: r.userId,
        technology: r.technology,
        provider: r.provider,
        detail: r.detail,
        unit: r.unit,
        media: r.media,
        quantity: Number(r.quantity) || 0,
        finalised: r.finalised,
        billedAt: r.billedAt,
        createdAt: r.createdAt,
        costMicros: r.costMicros == null ? null : Number(r.costMicros),
        currency: r.currency,
        rateName: r.rateName,
        rateCardStart: r.rateCardStart,
        costStatus: r.costStatus,
        priceState: priceState(r),
        // The frozen per-dimension itemisation costUsageRow stamped — what the
        // customer was actually charged for, line by line. Absent on rows that
        // never matched anything, which is the point.
        costBreakdown: r.metadata?.costBreakdown || null,
      }));

      const tail = page[page.length - 1];
      const cursor = tail
        ? `${new Date(tail.billedAt || tail.createdAt).toISOString()},${tail.id}`
        : false;
      res.send({ records, next: rows.length > pageSize ? cursor : false });
    } catch (error) {
      req.log.error(error, 'error listing usage records');
      res.status(500).send({ error: error.message });
    }
  };

  get.apiDoc = {
    summary: 'The itemised usage ledger — individual meter rows behind the /usage totals.',
    description:
      'Individual `usage_records` rows, newest first, each with its frozen per-dimension cost '
      + 'breakdown and a `priceState` saying why it carries the price it does (or none). '
      + 'Use `/usage` for totals and this for the items behind them. Always scoped to the '
      + "caller's own organisation unless they hold usage:readAll.",
    operationId: 'listUsageRecords',
    tags: ['Usage'],
    parameters: [
      { name: 'startDate', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Inclusive lower bound on the billing instant (billedAt, falling back to createdAt).' },
      { name: 'endDate', in: 'query', schema: { type: 'string', format: 'date-time' }, description: 'Inclusive upper bound on the billing instant.' },
      { name: 'technology', in: 'query', schema: { type: 'string' }, description: "e.g. 'voice', 'llm', 'tts', 'stt', 'stt-aux', 'stt-output'." },
      { name: 'provider', in: 'query', schema: { type: 'string' } },
      { name: 'detail', in: 'query', schema: { type: 'string' }, description: 'Exact model id / voice name.' },
      { name: 'unit', in: 'query', schema: { type: 'string' } },
      { name: 'media', in: 'query', schema: { type: 'string' }, description: 'webrtc | telephony (voice rows).' },
      { name: 'agentId', in: 'query', schema: { type: 'string' } },
      { name: 'callId', in: 'query', schema: { type: 'string' } },
      { name: 'sessionId', in: 'query', schema: { type: 'string' }, description: 'Groups the meters of one call or one chat/builder session.' },
      {
        name: 'costStatus', in: 'query', schema: { type: 'string' },
        description: "Comma-separated: matched | no_rate | no_line | errored, or 'none' for rows never costed at all.",
      },
      { name: 'finalised', in: 'query', schema: { type: 'boolean' }, description: 'true = settled meters only; false = still-metering rows only.' },
      { name: 'priced', in: 'query', schema: { type: 'boolean' }, description: 'true = rows carrying a non-zero charge; false = rows with no price at all.' },
      { name: 'before', in: 'query', schema: { type: 'string' }, description: 'Cursor: pass the previous page\'s `next` verbatim to fetch older rows. Composite (`<iso>,<id>`) because rows can share a billing instant.' },
      { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 500, default: 100 } },
    ],
    responses: {
      200: {
        description: 'A page of itemised usage rows, newest first.',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: {
                records: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      sessionId: { type: 'string' },
                      callId: { type: 'string', nullable: true },
                      agentId: { type: 'string', nullable: true },
                      userId: { type: 'string', nullable: true },
                      technology: { type: 'string' },
                      provider: { type: 'string', nullable: true },
                      detail: { type: 'string', nullable: true },
                      unit: { type: 'string' },
                      media: { type: 'string', nullable: true },
                      quantity: { type: 'number' },
                      finalised: { type: 'boolean' },
                      billedAt: { type: 'string', format: 'date-time', nullable: true },
                      createdAt: { type: 'string', format: 'date-time' },
                      costMicros: { type: 'number', nullable: true },
                      currency: { type: 'string', nullable: true },
                      rateName: { type: 'string', nullable: true },
                      rateCardStart: { type: 'string', format: 'date-time', nullable: true },
                      costStatus: { type: 'string', nullable: true },
                      priceState: {
                        type: 'string',
                        enum: ['priced', 'included', 'provisional', 'no_rate', 'no_line', 'errored', 'uncosted'],
                        description:
                          'priced = charged; included = deliberately zero-rated (bundled into another line); '
                          + 'provisional = still metering, not yet costed by design; no_rate = no card covered '
                          + 'the billing instant; no_line = the card priced no dimension of this row; '
                          + 'errored = costing threw and will be retried; uncosted = finalised but never valued.',
                      },
                      costBreakdown: { type: 'array', nullable: true, items: { type: 'object' } },
                    },
                  },
                },
                next: {
                  oneOf: [{ type: 'string' }, { type: 'boolean' }],
                  description: 'Cursor for the next (older) page, or false when this is the last one.',
                },
              },
            },
          },
        },
      },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get };
}
