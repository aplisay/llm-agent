import { Model, DataTypes } from 'sequelize';

class OutboundEvent extends Model {}

/**
 * One decision of an organisation's outbound policy (lib/outbound-policy.js):
 * an outside call it allowed, or one it refused and why. The calls a minute
 * limit counts the allowed rows. An allowed row holds a place in the calls in
 * progress until its call has a row, or until call control says the leg was
 * not answered (`releasedAt`, `releasedBy` the event's id).
 *
 * The first refusal by a limit on a day carries `noticeDay`, which is unique
 * for the organisation, so one row holds the day's notice whatever the number
 * of servers. `noticeRetryAt` is when its send may be tried again, null once
 * it was sent.
 */
export function initOutboundEvent(sequelize, types = DataTypes) {
  OutboundEvent.init({
    id: { type: types.UUID, primaryKey: true, defaultValue: types.UUIDV4 },
    organisationId: {
      type: types.STRING,
      allowNull: false,
      references: { model: 'organisations', key: 'id' },
      onDelete: 'CASCADE',
    },
    at: { type: types.DATE, allowNull: false },
    allowed: { type: types.BOOLEAN, allowNull: false },
    code: { type: types.STRING(48), allowNull: false },
    destinationClass: { type: types.STRING(24), allowNull: true },
    destination: { type: types.STRING(32), allowNull: true },
    trunkId: { type: types.STRING, allowNull: true },
    releasedAt: { type: types.DATE, allowNull: true },
    releasedBy: { type: types.UUID, allowNull: true },
    noticeDay: { type: types.DATEONLY, allowNull: true },
    noticeAttempts: { type: types.INTEGER, allowNull: false, defaultValue: 0 },
    noticeRetryAt: { type: types.DATE, allowNull: true },
  }, {
    sequelize,
    timestamps: true,
    updatedAt: false,
    underscored: true,
    modelName: 'OutboundEvent',
    tableName: 'outbound_events',
    indexes: [
      { name: 'outbound_events_organisation_at', fields: ['organisation_id', 'at'] },
      { name: 'outbound_events_notice_day', unique: true, fields: ['organisation_id', 'notice_day'] },
      { name: 'outbound_events_released_by', unique: true, fields: ['released_by'] },
    ],
  });
  return OutboundEvent;
}

export { OutboundEvent };
