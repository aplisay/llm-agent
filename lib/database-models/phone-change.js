import { Model, DataTypes } from 'sequelize';

export const PHONE_CHANGE_ACTOR_KINDS = ['user', 'builder', 'import', 'crawl', 'system'];
export const PHONE_CHANGE_RESYNC = ['now', 'after_call', 'none'];

class PhoneChange extends Model {}

/** Why a phone's keys changed: the cause, and the keys before and after. */
export function initPhoneChange(sequelize, types = DataTypes) {
  PhoneChange.init({
    id: { type: types.UUID, primaryKey: true, defaultValue: types.UUIDV4 },
    organisationId: {
      type: types.STRING,
      allowNull: false,
      references: { model: 'organisations', key: 'id' },
      onDelete: 'CASCADE'
    },
    phoneId: {
      type: types.UUID,
      allowNull: false,
      references: { model: 'phones', key: 'id' },
      onDelete: 'CASCADE'
    },
    // One API write. Ties the rows of every phone it touched together.
    requestId: { type: types.UUID, allowNull: false },
    cause: { type: types.JSONB, allowNull: false },
    before: { type: types.JSONB, allowNull: false },
    after: { type: types.JSONB, allowNull: false },
    actorKind: { type: types.STRING(16), allowNull: false, validate: { isIn: [PHONE_CHANGE_ACTOR_KINDS] } },
    actorUserId: { type: types.STRING, allowNull: true },
    resync: { type: types.STRING(16), allowNull: false, validate: { isIn: [PHONE_CHANGE_RESYNC] } }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'PhoneChange',
    tableName: 'phone_changes',
    indexes: [
      { name: 'phone_changes_phone_created', fields: ['phone_id', { name: 'created_at', order: 'DESC' }] }
    ]
  });
  return PhoneChange;
}

export { PhoneChange };
