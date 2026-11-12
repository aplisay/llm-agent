import { Model, DataTypes, Op } from 'sequelize';

export const EXTENSION_TYPES = ['connection', 'ring_all', 'hunt', 'queue', 'agent', 'forward'];
const EMERGENCY_PREFIXES = ['999', '112', '911'];

/** True when the digits are, or begin with, an emergency number. */
export function isReservedExtensionNumber(number) {
  return EMERGENCY_PREFIXES.some((prefix) => String(number).startsWith(prefix));
}

class Extension extends Model {}

/**
 * An extension number in an organisation's dial plan. Soft-deleted
 * (`deletedAt`): every read must filter on it. "Owned" is never stored: the
 * owner is the entry named by `entryId` when that entry is a person.
 */
export function initExtension(sequelize, types = DataTypes) {
  Extension.init({
    id: { type: types.UUID, primaryKey: true, defaultValue: types.UUIDV4 },
    organisationId: {
      type: types.STRING,
      allowNull: false,
      references: { model: 'organisations', key: 'id' },
      onDelete: 'CASCADE'
    },
    // Null only for type `agent`.
    entryId: {
      type: types.UUID,
      allowNull: true,
      references: { model: 'directory_entries', key: 'id' },
      onDelete: 'RESTRICT'
    },
    number: {
      type: types.STRING(8),
      allowNull: false,
      validate: { is: /^[0-9]{1,8}$/ }
    },
    type: {
      type: types.STRING(16),
      allowNull: false,
      validate: { isIn: [EXTENSION_TYPES] }
    },
    // Type `connection`. Null means the connection the call is on.
    connectionId: {
      type: types.UUID,
      allowNull: true,
      references: { model: 'phone_registrations', key: 'id' },
      onDelete: 'SET NULL'
    },
    instanceId: {
      type: types.UUID,
      allowNull: true,
      references: { model: 'instances', key: 'id' },
      onDelete: 'SET NULL'
    },
    forwardTo: { type: types.STRING(16), allowNull: true },
    // Settings by type. Checked by validateExtensionParams (lib/pbx/extension-params.js).
    params: { type: types.JSONB, allowNull: false, defaultValue: {} },
    outboundNumber: { type: types.STRING(16), allowNull: true },
    presenceUser: { type: types.STRING(64), allowNull: true },
    createdBy: { type: types.STRING, allowNull: true },
    deletedAt: { type: types.DATE, allowNull: true }
  }, {
    sequelize,
    timestamps: true,
    underscored: true,
    modelName: 'Extension',
    tableName: 'extensions',
    validate: {
      shape() {
        if ((this.type === 'agent') !== (this.entryId == null)) {
          throw new Error("Only an extension of type 'agent' has no entry");
        }
        if (this.type === 'forward' && !this.forwardTo) {
          throw new Error("An extension of type 'forward' needs forwardTo");
        }
        if (this.connectionId && this.type !== 'connection') {
          throw new Error("connectionId is only for an extension of type 'connection'");
        }
        // A `connection` extension is dialled on the customer's own system, so its digits are not checked.
        if (this.type !== 'connection' && isReservedExtensionNumber(this.number)) {
          throw new Error('An extension number cannot be or begin with 999, 112 or 911');
        }
      }
    },
    indexes: [
      { name: 'extensions_org_number', unique: true, fields: ['organisation_id', 'number'], where: { deleted_at: null } },
      {
        name: 'extensions_entry',
        unique: true,
        fields: ['entry_id'],
        where: { deleted_at: null, entry_id: { [Op.ne]: null } }
      },
      { name: 'extensions_org_type', fields: ['organisation_id', 'type'], where: { deleted_at: null } },
      {
        name: 'extensions_presence_user',
        unique: true,
        fields: ['presence_user'],
        where: { presence_user: { [Op.ne]: null } }
      }
    ]
  });
  return Extension;
}

export { Extension };
