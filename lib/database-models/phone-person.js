import { Model, DataTypes } from 'sequelize';

class PhonePerson extends Model {}

/** A person a phone rings for. Position 1 is the first user of the phone. */
export function initPhonePerson(sequelize, types = DataTypes) {
  PhonePerson.init({
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
    entryId: {
      type: types.UUID,
      allowNull: false,
      references: { model: 'directory_entries', key: 'id' },
      onDelete: 'CASCADE'
    },
    position: { type: types.INTEGER, allowNull: false }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'PhonePerson',
    tableName: 'phone_people',
    indexes: [
      { name: 'phone_people_phone_entry', unique: true, fields: ['phone_id', 'entry_id'] },
      { name: 'phone_people_phone_position', unique: true, fields: ['phone_id', 'position'] },
      { name: 'phone_people_entry', fields: ['entry_id'] }
    ]
  });
  return PhonePerson;
}

export { PhonePerson };
