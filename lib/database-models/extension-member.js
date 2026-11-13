import { Model, DataTypes, Op } from 'sequelize';

class ExtensionMember extends Model {}

/**
 * A person who belongs to an extension. The owner of an owned extension always
 * has a row, with a null `keyPosition`. `huntPosition` orders people within an
 * extension. `keyPosition` orders shared extensions on one person's phones.
 */
export function initExtensionMember(sequelize, types = DataTypes) {
  ExtensionMember.init({
    id: { type: types.UUID, primaryKey: true, defaultValue: types.UUIDV4 },
    organisationId: {
      type: types.STRING,
      allowNull: false,
      references: { model: 'organisations', key: 'id' },
      onDelete: 'CASCADE'
    },
    extensionId: {
      type: types.UUID,
      allowNull: false,
      references: { model: 'extensions', key: 'id' },
      onDelete: 'CASCADE'
    },
    entryId: {
      type: types.UUID,
      allowNull: false,
      references: { model: 'directory_entries', key: 'id' },
      onDelete: 'CASCADE'
    },
    huntPosition: { type: types.INTEGER, allowNull: false },
    keyPosition: { type: types.INTEGER, allowNull: true }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'ExtensionMember',
    tableName: 'extension_members',
    indexes: [
      { name: 'extension_members_ext_entry', unique: true, fields: ['extension_id', 'entry_id'] },
      { name: 'extension_members_ext_hunt', unique: true, fields: ['extension_id', 'hunt_position'] },
      {
        name: 'extension_members_entry_key',
        unique: true,
        fields: ['entry_id', 'key_position'],
        where: { key_position: { [Op.ne]: null } }
      }
    ]
  });
  return ExtensionMember;
}

export { ExtensionMember };
