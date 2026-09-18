import { Model, DataTypes } from 'sequelize';

/**
 * A short-lived ticket that says "the platform's carrier seam has agreed this
 * number may be claimed onto this chargeable trunk by this organisation".
 *
 * Numbers on chargeable trunks cost the platform money: the carrier bills for
 * the allocation and for every minute that lands on it. Until now the only
 * gate on `POST /phone-endpoints` for such a trunk was the organisation's
 * number limit, so anything holding an ordinary org key could claim a
 * carrier number that nobody had bought — a row the platform pays for, or a
 * number the carrier never routed. A reservation closes that: the seam that
 * actually talks to the carrier (holding a key with `phoneEndpoint:reserve`)
 * mints one first, and the claim must present it. The claim consumes the
 * reservation inside its own transaction, so a ticket is good for exactly one
 * number, on one trunk, for one organisation, once, and only for a few
 * minutes.
 *
 * `carrierRef` is whatever the carrier gave back for the allocation, kept
 * verbatim for audit; the platform does not interpret it.
 */
class NumberReservation extends Model {}

/** How long a fresh reservation stays claimable. Long enough to cover the carrier round trip, short enough that a stale ticket cannot be replayed later. */
export const RESERVATION_TTL_MS = 15 * 60 * 1000;

export function initNumberReservation(sequelize, types = DataTypes) {
  NumberReservation.init({
    id: {
      type: types.UUID,
      defaultValue: types.UUIDV4,
      primaryKey: true
    },
    // Normalised E.164 without the leading +, the same shape as phone_numbers.number.
    number: {
      type: types.STRING,
      allowNull: false
    },
    trunkId: {
      type: types.STRING,
      allowNull: false
    },
    organisationId: {
      type: types.UUID,
      allowNull: false
    },
    // The numbering provider the seam reserved with, when it says.
    provider: {
      type: types.STRING,
      allowNull: true
    },
    carrierRef: {
      type: types.JSONB,
      allowNull: true
    },
    expiresAt: {
      type: types.DATE,
      allowNull: false
    },
    // Set, once, by the claim that used it. A consumed or expired reservation
    // is refused; nothing is ever deleted, so the audit trail stays whole.
    consumedAt: {
      type: types.DATE,
      allowNull: true
    },
    phoneNumberId: {
      type: types.UUID,
      allowNull: true
    },
    createdBy: {
      type: types.STRING,
      allowNull: true
    }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'NumberReservation',
    tableName: 'number_reservations',
    indexes: [
      { name: 'number_reservations_number_trunk', fields: ['number', 'trunk_id'] },
      { name: 'number_reservations_organisation', fields: ['organisation_id'] }
    ]
  });

  return NumberReservation;
}

export { NumberReservation };
