import { Model, DataTypes } from 'sequelize';

class OutboundEvent extends Model {}

/**
 * One decision of an organisation's outbound policy (lib/outbound-policy.js):
 * an outside call it allowed, or one it refused and why. The calls a minute
 * limit counts the allowed rows. The first refusal by a limit on a day carries
 * `noticeDay`, which is unique for the organisation, so exactly one notice is
 * sent a day whatever the number of servers.
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
    noticeDay: { type: types.DATEONLY, allowNull: true },
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
    ],
  });
  return OutboundEvent;
}

export { OutboundEvent };
