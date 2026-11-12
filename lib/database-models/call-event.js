import { Model, DataTypes } from 'sequelize';

class CallEvent extends Model {}

/**
 * Something that happened on a phone-system call and is not a call row of its
 * own: a phone that rang and was not answered, a hold, a leg that was skipped.
 * The writer supplies `id`, so a retried write is ignored.
 */
export function initCallEvent(sequelize, types = DataTypes) {
  CallEvent.init({
    id: { type: types.UUID, primaryKey: true, defaultValue: types.UUIDV4 },
    organisationId: {
      type: types.STRING,
      allowNull: false,
      references: { model: 'organisations', key: 'id' },
      onDelete: 'CASCADE'
    },
    callId: {
      type: types.UUID,
      allowNull: false,
      references: { model: 'calls', key: 'id' },
      onDelete: 'CASCADE'
    },
    type: { type: types.STRING(32), allowNull: false },
    at: { type: types.DATE, allowNull: false },
    data: { type: types.JSONB, allowNull: false, defaultValue: {} }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'CallEvent',
    tableName: 'call_events',
    indexes: [{ name: 'call_events_call_at', fields: ['call_id', 'at'] }]
  });
  return CallEvent;
}

export { CallEvent };
