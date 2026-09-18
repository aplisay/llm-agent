import { NumberReservation, Trunk, Organisation, RESERVATION_TTL_MS } from '../../lib/database.js';
import { requirePermission } from '../../lib/auth/permissions.js';
import { validateE164, normalizeE164 } from '../../lib/validation.js';

/**
 * /api/number-reservations — mint the ticket a claim onto a CHARGEABLE trunk
 * must present.
 *
 * Chargeable trunks are the platform's own carrier trunks: every number on
 * one was bought from a carrier and every minute on it is paid for. The seam
 * that does that buying holds a key with `phoneEndpoint:reserve`; it reserves
 * here first, then the organisation's own key claims the number with the
 * returned id as `reservationRef`. The claim checks the ticket names the same
 * number, trunk and organisation, has not expired and has not been used, and
 * consumes it in the same transaction that creates the number. Nothing here
 * touches the carrier; it records that something which did has said yes.
 */
export default function (logger) {
  const createReservation = async (req, res) => {
    if (!requirePermission(res, 'phoneEndpoint', 'reserve')) return;
    const { number, trunkId, organisationId, provider, carrierRef } = req.body || {};

    if (!validateE164(number)) {
      return res.status(400).send({ error: 'number must be a valid E.164 phone number' });
    }
    if (typeof trunkId !== 'string' || !trunkId.trim()) {
      return res.status(400).send({ error: 'trunkId is required' });
    }
    if (typeof organisationId !== 'string' || !/^[0-9a-f-]{36}$/i.test(organisationId)) {
      return res.status(400).send({ error: 'organisationId must be an organisation id' });
    }
    if (carrierRef !== undefined && carrierRef !== null && typeof carrierRef !== 'object') {
      return res.status(400).send({ error: 'carrierRef must be an object' });
    }

    try {
      const trunk = await Trunk.findByPk(trunkId, { attributes: ['id', 'chargeable'] });
      if (!trunk) {
        return res.status(400).send({ error: 'Trunk not found' });
      }
      if (!trunk.chargeable) {
        // A reservation only means something where the platform pays; a
        // customer's own trunk needs no ticket and would never check one.
        return res.status(400).send({ error: 'Reservations apply only to chargeable trunks' });
      }
      const org = await Organisation.findByPk(organisationId, { attributes: ['id'] });
      if (!org) {
        return res.status(404).send({ error: 'Organisation not found' });
      }

      const reservation = await NumberReservation.create({
        number: normalizeE164(number),
        trunkId: trunk.id,
        organisationId: org.id,
        provider: typeof provider === 'string' && provider.trim() ? provider.trim() : null,
        carrierRef: carrierRef ?? null,
        expiresAt: new Date(Date.now() + RESERVATION_TTL_MS),
        createdBy: res.locals.user?.id ?? null,
      });
      return res.status(201).send({
        id: reservation.id,
        number: reservation.number,
        trunkId: reservation.trunkId,
        organisationId: reservation.organisationId,
        expiresAt: reservation.expiresAt.toISOString(),
      });
    } catch (err) {
      req.log?.error(err, 'creating number reservation');
      return res.status(500).send({ error: 'Internal server error' });
    }
  };

  createReservation.apiDoc = {
    summary: 'Reserve a number on a chargeable trunk ahead of the organisation claiming it.',
    description: `Mints a short-lived reservation that a subsequent
                  \`POST /phone-endpoints\` (type e164-ddi) onto a **chargeable** trunk must
                  present as \`reservationRef\`. The reservation is bound to one number, one trunk
                  and one organisation, expires after a few minutes, and is consumed by the claim
                  that uses it. Requires \`phoneEndpoint:reserve\`, held by the platform's
                  number-purchase seam and superAdmin; ordinary organisation roles cannot mint one.`,
    operationId: 'createNumberReservation',
    tags: ['Phone Endpoints'],
    requestBody: {
      required: true,
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['number', 'trunkId', 'organisationId'],
            properties: {
              number: { type: 'string', description: 'E.164 phone number (with or without +)', pattern: '^\\+?[1-9]\\d{6,14}$' },
              trunkId: { type: 'string', description: 'The chargeable trunk the number will be claimed onto' },
              organisationId: { type: 'string', format: 'uuid', description: 'The organisation that will claim it' },
              provider: { type: 'string', nullable: true, description: 'The numbering provider the number was reserved with' },
              carrierRef: { type: 'object', nullable: true, additionalProperties: true, description: 'Whatever the carrier returned for the allocation; stored verbatim for audit' },
            },
          },
        },
      },
    },
    responses: {
      201: {
        description: 'The reservation',
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['id', 'number', 'trunkId', 'organisationId', 'expiresAt'],
              properties: {
                id: { type: 'string', format: 'uuid', description: 'Pass as reservationRef when claiming the number' },
                number: { type: 'string', description: 'Normalised number (without +)' },
                trunkId: { type: 'string' },
                organisationId: { type: 'string', format: 'uuid' },
                expiresAt: { type: 'string', format: 'date-time' },
              },
            },
          },
        },
      },
      default: {
        description: 'An error occurred',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  };

  return { POST: createReservation };
}
