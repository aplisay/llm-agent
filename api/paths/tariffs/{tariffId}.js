import { Tariff, TariffPrefix } from '../../../lib/database.js';
import { requirePermission } from '../../../lib/auth/permissions.js';
import { validateTariffInput, isTariffReferenced } from '../../../lib/tariffs.js';

/**
 * /api/tariffs/{tariffId} (item) — superAdmin (`tariff` resource).
 *   GET    fetch one tariff + its prefix deck.
 *   PUT    edit a tariff (header + replace deck). Blocked (409) once the tariff is
 *          referenced by costed usage — supersede with a new dated tariff instead.
 *   DELETE remove a tariff (cascade prefixes) — blocked (409) once referenced.
 */
export default function (logger) {
  const findTariff = async (req, res) => {
    const tariff = await Tariff.findByPk(req.params.tariffId, {
      include: [{ model: TariffPrefix, as: 'prefixes' }],
      order: [[{ model: TariffPrefix, as: 'prefixes' }, 'prefix', 'ASC']],
    });
    if (!tariff) {
      res.status(404).send({ message: `Tariff ${req.params.tariffId} not found` });
      return null;
    }
    return tariff;
  };

  const get = async (req, res) => {
    if (!requirePermission(res, 'tariff', 'read')) return;
    const tariff = await findTariff(req, res);
    if (tariff) res.send(tariff);
  };
  get.apiDoc = {
    summary: 'Get a destination tariff with its prefix deck (super admin).',
    operationId: 'getTariff',
    tags: ['Tariffs'],
    parameters: [{ in: 'path', name: 'tariffId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Tariff with prefixes' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const update = async (req, res) => {
    if (!requirePermission(res, 'tariff', 'update')) return;
    const tariff = await findTariff(req, res);
    if (!tariff) return;

    const body = req.body || {};
    const hasPrefixes = Array.isArray(body.prefixes);
    // Validate whatever is being changed (header fields fall back to current).
    const err = validateTariffInput({
      name: body.name ?? tariff.name,
      startDate: body.startDate ?? tariff.startDate,
      defaultCountry: body.defaultCountry ?? tariff.defaultCountry,
      timezone: body.timezone ?? tariff.timezone,
      schedule: body.schedule ?? tariff.schedule,
      callStartMicros: body.callStartMicros ?? tariff.callStartMicros,
      roundingSeconds: body.roundingSeconds ?? tariff.roundingSeconds,
      prefixes: hasPrefixes ? body.prefixes : null,
    });
    if (err) return res.status(400).send({ message: err });

    // Immutable once referenced — a price change is a new dated tariff. (The model
    // beforeUpdate hook also guards header pricing fields; this also covers a
    // deck-only replace, which the hook would not see.)
    if (await isTariffReferenced(tariff)) {
      return res.status(409).send({
        message: `Tariff "${tariff.name}" is referenced by costed usage and cannot be edited; supersede it with a new tariff (later startDate).`,
      });
    }

    const EDITABLE = ['name', 'startDate', 'endDate', 'currency', 'defaultCountry', 'timezone', 'schedule', 'callStartMicros', 'roundingSeconds', 'description'];
    try {
      await Tariff.sequelize.transaction(async (transaction) => {
        for (const k of EDITABLE) if (k in body) tariff[k] = body[k];
        await tariff.save({ transaction });
        if (hasPrefixes) {
          await TariffPrefix.destroy({ where: { tariffId: tariff.id }, transaction });
          if (body.prefixes.length) {
            await TariffPrefix.bulkCreate(
              body.prefixes.map((p) => ({
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
        }
      });
      const fresh = await Tariff.findByPk(tariff.id, { include: [{ model: TariffPrefix, as: 'prefixes' }] });
      return res.send(fresh);
    } catch (e) {
      if (/immutable once referenced/.test(e?.message || '')) {
        return res.status(409).send({ message: e.message });
      }
      if (e?.name === 'SequelizeExclusionConstraintError' || e?.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).send({ message: 'That change overlaps another tariff for this name.' });
      }
      req.log.error(e, 'updating tariff');
      return res.status(400).send({ message: e?.message || 'Failed to update tariff' });
    }
  };
  update.apiDoc = {
    summary: 'Update a destination tariff (super admin; immutable once referenced).',
    operationId: 'updateTariff',
    tags: ['Tariffs'],
    parameters: [{ in: 'path', name: 'tariffId', required: true, schema: { type: 'string' } }],
    requestBody: {
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              startDate: { type: 'string', format: 'date-time' },
              endDate: { type: 'string', format: 'date-time', nullable: true },
              currency: { type: 'string' },
              defaultCountry: { type: 'string' },
              description: { type: 'string', nullable: true },
              prefixes: {
                type: 'array',
                description: 'When present, REPLACES the deck. Each { prefix, connectMicros, perMinuteMicros, label? }.',
                items: { type: 'object' },
              },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated tariff (with prefixes)' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      409: { description: 'Immutable once referenced / overlaps another tariff' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const del = async (req, res) => {
    if (!requirePermission(res, 'tariff', 'delete')) return;
    const tariff = await findTariff(req, res);
    if (!tariff) return;
    if (await isTariffReferenced(tariff)) {
      return res.status(409).send({ message: 'Tariff is referenced by costed usage and cannot be deleted; supersede it instead.' });
    }
    await tariff.destroy(); // cascades prefixes
    return res.status(200).send();
  };
  del.apiDoc = {
    summary: 'Delete a destination tariff (super admin; blocked once referenced).',
    operationId: 'deleteTariff',
    tags: ['Tariffs'],
    parameters: [{ in: 'path', name: 'tariffId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Deleted' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      409: { description: 'Referenced by costed usage' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PUT: update, DELETE: del };
}
