import { Model, DataTypes, Op } from 'sequelize';

export const PHONE_KINDS = ['deskphone', 'external', 'browser', 'softphone'];
export const PHONE_SHOWS = ['caller', 'extension'];

class Phone extends Model {}

/** The thing that rings: a desk phone, or an outside number such as a mobile (`external`). */
export function initPhone(sequelize, types = DataTypes) {
  Phone.init({
    id: { type: types.UUID, primaryKey: true, defaultValue: types.UUIDV4 },
    organisationId: {
      type: types.STRING,
      allowNull: false,
      references: { model: 'organisations', key: 'id' },
      onDelete: 'CASCADE'
    },
    deviceId: {
      type: types.UUID,
      allowNull: true,
      references: { model: 'devices', key: 'id' },
      onDelete: 'RESTRICT'
    },
    label: { type: types.STRING(60), allowNull: false },
    kind: { type: types.STRING(16), allowNull: false, validate: { isIn: [PHONE_KINDS] } },
    // The four below are for kind `external` only.
    number: { type: types.STRING(16), allowNull: true },
    ringDelay: { type: types.INTEGER, allowNull: true, validate: { min: 0, max: 60 } },
    shows: { type: types.STRING(16), allowNull: true, validate: { isIn: [PHONE_SHOWS] } },
    keyToAnswer: { type: types.BOOLEAN, allowNull: true },
    addedBy: { type: types.STRING, allowNull: true },
    removedAt: { type: types.DATE, allowNull: true }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'Phone',
    tableName: 'phones',
    indexes: [
      { name: 'phones_org', fields: ['organisation_id'], where: { removed_at: null } },
      {
        name: 'phones_device',
        unique: true,
        fields: ['device_id'],
        where: { removed_at: null, device_id: { [Op.ne]: null } }
      },
      {
        name: 'phones_org_number',
        unique: true,
        fields: ['organisation_id', 'number'],
        where: { kind: 'external', removed_at: null }
      }
    ]
  });
  return Phone;
}

export { Phone };
