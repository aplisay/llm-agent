import { RateCard, UsageRecord } from '../../../lib/database.js';
import { requirePermission } from '../../../lib/auth/permissions.js';
import { validateRateLines } from '../../../lib/rates.js';

/**
 * /api/rates/{rateId} (item) — superAdmin (`rate` resource).
 *   GET    fetch one card.
 *   PATCH  edit a card. The model's beforeUpdate guard rejects pricing edits once
 *          the card is referenced by costed usage (supersede instead) -> 409.
 *   DELETE remove a card — blocked (409) once referenced, to preserve the frozen
 *          cost audit (usage rows carry rateName + rateCardStart).
 */
export default function (logger) {
  const findCard = async (req, res) => {
    const card = await RateCard.findByPk(req.params.rateId);
    if (!card) {
      res.status(404).send({ message: `Rate card ${req.params.rateId} not found` });
      return null;
    }
    return card;
  };

  const isReferenced = (card) => UsageRecord.findOne({
    where: { rateName: card.name, rateCardStart: card.startDate }, attributes: ['id'],
  });

  const get = async (req, res) => {
    if (!requirePermission(res, 'rate', 'read')) return;
    const card = await findCard(req, res);
    if (card) res.send(card);
  };
  get.apiDoc = {
    summary: 'Get a rate card (super admin).',
    operationId: 'getRate',
    tags: ['Rates'],
    parameters: [{ in: 'path', name: 'rateId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Rate card' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const update = async (req, res) => {
    if (!requirePermission(res, 'rate', 'update')) return;
    const card = await findCard(req, res);
    if (!card) return;
    if ('detail' in req.body) {
      const lineErr = validateRateLines(req.body.detail);
      if (lineErr) return res.status(400).send({ message: lineErr });
    }
    const EDITABLE = ['name', 'startDate', 'endDate', 'currency', 'detail', 'description'];
    for (const k of EDITABLE) if (k in req.body) card[k] = req.body[k];
    try {
      await card.save();
      return res.send(card);
    } catch (err) {
      // beforeUpdate immutability guard (referenced) -> 409.
      if (/immutable once referenced/.test(err?.message || '')) {
        return res.status(409).send({ message: err.message });
      }
      if (err?.name === 'SequelizeExclusionConstraintError' || err?.name === 'SequelizeUniqueConstraintError') {
        return res.status(409).send({ message: 'That change overlaps another card for this name.' });
      }
      req.log.error(err, 'updating rate card');
      return res.status(400).send({ message: err?.message || 'Failed to update rate card' });
    }
  };
  update.apiDoc = {
    summary: 'Update a rate card (super admin; immutable once referenced).',
    operationId: 'updateRate',
    tags: ['Rates'],
    parameters: [{ in: 'path', name: 'rateId', required: true, schema: { type: 'string' } }],
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
              detail: { type: 'object' },
              description: { type: 'string', nullable: true },
            },
          },
        },
      },
    },
    responses: {
      200: { description: 'Updated rate card' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      409: { description: 'Immutable once referenced / overlaps another card' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  const del = async (req, res) => {
    if (!requirePermission(res, 'rate', 'delete')) return;
    const card = await findCard(req, res);
    if (!card) return;
    if (await isReferenced(card)) {
      return res.status(409).send({ message: 'Rate card is referenced by costed usage and cannot be deleted; supersede it instead.' });
    }
    await card.destroy();
    return res.status(200).send();
  };
  del.apiDoc = {
    summary: 'Delete a rate card (super admin; blocked once referenced).',
    operationId: 'deleteRate',
    tags: ['Rates'],
    parameters: [{ in: 'path', name: 'rateId', required: true, schema: { type: 'string' } }],
    responses: {
      200: { description: 'Deleted' },
      404: { description: 'Not found', content: { 'application/json': { schema: { $ref: '#/components/schemas/NotFound' } } } },
      409: { description: 'Referenced by costed usage' },
      default: { description: 'An error occurred', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    },
  };

  return { GET: get, PATCH: update, DELETE: del };
}
