import { Model, DataTypes, Op } from 'sequelize';

export const DIRECTORY_ENTRY_KINDS = ['person', 'team', 'service'];

class DirectoryEntry extends Model {}

/**
 * A person, team or service in an organisation's directory. Rows are
 * soft-deleted (`deletedAt`): every read must filter on it.
 */
export function initDirectoryEntry(sequelize, types = DataTypes) {
  DirectoryEntry.init({
    id: { type: types.UUID, primaryKey: true, defaultValue: types.UUIDV4 },
    organisationId: {
      type: types.STRING,
      allowNull: false,
      references: { model: 'organisations', key: 'id' },
      onDelete: 'CASCADE'
    },
    kind: {
      type: types.STRING(16),
      allowNull: false,
      defaultValue: 'person',
      validate: { isIn: [DIRECTORY_ENTRY_KINDS] }
    },
    name: { type: types.STRING(120), allowNull: false },
    role: { type: types.STRING(120), allowNull: true },
    department: { type: types.STRING(80), allowNull: true },
    about: { type: types.STRING(600), allowNull: true },
    email: { type: types.STRING(254), allowNull: true },
    // Free text for agents. Not an extension's opening hours.
    hours: { type: types.STRING(200), allowNull: true },
    notesForAgent: { type: types.STRING(1000), allowNull: true },
    discloseNumbers: { type: types.BOOLEAN, allowNull: false, defaultValue: false },
    direct: { type: types.STRING(16), allowNull: true },
    // A contact field only. It rings only when a phone of kind `external` is made from it.
    mobile: { type: types.STRING(16), allowNull: true },
    loginUserId: {
      type: types.STRING,
      allowNull: true,
      references: { model: 'users', key: 'id' },
      onDelete: 'SET NULL'
    },
    // Kept for the client. The server stores it and never reads it.
    notes: { type: types.JSONB, allowNull: false, defaultValue: {} },
    createdBy: { type: types.STRING, allowNull: true },
    deletedAt: { type: types.DATE, allowNull: true }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'DirectoryEntry',
    tableName: 'directory_entries',
    validate: {
      personDisclosure() {
        if (this.discloseNumbers && this.kind === 'person') {
          throw new Error('A person cannot disclose numbers');
        }
      },
      loginPersonOnly() {
        if (this.loginUserId && this.kind !== 'person') {
          throw new Error('Only a person can be linked to a login');
        }
      }
    },
    indexes: [
      { name: 'directory_entries_org', fields: ['organisation_id'], where: { deleted_at: null } },
      {
        name: 'directory_entries_org_login',
        unique: true,
        fields: ['organisation_id', 'login_user_id'],
        where: { deleted_at: null, login_user_id: { [Op.ne]: null } }
      }
    ]
  });
  return DirectoryEntry;
}

export { DirectoryEntry };
