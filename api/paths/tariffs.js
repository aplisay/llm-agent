import { Tariff, TariffPrefix, Sequelize } from '../../lib/database.js';
import { requirePermission } from '../../lib/auth/permissions.js';
import { validateTariffInput } from '../../lib/tariffs.js';

/**
 * /api/tariffs (collection) — the named, date-ranged destination prefix decks
 * (Phase D billing) a rate card's `destination` line links to by name. Global
 * platform config, gated on the `tariff` resource (superAdmin). Per-name
 * non-overlap + immutable-once-referenced are enforced in the model / item route.
 *   GET   list tariff versions (optional ?name=), each with a prefixCount.
 *   POST  create a version with its prefix deck (supersede a name with a later startDate).
 */
export default function (logger) {
  const list = async (req, res) => {
    if (!requirePermission(res, 'tariff', 'read')) return;
    try {
      const where = req.query?.name ? { name: req.query.name } : {};
      const tariffs = await Tariff.findAll({
        where,
        attributes: {
          include: [[
            Sequelize.literal('(SELECT COUNT(*) FROM tariff_prefixes WHERE tariff_prefixes.tariff_id = "Tariff".id)'),
            'prefixCount',
          ]],
        },
        order: [['name', 'ASC'], ['startDate', 'ASC']],
      });
      return res.send({ tariffs });
    } catch (err) {
      req.log.error(err, 'listing tariffs');
      return res.status(500).send({ error: err.message });
    }
  };
  list.apiDoc = {
    summary: 'List destination tariffs (super admin).',
    operationId: 'listTariffs',
    tags: ['Tariffs'],
    parameters: [{ in: 'query', name: 'name', required: false, schema: { type: 'string' }, description: 'Filter to one tariff name (its full interval history).' }],
    responses: {
      200: { description: 'Tariffs (each with prefixCount)' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const create = async (req, res) => {
    if (!requirePermission(res, 'tariff', 'create')) return;
    const {
      name, startDate, endDate = null, currency = 'gbp', defaultCountry = 'GB',
      timezone = 'Europe/London', schedule = {}, callStartMicros = 0, roundingSeconds = 6,
      description = null, prefixes = [],
    } = req.body || {};
    const err = validateTariffInput({ name, startDate, defaultCountry, timezone, schedule, callStartMicros, roundingSeconds, prefixes });
    if (err) return res.status(400).send({ message: err });
    try {
      const created = await Tariff.sequelize.transaction(async (transaction) => {
        const tariff = await Tariff.create({
          name, startDate, endDate, currency, defaultCountry, timezone, schedule,
          callStartMicros: Math.round(Number(callStartMicros) || 0),
          roundingSeconds: Math.round(Number(roundingSeconds) || 6),
          description,
          createdBy: res.locals.user?.id ?? null,
        }, { transaction });
        if (prefixes.length) {
          await TariffPrefix.bulkCreate(
            prefixes.map((p) => ({
              tariffId: tariff.id,
              prefix: String(p.prefix),
              connectMicros: Math.round(Number(p.connectMicros) || 0),
              peakPerMinuteMicros: Math.round(Number(p.peakPerMinuteMicros) || 0),
              offPeakPerMinuteMicros: Math.round(Number(p.offPeakPerMinuteMicros) || 0),
              minimumMicros: Math.round(Number(p.minimumMicros) || 0),
              label: p.label ?? null,
            })),
            { transaction },
          );
        }
        return tariff;
      });
      const withPrefixes = await Tariff.findByPk(created.id, {
        include: [{ model: TariffPrefix, as: 'prefixes' }],
      });
      return res.status(201).send(withPrefixes);
    } catch (e) {
      if (e?.name === 'SequelizeExclusionConstraintError' || e?.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).send({ message: `A tariff for "${name}" already covers that period; supersede with a later startDate.` });
      }
      req.log.error(e, 'creating tariff');
      return res.status(400).send({ message: e?.message || 'Failed to create tariff' });
    }
  };
  create.apiDoc = {
    summary: 'Create a destination tariff with its prefix deck (super admin).',
    operationId: 'createTariff',
    tags: ['Tariffs'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['name', 'startDate'],
            properties: {
              name: { type: 'string', description: 'Tariff name a rate card destination line references.' },
              startDate: { type: 'string', format: 'date-time' },
              endDate: { type: 'string', format: 'date-time', nullable: true },
              currency: { type: 'string', default: 'gbp' },
              defaultCountry: { type: 'string', default: 'GB', description: 'ISO-3166 alpha-2 home country for normalising local-format numbers.' },
              timezone: { type: 'string', default: 'Europe/London', description: 'IANA timezone the peak schedule is evaluated in.' },
              schedule: { type: 'object', description: 'Per-weekday peak window { mon:{start,end}|null, ... }; off-peak is the complement.' },
              callStartMicros: { type: 'integer', default: 0, description: 'Flat per-call start cost (micro-pence) on every billed call.' },
              roundingSeconds: { type: 'integer', default: 6, description: 'Duration round-up granularity (seconds).' },
              description: { type: 'string', nullable: true },
              prefixes: {
                type: 'array',
                description: 'Prefix deck: each { prefix (intl digits), connectMicros, peakPerMinuteMicros, offPeakPerMinuteMicros, minimumMicros, label? } — micro-pence.',
                items: {
                  type: 'object',
                  required: ['prefix'],
                  properties: {
                    prefix: { type: 'string' },
                    connectMicros: { type: 'integer', default: 0 },
                    peakPerMinuteMicros: { type: 'integer', default: 0 },
                    offPeakPerMinuteMicros: { type: 'integer', default: 0 },
                    minimumMicros: { type: 'integer', default: 0 },
                    label: { type: 'string', nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      201: { description: 'Created tariff (with prefixes)' },
      400: { description: 'Invalid', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      409: { description: 'Overlaps an existing tariff for this name' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: list, POST: create };
}
